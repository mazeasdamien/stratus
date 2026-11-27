/**
 * Rules, the half that touches things: storing them, applying a plan to a
 * message, and running them over mail as it arrives or on demand. What a rule
 * can match and do is decided in src/rules.js.
 *
 *   GET    /api/rules                  every rule in order, with the fields and actions the editor offers
 *   POST   /api/rules                  add one at the end
 *   PATCH  /api/rules/:id              edit it, or just { enabled }
 *   DELETE /api/rules/:id
 *   POST   /api/rules/order { ids }    put them in this order
 *   POST   /api/rules/run { cursor? }  apply the enabled rules to one batch of the inbox
 *
 * Where each action lands. Moving, starring and marking read are made at
 * iCloud over IMAP, so every device agrees, and then recorded here. Categories
 * and pins live only here. The IMAP commands a rule issues, all by UID:
 *
 *   UID STORE <uid> +FLAGS (\Flagged)        star
 *   UID STORE <uid> +FLAGS (\Seen)           mark read
 *   UID MOVE  <uid> "<mailbox>"              move, and Trash (imapMove: COPY, \Deleted
 *                                            and a UID EXPUNGE of that one UID only on
 *                                            a server that has no MOVE)
 *
 * and, for "Run rules now" only, per message, UID SEARCH HEADER "Message-ID"
 * in the mailbox the row says it is in, because a stored UID can be stale.
 * A rule never removes mail: "delete" is the move to Trash.
 */

import { imapFlag, imapMove, imapOpen, imapList, imapSearch, imapSelect } from "./imap.js";
import { attachCategories } from "./categories.js";
import { folderNameFor, icloudPassword, resolveMailbox, theAccount } from "./mailbox.js";
import { ACTIONS, catalog, cleanRule, needsBody, planActions, readRule } from "./rules.js";
import { htmlToText } from "./mime.js";
import { bodyKey, FLAG_FLAGGED, FLAG_SEEN, hashHex, json } from "./util.js";

const BATCH = 20; // messages one "Run rules now" request looks at

export async function loadRules(env) {
  const { results } = await env.DB.prepare("SELECT * FROM rules ORDER BY position, id").all();
  return results ?? [];
}

/** The enabled rules this build can read: all that could ever act. */
const live = (rules) => rules.filter((r) => readRule(r)?.enabled);

/* ────────────────────────────────────────────────────────────────
   Applying a plan to one message.
   ──────────────────────────────────────────────────────────────── */

/** What a pass did, kept apart from the rules table until the pass is over. */
const newOutcome = () => ({ acted: new Map(), errors: new Map(), changed: 0, failed: 0 });

/**
 * Carries out `plan` on one message and records the result in `outcome`.
 *
 * `io` finds the message at iCloud: `uid(row)` gives its UID in the mailbox
 * that is selected on `io.im`, and `io.boxes` is that connection's mailbox list.
 *
 * Flags first, then the move, so what leaves the inbox carries its state with
 * it. The first iCloud step that fails ends the iCloud steps for this message:
 * it stays where it was, and the error goes on the rule that asked. Local
 * actions (a category, a pin) do not depend on iCloud and still happen. Never
 * throws: one message must not stop the others, nor the sync.
 */
