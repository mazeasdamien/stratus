/**
 * Bringing mail in and taking it out: the Worker's half.
 *
 *   POST /api/transfer/import?folder=NAME&flags=seen,flagged&date=MS
 *        one message's raw bytes as the request body, appended to that folder
 *   POST /api/transfer/import?folder=NAME&probe=MESSAGE-ID
 *        no body: only whether this account already has that message, so a
 *        rerun does not upload what it would be told is a duplicate
 *   GET  /api/transfer/ids?folder=NAME[&after=CURSOR][&limit=N]
 *   GET  /api/transfer/ids?folder=NAME&thread=KEY
 *        the messages of a folder, oldest first, a page at a time
 *
 * A module (src/modules.js). The page does the rest: it reads a .mbox or .eml
 * as a stream, splits it (src/mbox.js), and sends the messages one at a time,
 * so an archive never passes through one request and an interrupted import
 * picks up where it stopped. Export is the page again: it asks here for the
 * ids, takes each message from GET /api/messages/:id/eml, and writes the file.
 *
 * Import is idempotent by Message-ID. A message whose Message-ID this account
 * already has, here or in the folder it is going to, is answered as a
 * duplicate and appends nothing, so running a file again after a failure, or
 * the same file twice, adds nothing that is already there. A message with no
 * Message-ID is given one derived from its bytes, so it too is the same
 * message the second time.
 */

import { bodyFromParts } from "./body.js";
import { MAX_BODY_BYTES, folderNameFor, icloudPassword, mailboxList, resolveMailbox, theAccount } from "./mailbox.js";
import { NoRouteError } from "./errors.js";
import { imapCreate, imapList, imapOpen, imapSearch, imapSelect } from "./imap.js";
import { decodeMailboxName, encodeMailboxName, htmlToText } from "./mime.js";
import { bytesToLatin1 } from "./rfc822.js";
import { imapError, indexMessage, storeRows } from "./store.js";
import { noteMailbox, rowFromRaw } from "./sync.js";
import { bodyKey, hashHex, json } from "./util.js";

/**
 * The largest message taken. Under the 32 MB the IMAP client will send, and
 * under what iCloud itself accepts on arrival. The body is read into memory
 * once, as bytes, and never as text, so this is also about what one request
 * can hold of a Worker's 128 MB beside the connection and the parser.
 */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

/** Ids per page of GET /api/transfer/ids. */
const PAGE = 500;

const FLAGS = { seen: "\\Seen", flagged: "\\Flagged", answered: "\\Answered", draft: "\\Draft" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const refuse = (error, reason, status = 400) => json({ ok: false, error, reason }, status);

/** IMAP's date-time for APPEND, "27-Nov-2026 10:00:00 +0000", or "" when the time is not usable. */
function imapDate(ms) {
  const d = new Date(ms);
  if (!Number.isFinite(ms) || d.getUTCFullYear() < 1970 || d.getUTCFullYear() > 2100) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

/** The header block of a message as text, and where the body starts (-1 when there is none). */
function headBlock(bytes) {
  const limit = Math.min(bytes.length, 256 * 1024);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] !== 10) continue;
    const next = bytes[i + 1];
    if (next === 10 || (next === 13 && bytes[i + 2] === 10)) {
      return { head: bytesToLatin1(bytes.subarray(0, i + 1)), bodyAt: i + (next === 10 ? 2 : 3) };
    }
  }
  return { head: bytesToLatin1(bytes.subarray(0, limit)), bodyAt: -1 };
}

/** The same bytes with every bare LF made CRLF: IMAP's lines end CRLF, and a file from Unix does not. */
function crlf(bytes) {
  let bare = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10 && bytes[i - 1] !== 13) bare++;
  if (!bare) return bytes;
  const out = new Uint8Array(bytes.length + bare);
  let to = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 10 && bytes[i - 1] !== 13) out[to++] = 13;
    out[to++] = bytes[i];
  }
  return out;
}

const withHeader = (line, bytes) => {
  const top = new TextEncoder().encode(line);
  const out = new Uint8Array(top.length + bytes.length);
  out.set(top, 0);
  out.set(bytes, top.length);
  return out;
};

