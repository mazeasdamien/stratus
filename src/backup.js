/**
 * Nightly snapshot of D1 into R2.
 *
 * Scope is deliberate: the *index*, not the mail. Message bodies already live
 * in R2 and copying them would double the storage to protect against a failure
 * that cannot happen — losing D1 does not touch the bucket. What a lost
 * database actually costs is the index, the folder cursors, the sealed
 * credential and the read/star state, and all of that is small.
 *
 * A snapshot is a folder: backup/<stamp>/<table>-<n>.json, a few thousand
 * rows each, and backup/<stamp>/manifest.json naming them. It was one JSON
 * file holding every table, built as one string, and a Worker has 128 MB: a
 * large mailbox could not be snapshotted at all. Now no more than one part is
 * ever held.
 *
 * The manifest is written last, and a snapshot without one does not exist.
 * One snapshot is kept: older ones are pruned only after the new manifest is
 * in place, so there is never a moment with no valid snapshot, and a run that
 * dies part-way leaves the previous one exactly as it was.
 */

import { moduleTables } from "./modules.js";

const TABLES = [
  "accounts", "messages", "settings", "blocked_senders", "outbox", "snoozed",
  "contacts_hidden", "contacts_added", "push_subs",
  // Left out until now. Without revoked_sessions a restore brought every
  // signed-out device back in; without image_senders and events it lost the
  // senders you trust with images and the meetings on the timeline, which is
  // only ever rebuilt once.
  "image_senders", "revoked_sessions", "events",
];

// The core tables, then whatever the modules own (src/modules.js). Read on
// each run, never cached, so there is one list for the snapshot and the restore.
const tablesToKeep = () => [...new Set([...TABLES, ...moduleTables()])];

// Rebuildable from the messages themselves, and by far the largest table.
// Restoring re-indexes rather than reloading it: the search backfill picks
// up every message the index has not seen.
const SKIP = ["search"];

// Read in pages, so a big mailbox is never one result set held whole.
const PAGE = 1000;

// Rows per file. What bounds the memory a snapshot needs, taking or
// restoring it, whatever the size of the mailbox.
const PART_ROWS = 2000;

const PREFIX = "backup/";
const MANIFEST = /^backup\/([^/]+)\/manifest\.json$/;
// The single file a snapshot used to be. Still read, never written.
const LEGACY = /^backup\/dmzs-mail-([^/]+)\.json$/;

const JSON_META = { httpMetadata: { contentType: "application/json" } };
const utf8Length = (s) => new TextEncoder().encode(s).length;