async function perform(env, io, row, plan, outcome) {
  const done = new Set(); // rules that did something to this message
  const stmts = [];
  const owners = []; // [statement index, rule] for the local steps whose effect is counted
  const fail = (rule, e) => outcome.errors.set(rule, String((e && e.message) || e).slice(0, 200));

  const remote = plan.filter((a) => ACTIONS[a.type].via === "imap");
  remote.sort((a, b) => (a.type === "move" || a.type === "trash") - (b.type === "move" || b.type === "trash"));
  let failed = false;
  for (const a of remote) {
    try {
      const uid = await io.uid(row);
      if (a.type === "star") {
        await imapFlag(io.im, uid, FLAG_FLAGGED, true);
        stmts.push(env.DB.prepare("UPDATE messages SET starred=1 WHERE id=?").bind(row.id));
      } else if (a.type === "read") {
        await imapFlag(io.im, uid, FLAG_SEEN, true);
        stmts.push(env.DB.prepare("UPDATE messages SET unread=0 WHERE id=?").bind(row.id));
      } else {
        const dest = resolveMailbox(io.boxes, a.type === "trash" ? "trash" : a.value);
        if (!dest) throw new Error(`No mailbox matching "${a.type === "trash" ? "trash" : a.value}"`);
        await imapMove(io.im, uid, dest.name);
        // The destination's own name for it, which is what the sync will file it
        // under when it sees it there, so the two agree.
        stmts.push(env.DB.prepare("UPDATE messages SET folder=? WHERE id=?").bind(folderNameFor(dest), row.id));
      }
      done.add(a.rule);
    } catch (e) {
      failed = true;
      fail(a.rule, e);
    }
    if (failed) break;
  }

  for (const a of plan.filter((x) => ACTIONS[x.type].via === "local")) {
    owners.push([stmts.length, a.rule]);
    if (a.type === "category") {
      // Through the categories table, so an id that has since been deleted adds nothing.
      stmts.push(
        env.DB.prepare("INSERT OR IGNORE INTO message_categories (message_id, category_id) SELECT ?, id FROM categories WHERE id=?").bind(row.id, Number(a.value))
      );
    } else {
      // The conversation, as the pin route does: a pin on one message would
      // come off again when the next reply arrived.
      const scope = row.thread_key
        ? ["SELECT id FROM messages WHERE account_id=? AND thread_key=?", row.account_id, row.thread_key]
        : ["SELECT id FROM messages WHERE id=?", row.id];
      stmts.push(env.DB.prepare(`UPDATE messages SET pinned=1 WHERE pinned=0 AND id IN (${scope[0]})`).bind(...scope.slice(1)));
    }
  }
  if (stmts.length) {
    try {
      const res = await env.DB.batch(stmts);
      for (const [i, rule] of owners) if (res[i]?.meta?.changes > 0) done.add(rule);
    } catch (e) {
      for (const [, rule] of owners) fail(rule, e);
    }
  }

  for (const rule of done) outcome.acted.set(rule, (outcome.acted.get(rule) || 0) + 1);
  if (done.size) outcome.changed++;
  if (failed) outcome.failed++;
}

/** Writes a pass's counts and errors onto the rules. A rule that acted without trouble loses its old error. */
async function record(env, outcome) {
  const now = Date.now();
  const ids = new Set([...outcome.acted.keys(), ...outcome.errors.keys()]);
  if (!ids.size) return;
  await env.DB.batch(
    [...ids].map((id) =>
      env.DB.prepare("UPDATE rules SET n=n+?, last_at=CASE WHEN ?>0 THEN ? ELSE last_at END, last_error=? WHERE id=?").bind(
        outcome.acted.get(id) || 0,
        outcome.acted.get(id) || 0,
        now,
        outcome.errors.get(id) ?? null,
        id
      )
    )
  );
}

/* ────────────────────────────────────────────────────────────────
   Mail as it arrives.
   ──────────────────────────────────────────────────────────────── */

/**
 * The messages of a mailbox visit that are new to the inbox: past the UID the
 * cursor had reached, and with no row here yet. Asked before the rows are
 * stored, because afterwards every one has a row.
 *
 * Both tests matter. A UID past the cursor leaves out history the sync is
 * walking backwards through, and a first read of a mailbox. No row yet leaves
 * out mail the sync merely sees again: a message another device moved into the
 * inbox, a copy that shares its Message-ID with one already filed. That is
 * also what makes a rule fire once for a message: it has a row from then on.
 */
export async function arrivals(env, accountId, rows, since, texts) {
  if (!since) return [];
  const fresh = [];
  for (const row of rows) if (Number(row.uid) > since) fresh.push({ row, id: await hashHex(`msg|${accountId}|${row.pid}`, 16) });
  const known = new Set();
  for (let i = 0; i < fresh.length; i += 90) {
    const chunk = fresh.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT id FROM messages WHERE id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk.map((f) => f.id))
      .all();
    for (const r of results ?? []) known.add(r.id);
  }
  return fresh.filter((f) => !known.has(f.id)).map((f) => ({ ...f, text: texts.get(f.row.pid) || "" }));
}

/**
 * Applies the rules to mail `arrivals` found in the inbox, over the sync's
 * own connection with the inbox selected. Called after the rows are stored.
 * Nothing in here may fail the sync.
 */