/** Whether the account already has a message with this Message-ID, in any folder. */
const isKnown = async (env, acct, mid) =>
  Boolean(
    await env.DB.prepare("SELECT 1 FROM messages WHERE account_id=? AND (pid=? OR mid=?) LIMIT 1")
      .bind(acct.id, mid, mid)
      .first()
  );

async function importMessage(request, env, url) {
  const folder = String(url.searchParams.get("folder") || "").trim();
  if (!folder) return refuse("Say which folder the message goes into", "no-folder");
  if (folder.length > 120 || /["\\\r\n\0]/.test(folder)) return refuse("That folder name cannot be used", "bad-folder");

  const asked = String(url.searchParams.get("probe") || "").trim();
  if (asked) {
    const who = await theAccount(env);
    return json({ ok: true, duplicate: Boolean(who && (await isKnown(env, who, asked))) });
  }

  const declared = Number(request.headers.get("Content-Length"));
  if (declared > MAX_IMPORT_BYTES) {
    return refuse(`Larger than the ${MAX_IMPORT_BYTES / 1048576} MB the import accepts`, "too-large", 413);
  }
  let bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length || !bytes.some((b) => b > 32)) return refuse("The message is empty", "empty");
  if (bytes.length > MAX_IMPORT_BYTES) {
    return refuse(`Larger than the ${MAX_IMPORT_BYTES / 1048576} MB the import accepts`, "too-large", 413);
  }

  const acct = await theAccount(env);
  if (!acct) return refuse("No connected account", "no-account");

  // Something that reads as a message: a header block with a name: value line
  // in it. A photo or a text file chosen by mistake is refused here, not
  // appended to somebody's mailbox as a message with nothing in it.
  bytes = crlf(bytes);
  let { head, bodyAt } = headBlock(bytes);
  if (!/^[!-9;-~]+:/m.test(head) || !/^(?:from|to|subject|date|message-id|received|mime-version|content-type):/im.test(head)) {
    return refuse("This does not look like an email message", "not-a-message");
  }
  let mid = (/^message-id:[ \t]*(\S[^\r\n]*)/im.exec(head)?.[1] || "").trim();
  if (!mid) {
    const sum = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    mid = `<${Array.from(sum.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")}@import.invalid>`;
    bytes = withHeader(`Message-ID: ${mid}\r\n`, bytes);
    ({ head, bodyAt } = headBlock(bytes));
  }

  const flagNames = String(url.searchParams.get("flags") || "").split(",").filter((f) => FLAGS[f]);
  const flags = flagNames.map((f) => FLAGS[f]).join(" ");
  const given = Number(url.searchParams.get("date"));
  const when = Date.parse(/^date:[ \t]*(.*)$/im.exec(head)?.[1] || "") || (given > 0 ? given : 0);

  if (await isKnown(env, acct, mid)) return json({ ok: true, duplicate: true, mid });

  let box;
  let duplicate = false;
  let created = false;
  try {
    const pass = await icloudPassword(env, acct);
    if (!pass) return refuse("This account has no stored credential", "no-credential");
    const im = await imapOpen({ user: acct.email, pass });
    try {
      let boxes = await imapList(im);
      box = resolveMailbox(boxes, folder);
      if (!box) {
        // Typed into the page ("Imported"): made here, in the form IMAP
        // carries a name in, and read back from the server's own list.
        const wire = encodeMailboxName(folder);
        await imapCreate(im, wire);
        boxes = await imapList(im);
        box = resolveMailbox(boxes, wire) || resolveMailbox(boxes, folder);
        if (!box) throw new Error(`The server accepted "${folder}" but does not list it. It has: ${mailboxList(boxes)}`);
        created = true;
      }
      await imapSelect(im, box.name);
      const needle = mid.replace(/["\\\r\n]/g, "");
      duplicate = (await imapSearch(im, `HEADER "Message-ID" "${needle}"`)).length > 0;
      if (!duplicate) {
        const date = imapDate(when);
        const name = box.name.replace(/(["\\])/g, "\\$1");
        await im.commandLiteral(`APPEND "${name}" (${flags})${date ? ` "${date}"` : ""}`, bytes);
      }
    } finally {
      await im.logout();
    }
  } catch (e) {
    return imapError(e, acct, env);
  }
  if (created) await noteMailbox(env, acct, box).catch(() => {});
  if (duplicate) return json({ ok: true, duplicate: true, mid });

  // Now the row, so it is in its folder without waiting for the next sync.
  // The message is already at Apple, so nothing here may turn the answer into
  // a failure: the sync would find it anyway. The row carries no UID, like a
  // sent copy; the sync that finds the message by its Message-ID gives it one
  // and leaves it one row.
  let id = "";
  try {
    const app = folderNameFor(box);
    const whole = bytes.length <= MAX_BODY_BYTES;
    const raw = bytesToLatin1(whole ? bytes : bytes.subarray(0, bodyAt > 0 ? bodyAt : 64 * 1024));
    const { row, body, attachments } = rowFromRaw({ uid: 0, flags, raw }, app);
    row.pid = row.pid || mid;
    row.mid = row.mid || mid;
    if (!Date.parse(/^date:[ \t]*(.*)$/im.exec(head)?.[1] || "") && when) row.date = when;
    id = await hashHex(`msg|${acct.id}|${row.pid}`, 16);
    if (whole) {
      const doc = bodyFromParts({ ...body, attachments });
      await env.MAIL.put(bodyKey(id), JSON.stringify(doc), { httpMetadata: { contentType: "application/json" } });
      await storeRows(env, acct.id, [row]);
      await env.DB.prepare("UPDATE messages SET has_body=1 WHERE account_id=? AND pid=?").bind(acct.id, row.pid).run();
      await indexMessage(env, id, row, htmlToText(doc.html || ""));
    } else {
      // Too big to hold and parse: listed from its headers, and its body is
      // fetched from Apple when it is opened, as the sync does for one.
      await storeRows(env, acct.id, [row]);
    }
  } catch (e) {
    console.log(`transfer: appended ${mid} but could not store its row: ${(e && e.message) || e}`);
    return json({ ok: true, duplicate: false, mid, id: "", local: false });
  }
  return json({ ok: true, duplicate: false, mid, id, folder: folderNameFor(box), label: decodeMailboxName(folderNameFor(box)), local: true });
}

/** A page of the ids in a folder, oldest first, or the messages of one conversation in it. */
async function listIds(env, url) {
  const folder = String(url.searchParams.get("folder") || "").trim();
  if (!folder) return json({ error: "Say which folder" }, 400);
  const thread = url.searchParams.get("thread");
  if (thread) {
    const rows = await env.DB.prepare(
      "SELECT id, date, unread, starred FROM messages WHERE thread_key=? AND folder=? ORDER BY date, id LIMIT 200"
    )
      .bind(thread, folder)
      .all();
    return json({ ids: rows.results ?? [], next: null, total: (rows.results ?? []).length });
  }
  const after = /^(\d+)\.([a-f0-9]{16})$/.exec(url.searchParams.get("after") || "");
  const limit = Math.max(1, Math.min(PAGE, Number(url.searchParams.get("limit")) || PAGE));
  const at = after ? Number(after[1]) : -1;
  const { results } = await env.DB.prepare(
    `SELECT id, date, unread, starred FROM messages
      WHERE folder=? AND (date>? OR (date=? AND id>?)) ORDER BY date, id LIMIT ?`
  )
    .bind(folder, at, at, after ? after[2] : "", limit + 1)
    .all();
  const page = results ?? [];
  const more = page.length > limit;
  const ids = more ? page.slice(0, limit) : page;
  const out = { ids, next: more ? `${ids[ids.length - 1].date}.${ids[ids.length - 1].id}` : null };
  if (!after) out.total = Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE folder=?").bind(folder).first())?.n || 0);
  return json(out);
}

export const transfer = {
  name: "transfer",
  async api(request, env, path) {
    if (path === "/api/transfer/import" && request.method === "POST") {
      try {
        return await importMessage(request, env, new URL(request.url));
      } catch (e) {
        // NoRouteError is not a failure of this message: imapError hands it up.
        if (e instanceof NoRouteError) throw e;
        return refuse(`Could not import this message: ${String((e && e.message) || e).slice(0, 200)}`, "failed", 500);
      }
    }
    if (path === "/api/transfer/ids" && request.method === "GET") return listIds(env, new URL(request.url));
    return null;
  },
};