/** Everything under backup/. R2 lists at most 1000 keys a call. */
async function listBackups(env, include) {
  const out = [];
  let cursor;
  do {
    const page = await env.MAIL.list({ prefix: PREFIX, cursor, ...(include ? { include } : {}) });
    out.push(...(page.objects || []));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

/** R2 deletes at most 1000 keys a call. */
async function deleteKeys(env, keys) {
  for (let i = 0; i < keys.length; i += 1000) await env.MAIL.delete(keys.slice(i, i + 1000));
}

export async function runBackup(env, now) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const dir = `${PREFIX}${stamp}/`;
  const key = `${dir}manifest.json`;

  const counts = {};
  const parts = [];
  let bytes = 0;
  try {
    for (const table of tablesToKeep()) {
      counts[table] = 0;
      let held = [];
      let n = 0;
      // Written as it fills, then let go: the next page starts from empty.
      const flush = async () => {
        if (!held.length) return;
        const part = `${dir}${table}-${n++}.json`;
        const body = JSON.stringify(held);
        await env.MAIL.put(part, body, JSON_META);
        const size = utf8Length(body);
        parts.push({ key: part, table, rows: held.length, bytes: size });
        counts[table] += held.length;
        bytes += size;
        held = [];
      };
      try {
        for (let after = 0; ; ) {
          const { results } = await env.DB.prepare(
            `SELECT rowid AS _r, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ${PAGE}`
          )
            .bind(after)
            .all();
          for (const r of results ?? []) {
            after = r._r;
            delete r._r;
            held.push(r);
          }
          if (held.length >= PART_ROWS) await flush();
          if ((results ?? []).length < PAGE) break;
        }
        await flush();
      } catch (e) {
        // A table that does not exist yet is not a failure; the schema grows.
        // Anything else is: this used to swallow every error, so one failed
        // read halfway through `messages` wrote a snapshot holding part of the
        // mailbox, called it good, and then deleted the last complete one.
        if (!/no such table/i.test(String((e && e.message) || e))) throw e;
      }
    }

    // Last, and only once every part is in place: this is what makes the
    // parts a snapshot.
    const manifest = JSON.stringify({
      version: 2,
      takenAt: new Date(now).toISOString(),
      counts,
      skipped: SKIP,
      parts,
    });
    await env.MAIL.put(key, manifest, {
      ...JSON_META,
      customMetadata: { messages: String(counts.messages ?? 0) },
    });
    bytes += utf8Length(manifest);
  } catch (e) {
    // Parts with no manifest are not a snapshot and nothing will read them.
    // Removed if that is still possible; the next good run prunes them too.
    await deleteKeys(env, parts.map((p) => p.key)).catch(() => {});
    throw e;
  }

  // Prune only after the new one is safely written: older snapshots, the
  // single file of before, and parts left by a run that never finished.
  const old = (await listBackups(env)).map((o) => o.key).filter((k) => !k.startsWith(dir));
  await deleteKeys(env, old);

  return { key, bytes, counts, parts: parts.length, removed: old.length };
}

/**
 * The newest snapshot held and what it is made of, or null.
 *
 * Only a manifest, or a single file from before, counts. Parts under a stamp
 * that has no manifest belong to a run that did not finish.
 */
async function newestSnapshot(env) {
  // customMetadata only comes back from a listing that asks for it.
  const objects = await listBackups(env, ["customMetadata"]);
  const found = [];
  for (const o of objects) {
    const m = MANIFEST.exec(o.key) || LEGACY.exec(o.key);
    if (m) found.push({ stamp: m[1], head: o, legacy: !MANIFEST.test(o.key) });
  }
  if (!found.length) return null;
  found.sort((a, b) => (a.stamp < b.stamp ? 1 : -1));
  const top = found[0];
  const dir = `${PREFIX}${top.stamp}/`;
  return {
    ...top,
    kept: found.length,
    files: top.legacy ? [top.head] : objects.filter((o) => o.key.startsWith(dir)),
  };
}

/** The snapshot currently held, if any. */
export async function latestBackup(env) {
  const snap = await newestSnapshot(env);
  if (!snap) return null;
  return {
    key: snap.head.key,
    // The whole snapshot, not the manifest alone.
    bytes: snap.files.reduce((n, o) => n + (o.size || 0), 0),
    uploaded: snap.head.uploaded,
    messages: Number(snap.head.customMetadata?.messages || 0),
    kept: snap.kept,
  };
}

/** Puts rows of one table back, leaving alone every row that exists. */
async function restoreRows(env, table, rows) {
  if (!rows.length) return 0;
  const cols = Object.keys(rows[0]);
  // D1 binds at most 100 parameters per statement.
  const perStmt = Math.max(1, Math.floor(100 / cols.length));
  const stmts = [];
  for (let i = 0; i < rows.length; i += perStmt) {
    const chunk = rows.slice(i, i + perStmt);
    const tuple = `(${cols.map(() => "?").join(",")})`;
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO ${table} (${cols.join(",")}) VALUES ${chunk.map(() => tuple).join(",")}`
      ).bind(...chunk.flatMap((r) => cols.map((c) => r[c] ?? null)))
    );
  }
  let changed = 0;
  for (let i = 0; i < stmts.length; i += 100) {
    const out = await env.DB.batch(stmts.slice(i, i + 100));
    for (const r of out) changed += r.meta?.changes || 0;
  }
  return changed;
}

/**
 * Puts the latest snapshot back, without taking anything away.
 *
 * INSERT OR IGNORE, table by table: a row that exists now is newer than the
 * snapshot and is left alone, and only what has gone missing comes back. So
 * restoring after a lost database rebuilds it, and restoring by mistake on a
 * healthy one changes nothing. The search index is not in the snapshot; the
 * backfill is woken so it re-indexes what came back.
 *
 * Read a part at a time, as it was written. A single file from before this
 * layout is still restored when it is the newest thing held.
 */
export async function restoreBackup(env) {
  const snap = await newestSnapshot(env);
  if (!snap) return { restored: {}, key: null };
  const obj = await env.MAIL.get(snap.head.key);
  if (!obj) return { restored: {}, key: null };
  const head = JSON.parse(await obj.text());

  const tables = tablesToKeep();
  const restored = Object.fromEntries(tables.map((t) => [t, 0]));
  if (snap.legacy) {
    for (const table of tables) restored[table] = await restoreRows(env, table, head.tables?.[table] || []);
  } else {
    // The table name goes into the statement, so it is one of ours or it is
    // not restored.
    const parts = (head.parts || []).filter((p) => tables.includes(p.table));
    // Checked before anything is written: half a restore, then an error, is
    // harder to reason about than an error.
    const held = new Set(snap.files.map((o) => o.key));
    const missing = parts.find((p) => !held.has(p.key));
    if (missing) throw new Error(`The snapshot is incomplete: ${missing.key} is missing`);
    for (const p of parts) {
      const part = await env.MAIL.get(p.key);
      if (!part) throw new Error(`The snapshot is incomplete: ${p.key} is missing`);
      restored[p.table] += await restoreRows(env, p.table, JSON.parse(await part.text()));
    }
  }
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'search_idle_%'").run();
  return { restored, key: snap.head.key, takenAt: head.takenAt };
}