export async function sortArrivals(env, account, im, boxes, found) {
  try {
    const rules = await loadRules(env);
    if (!live(rules).length) return;
    const io = { im, boxes, uid: async (row) => row.uid };
    const outcome = newOutcome();
    for (const { row, id, text } of found) {
      const message = { ...row, id, account_id: account.id, body: text, folder: "inbox", pinned: 0, cats: [] };
      const plan = planActions(rules, message);
      if (plan.length) await perform(env, io, message, plan, outcome);
    }
    await record(env, outcome);
  } catch (e) {
    console.log(`rules: ${(e && e.stack) || e}`);
  }
}

/* ────────────────────────────────────────────────────────────────
   Run rules now.
   ──────────────────────────────────────────────────────────────── */

/**
 * A connection opened the first time a message needs one, and finding each
 * message again by Message-ID. A stored UID can be stale (another device moved
 * the message, the mailbox was renumbered), so it is not trusted here.
 */
function providerIo(env, account) {
  const io = {
    im: null,
    boxes: [],
    opening: null,
    selected: "",
    async uid(row) {
      io.opening ??= (async () => {
        const pass = await icloudPassword(env, account);
        if (!pass) throw new Error("This account has no stored credential");
        io.im = await imapOpen({ user: account.email, pass });
        io.boxes = await imapList(io.im);
      })();
      await io.opening; // a failed open is the same failure for every message
      const mb = resolveMailbox(io.boxes, row.mailbox || row.folder);
      if (!mb) throw new Error(`No mailbox matching "${row.mailbox || row.folder}"`);
      if (io.selected !== mb.name) {
        await imapSelect(io.im, mb.name);
        io.selected = mb.name;
      }
      const needle = String(row.mid || row.pid).replace(/["\\\r\n]/g, "");
      const uids = await imapSearch(io.im, `HEADER "Message-ID" "${needle}"`);
      if (!uids.length) throw new Error("The message is not at iCloud any more");
      return uids[uids.length - 1];
    },
    async close() {
      if (io.im) await io.im.logout().catch(() => {});
    },
  };
  return io;
}

/** The message text a body condition reads, from the stored body. */
async function textOf(env, id) {
  try {
    const obj = await env.MAIL.get(bodyKey(id));
    return obj ? htmlToText(JSON.parse(await obj.text()).html || "") : "";
  } catch {
    return "";
  }
}

/**
 * One batch of "Run rules now": the next BATCH inbox messages after `cursor`
 * ({ date, id }, newest first), planned and applied. `next` is the cursor for
 * the following batch, null at the end of the inbox.
 *
 * Bounded so a large inbox cannot run one request out of time; the client asks
 * again until `next` is null. Mail the rules already handled plans nothing,
 * so running twice changes nothing the second time.
 */
export async function runBatch(env, cursor) {
  const rules = await loadRules(env);
  const account = await theAccount(env);
  const none = { scanned: 0, changed: 0, failed: 0, next: null };
  if (!account || !live(rules).length) return none;

  const at = cursor && Number.isFinite(Number(cursor.date)) && /^[a-f0-9]{16}$/.test(String(cursor.id || ""));
  const { results } = await env.DB.prepare(
    `SELECT * FROM messages WHERE account_id=? AND folder='inbox'
       ${at ? "AND (date < ? OR (date = ? AND id < ?))" : ""}
      ORDER BY date DESC, id DESC LIMIT ?`
  )
    .bind(account.id, ...(at ? [Number(cursor.date), Number(cursor.date), cursor.id] : []), BATCH)
    .all();
  const rows = results ?? [];
  await attachCategories(env, rows);
  const wantsBody = needsBody(rules);

  const io = providerIo(env, account);
  const outcome = newOutcome();
  try {
    for (const row of rows) {
      const message = wantsBody ? { ...row, body: await textOf(env, row.id) } : row;
      const plan = planActions(rules, message);
      if (plan.length) await perform(env, io, row, plan, outcome);
    }
  } finally {
    await io.close();
  }
  await record(env, outcome);
  const last = rows[rows.length - 1];
  return {
    scanned: rows.length,
    changed: outcome.changed,
    failed: outcome.failed,
    next: rows.length === BATCH ? { date: last.date, id: last.id } : null,
  };
}

/* ────────────────────────────────────────────────────────────────
   Routes.
   ──────────────────────────────────────────────────────────────── */

/** A stored row as the client reads it. A row this build cannot read says so and keeps its name, so it can still be deleted. */
const present = (r) => {
  const rule = readRule({ ...r, enabled: 1 });
  const parse = (v) => {
    try {
      const x = JSON.parse(v);
      return Array.isArray(x) ? x : [];
    } catch {
      return [];
    }
  };
  return {
    id: r.id,
    name: r.name,
    enabled: !!r.enabled,
    match: r.match === "any" ? "any" : "all",
    conditions: parse(r.conditions),
    actions: parse(r.actions),
    stop: !!r.stop,
    n: r.n,
    last_at: r.last_at,
    last_error: r.last_error || "",
    unreadable: !rule,
  };
};

const list = async (env) => ({ rules: (await loadRules(env)).map(present), catalog: catalog() });

async function categoryIds(env) {
  const { results } = await env.DB.prepare("SELECT id FROM categories").all();
  return new Set((results ?? []).map((r) => r.id));
}

async function api(request, env, path) {
  const m = request.method;

  if (path === "/api/rules" && m === "GET") return json(await list(env));

  if (path === "/api/rules" && m === "POST") {
    const b = await request.json().catch(() => ({}));
    const c = cleanRule(b, await categoryIds(env));
    if (c.error) return json({ error: c.error }, 400);
    const at = (await env.DB.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM rules").first()).p;
    await env.DB.prepare(
      `INSERT INTO rules (name, enabled, position, "match", conditions, actions, stop, created_at) VALUES (?,?,?,?,?,?,?,?)`
    )
      .bind(c.name, b.enabled === false ? 0 : 1, at, c.match, JSON.stringify(c.conditions), JSON.stringify(c.actions), c.stop, Date.now())
      .run();
    return json({ ok: true, ...(await list(env)) }, 201);
  }

  if (path === "/api/rules/order" && m === "POST") {
    const b = await request.json().catch(() => ({}));
    const have = (await loadRules(env)).map((r) => r.id);
    const asked = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number))].filter((id) => have.includes(id));
    // Whatever the list leaves out keeps its place after the ones it names.
    const order = [...asked, ...have.filter((id) => !asked.includes(id))];
    await env.DB.batch(order.map((id, i) => env.DB.prepare("UPDATE rules SET position=? WHERE id=?").bind(i, id)));
    return json({ ok: true, ...(await list(env)) });
  }

  if (path === "/api/rules/run" && m === "POST") {
    const b = await request.json().catch(() => ({}));
    try {
      return json({ ok: true, ...(await runBatch(env, b.cursor)) });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502);
    }
  }

  const one = path.match(/^\/api\/rules\/(\d+)$/);
  if (one && m === "PATCH") {
    const id = Number(one[1]);
    const cur = await env.DB.prepare("SELECT * FROM rules WHERE id=?").bind(id).first();
    if (!cur) return json({ error: "Unknown rule" }, 404);
    const b = await request.json().catch(() => ({}));
    const enabled = b.enabled === undefined ? !!cur.enabled : !!b.enabled;
    // Only the switch: the rest is left alone, so a rule from another build that
    // this one cannot edit can still be turned off.
    if (b.name === undefined && b.conditions === undefined && b.actions === undefined) {
      await env.DB.prepare("UPDATE rules SET enabled=? WHERE id=?").bind(enabled ? 1 : 0, id).run();
      return json({ ok: true, ...(await list(env)) });
    }
    const c = cleanRule({ ...present(cur), ...b }, await categoryIds(env));
    if (c.error) return json({ error: c.error }, 400);
    // An edited rule starts afresh: its old error was about what it used to say.
    await env.DB.prepare(`UPDATE rules SET name=?, enabled=?, "match"=?, conditions=?, actions=?, stop=?, last_error=NULL WHERE id=?`)
      .bind(c.name, enabled ? 1 : 0, c.match, JSON.stringify(c.conditions), JSON.stringify(c.actions), c.stop, id)
      .run();
    return json({ ok: true, ...(await list(env)) });
  }
  if (one && m === "DELETE") {
    await env.DB.prepare("DELETE FROM rules WHERE id=?").bind(Number(one[1])).run();
    return json({ ok: true, ...(await list(env)) });
  }

  return null;
}

/** For MODULES in src/modules.js. */
export const rulesModule = { name: "rules", api, tables: ["rules"] };
