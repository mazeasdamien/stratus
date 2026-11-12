/**
 * Drives the real scheduled() sync and reconcile against in-process fakes:
 * D1 over node:sqlite, R2 over a Map, and a small IMAP server reached through
 * a cloudflare:sockets stub. IMAP cannot be reached from a dev machine, so
 * this is the only end-to-end check of the sync path. No real account or
 * credential is involved: the fake server accepts any LOGIN.
 *
 *   node --no-warnings scripts/sync-harness/run.mjs          all three modes
 *   node --no-warnings scripts/sync-harness/run.mjs <caps>   one mode, e.g. IMAP4rev1,MOVE
 *
 * Each mode runs in its own process, so module state in src/ starts clean.
 */
import { register } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MODES = ["IMAP4rev1,UIDPLUS,MOVE,CONDSTORE", "IMAP4rev1,UIDPLUS,MOVE", "IMAP4rev1,MOVE"];

if (!process.argv[2]) {
  const self = fileURLToPath(import.meta.url);
  let failed = 0;
  for (const mode of MODES) {
    const r = spawnSync(process.execPath, ["--no-warnings", self, mode], { stdio: "inherit" });
    if (r.status !== 0) failed++;
  }
  console.log(failed ? `✗ sync : ${failed} mode(s) en échec sur ${MODES.length}` : `✓ sync : ${MODES.length} modes IMAP passés`);
  process.exit(failed ? 1 : 0);
}

// Must precede the import of src/index.js, which imports cloudflare:sockets.
register("./hooks.mjs", import.meta.url);
const { makeD1, makeR2, FakeImap, BS } = await import("./fake.mjs");
const caps = process.argv[2].split(",");
const { default: worker } = await import("../../src/index.js");
const { seal } = await import("../../src/crypto.js");
const { SCHEMA } = await import("../../src/schema.js");

let pass = 0, fail = 0;
const ok = (c, label) => (c ? pass++ : (fail++, console.log("  ✗ " + label)));
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), `${label}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const sqlLog = [];
const DB = makeD1(sqlLog);
const MAIL = makeR2();
const imap = new FakeImap({ caps });
globalThis.__fakeConnect = () => imap.connect();

const ENC_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const env = { DB, MAIL, ENC_KEY, APP_URL: "http://x" };

// An OLD database: the messages table as it was before this change, to prove
// the heal runs before the index that needs its columns.
const OLD = SCHEMA.map((s) =>
  s
    .replace(/^\s*-- First References[\s\S]*?thread_key  TEXT NOT NULL DEFAULT '',\n\s*refs .*\n/m, "  thread_key  TEXT NOT NULL DEFAULT '',\n")
    .replace(/\n\s*-- Where the provider has it[\s\S]*?uid         INTEGER NOT NULL DEFAULT 0,/m, "")
);
for (const s of OLD) DB.raw.exec(s);
const cols = DB.raw.prepare("SELECT name FROM pragma_table_info('messages')").all().map((r) => r.name);
ok(!cols.includes("uid") && !cols.includes("refs"), "old schema really lacks the new columns: " + cols.join(","));

const latin = (s) => Buffer.from(s, "utf8").toString("latin1");
// Dated within the last hour, a minute apart in arrival order: push only rings
// for unread mail that is recent and newer than any unread mail before it.
let clock = Date.now() - 3_600_000;
const msg = (id, subject, extra = "", body = "hello") =>
  latin(`From: Zoé <zoe@x.fr>\r\nTo: me@example.com\r\nSubject: ${subject}\r\nDate: ${new Date((clock += 60_000)).toUTCString()}\r\nMessage-ID: ${id}\r\n${extra}Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}\r\n`);

imap.box("INBOX", BS + "HasNoChildren");
imap.box("Archive", BS + "HasNoChildren " + BS + "Archive");
imap.box("Sent Messages", BS + "HasNoChildren " + BS + "Sent");
const SEEN = BS + "Seen";
const A = imap.add("INBOX", msg("<a@x>", "Dîner", "", "Prix : 20 € — “ok”"), [SEEN]);
const B = imap.add("INBOX", msg("<b@x>", "Re: Dîner", "In-Reply-To: <a@x>\r\nReferences: <a@x>\r\n"), [SEEN]);
const C = imap.add("INBOX", msg("<c@x>", "C"));
const D = imap.add("INBOX", msg("<d@x>", "D"));
const E = imap.add("INBOX", msg("<e@x>", "E"));
imap.add("Archive", msg("<f@x>", "F"), [SEEN]);
imap.add("Archive", msg("<g@x>", "G"), [SEEN]);
imap.add("Sent Messages", msg("<h@x>", "H"), [SEEN]);

DB.raw.prepare("INSERT INTO accounts (id, provider, email, label, secret, created_at) VALUES (?,?,?,?,?,?)").run(
  "acct1", "icloud", "me@example.com", "", await seal(ENC_KEY, { password: "not-a-real-password" }), Date.now()
);

let pushes = 0;
async function pass1(label) {
  const before = sqlLog.length;
  const waits = [];
  await worker.scheduled({ cron: "* * * * *" }, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  const acct = DB.raw.prepare("SELECT status, last_error FROM accounts").get();
  if (acct.last_error) console.log(`  [${label}] last_error: ${acct.last_error}`);
  pushes += sqlLog.slice(before).filter((s) => s.includes("FROM push_subs")).length;
}
const row = (mid) => DB.raw.prepare("SELECT * FROM messages WHERE mid=?").get(mid);
const count = () => DB.raw.prepare("SELECT COUNT(*) n FROM messages").get().n;

// ── first sync ──
for (let i = 0; i < 4; i++) await pass1("initial " + i);
const newCols = DB.raw.prepare("SELECT name FROM pragma_table_info('messages')").all().map((r) => r.name);
ok(newCols.includes("uid") && newCols.includes("mailbox") && newCols.includes("refs"), "heal added uid/mailbox/refs");
ok(DB.raw.prepare("SELECT name FROM sqlite_master WHERE name='idx_messages_uid'").get(), "uid index created after heal");
eq(count(), 8, "all 8 messages stored");
eq([row("<a@x>").mailbox, row("<a@x>").uid], ["INBOX", A.uid], "row A placed at INBOX/uid");
eq(row("<a@x>").thread_key, "<a@x>", "root keyed on own id");
eq(row("<b@x>").thread_key, "<a@x>", "reply keyed on root");
eq(row("<b@x>").refs, "<a@x>", "refs stored");
eq(row("<a@x>").subject, "Dîner", "raw UTF-8 subject decoded");
eq(row("<a@x>").from_name, "Zoé", "raw UTF-8 sender name decoded");
const bodyA = JSON.parse(MAIL.map.get(`body/${row("<a@x>").id}.json`));
ok(bodyA.html.includes("20 € — “ok”"), "8bit UTF-8 body intact: " + bodyA.html.slice(0, 120));
eq(row("<c@x>").unread, 1, "C unread before");
ok(pushes >= 1, "first sync rang (new unread mail)");

// ── read on the phone ──
imap.setFlag("INBOX", C.uid, SEEN, true);
imap.setFlag("INBOX", D.uid, BS + "Flagged", true);
pushes = 0;
await pass1("read elsewhere");
eq(row("<c@x>").unread, 0, "C read on phone → read here");
eq(row("<d@x>").starred, 1, "D flagged on phone → starred here");
eq(pushes, 0, "reading elsewhere does not ring");
// marked unread again on the phone: also no ring
imap.setFlag("INBOX", C.uid, SEEN, false);
pushes = 0;
await pass1("unread elsewhere");
eq(row("<c@x>").unread, 1, "C marked unread on phone → unread here");
eq(pushes, 0, "re-marking unread elsewhere does not ring");

// ── new mail and a read in the same pass still rings ──
imap.setFlag("INBOX", C.uid, SEEN, true);
const N = imap.add("INBOX", msg("<n@x>", "New"));
pushes = 0;
await pass1("new + read");
eq(row("<n@x>")?.unread, 1, "new mail stored");
ok(pushes >= 1, "new arrival rings even though another was read");

// ── deleted in Apple Mail ──
const dId = row("<d@x>").id;
ok(MAIL.map.has(`body/${dId}.json`), "D body in R2 before");
imap.expunge("INBOX", D.uid);
await pass1("expunge 1");
ok(row("<d@x>"), "first miss: kept (two strikes)");
await pass1("expunge 2");
ok(!row("<d@x>"), "second miss: row gone");
ok(!MAIL.map.has(`body/${dId}.json`), "D body gone from R2");
eq(DB.raw.prepare("SELECT COUNT(*) n FROM search WHERE id=?").get(dId).n, 0, "D gone from search");

// ── moved to Archive on the phone ──
const E2 = imap.move("INBOX", E.uid, "Archive");
for (let i = 0; i < 6; i++) await pass1("move " + i);
eq([row("<e@x>")?.folder, row("<e@x>")?.mailbox, row("<e@x>")?.uid], ["archive", "Archive", E2.uid], "E refiled to Archive with its new UID");

// ── legacy rows: pre-change data with no placement ──
DB.raw.exec("UPDATE messages SET uid=0, mailbox=''");
DB.raw.prepare(
  "INSERT INTO messages (id, account_id, pid, mid, thread_key, folder, subject, created_at) VALUES ('ghost','acct1','<ghost@x>','<ghost@x>','<ghost@x>','inbox','gone long ago',1)"
).run();
for (let i = 0; i < 12; i++) await pass1("legacy " + i);
eq([row("<a@x>").mailbox, row("<a@x>").uid], ["INBOX", A.uid], "legacy row A re-placed by Message-ID");
eq([row("<f@x>").mailbox], ["Archive"], "legacy Archive row re-placed");
ok(!row("<ghost@x>"), "never-placed legacy row deleted elsewhere is swept");
eq(row("<h@x>").mailbox, "Sent Messages", "Sent row re-placed");

// ── legacy thread-key migration ──
const mig = DB.raw.prepare("SELECT value FROM settings WHERE key='migrations'").get();
ok(mig && mig.value.includes("thread_key_mid"), "migration recorded");

// ── uidvalidity change: nothing deleted ──
const before = count();
imap.box("INBOX").uidvalidity = 99;
for (let i = 0; i < 4; i++) await pass1("uidvalidity " + i);
eq(count(), before, "renumbered mailbox: no rows lost");
eq(row("<a@x>").mailbox, "INBOX", "rows re-placed after renumbering");

// ── blocked sender purge uses UID EXPUNGE / EXPUNGE by capability ──
DB.raw.prepare("INSERT INTO blocked_senders (pattern, created_at) VALUES ('spam.example', 1)").run();
imap.add("INBOX", latin("From: s <s@spam.example>\r\nSubject: x\r\nMessage-ID: <s@x>\r\n\r\nx\r\n"));
const changedSince = imap.log.filter((l) => l.includes("CHANGEDSINCE")).length;
if (caps.includes("CONDSTORE")) ok(changedSince > 0, "CONDSTORE: flag fetches use CHANGEDSINCE");
else eq(changedSince, 0, "no CONDSTORE: CHANGEDSINCE never sent");
imap.log.length = 0;
await pass1("blocked");
const expunges = imap.log.filter((l) => /EXPUNGE/.test(l));
ok(expunges.length > 0, "blocked sender purged with an expunge");
if (caps.includes("UIDPLUS")) ok(expunges.every((l) => l.startsWith("UID EXPUNGE")), "UIDPLUS: only UID EXPUNGE");
else ok(expunges.every((l) => l === "EXPUNGE"), "no UIDPLUS: plain EXPUNGE");
ok(!row("<s@x>"), "blocked never stored");

// ── Bcc to yourself, then the inbox copy deleted: Sent keeps the message ──
imap.box("Deleted Messages", BS + "HasNoChildren " + BS + "Trash");
const mine = msg("<bcc@x>", "Sent with a Bcc to me");
imap.add("Sent Messages", mine, [SEEN]);
const inboxCopy = imap.add("INBOX", mine, [SEEN]);
for (let i = 0; i < 6; i++) await pass1("bcc " + i);
eq(row("<bcc@x>")?.folder, "inbox", "the delivered copy shows in the inbox");
imap.move("INBOX", inboxCopy.uid, "Deleted Messages");
for (let i = 0; i < 16; i++) await pass1("bcc deleted " + i);
eq([row("<bcc@x>")?.folder, row("<bcc@x>")?.mailbox], ["sent", "Sent Messages"], "binning the inbox copy leaves it in Sent");
// A message you delete from Sent itself does go to Trash.
const own = imap.add("Sent Messages", msg("<own@x>", "Sent, then deleted"), [SEEN]);
for (let i = 0; i < 6; i++) await pass1("own " + i);
eq(row("<own@x>")?.folder, "sent", "sent copy stored");
imap.move("Sent Messages", own.uid, "Deleted Messages");
for (let i = 0; i < 16; i++) await pass1("own deleted " + i);
eq(row("<own@x>")?.folder, "trash", "deleted from Sent: in Trash");

// ── Sent lists what you wrote, even when the copy to yourself was filed elsewhere ──
const { handleApi } = await import("../../src/api.js");
const fromMe = latin(`From: Me <me@example.com>\r\nTo: z@x.fr\r\nBcc: me@example.com\r\nSubject: Copied to myself\r\nDate: ${new Date((clock += 60_000)).toUTCString()}\r\nMessage-ID: <mine@x>\r\n\r\nhi\r\n`);
imap.add("Sent Messages", fromMe, [SEEN]);
imap.add("Archive", fromMe, [SEEN]);
for (let i = 0; i < 6; i++) await pass1("copied " + i);
eq(row("<mine@x>")?.folder, "archive", "the copy to yourself is filed in Archive");
const listed = async (folder) =>
  (await (await handleApi(new Request(`http://x/api/messages?folder=${folder}`), env, "/api/messages")).json()).messages.map((m) => m.subject);
ok((await listed("sent")).includes("Copied to myself"), "and it is listed in Sent");
ok((await listed("archive")).includes("Copied to myself"), "as well as in Archive");
ok(!(await listed("sent")).includes("Dîner"), "mail from others stays out of Sent");
const page = async (limit) =>
  (await (await handleApi(new Request(`http://x/api/messages?folder=all&limit=${limit}`), env, "/api/messages")).json()).messages.length;
eq([await page(2), await page(-1)], [2, 1], "a page is as long as asked, and a negative limit is not the whole mailbox");

// ── Routes that act at the provider, driven the way the app drives them ──
const api = async (method, path, body, headers = {}) => {
  const res = await handleApi(
    new Request("http://x" + path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    }),
    env,
    path.split("?")[0],
    { waitUntil() {} },
    { sub: "harness" }
  );
  return { status: res.status, body: await res.json().catch(() => null) };
};
const holds = (box, mid) => imap.box(box).msgs.some((m) => m.raw.includes(`Message-ID: ${mid}`));

// ── Delete permanently only ever touches the folder the row is filed under ──
// Sent with a Bcc to yourself, the delivered copy binned, and Apple has since
// emptied Trash on its own: the row still says trash, the only copy is in Sent.
imap.add("Sent Messages", msg("<twin@x>", "Bcc to me, binned copy already gone"), [SEEN]);
DB.raw.prepare(
  "INSERT INTO messages (id, account_id, pid, mid, thread_key, folder, subject, created_at) VALUES ('00000000000000a1','acct1','<twin@x>','<twin@x>','<twin@x>','trash','twin',1)"
).run();
const stale = await api("POST", "/api/messages/00000000000000a1/purge");
eq([stale.status, stale.body?.alreadyGone], [200, true], "purging a row whose binned copy is gone reports it as already gone");
ok(holds("Sent Messages", "<twin@x>"), "and the copy in Sent is not expunged in its place");
ok(!row("<twin@x>"), "the stale row is dropped");
// The ordinary case still deletes for good.
imap.add("Deleted Messages", msg("<binned@x>", "Binned"), [SEEN]);
for (let i = 0; i < 6; i++) await pass1("binned " + i);
eq(row("<binned@x>")?.folder, "trash", "a binned message is stored under trash");
const forGood = await api("POST", `/api/messages/${row("<binned@x>").id}/purge`);
eq([forGood.status, forGood.body?.alreadyGone], [200, false], "purging it succeeds");
ok(!holds("Deleted Messages", "<binned@x>") && !row("<binned@x>"), "and it is gone from Trash at the provider and here");

// ── Filing a conversation refiles only what the provider actually moved ──
imap.add("INBOX", msg("<th1@x>", "Thread"));
const th2 = imap.add("INBOX", msg("<th2@x>", "Re: Thread", "In-Reply-To: <th1@x>\r\nReferences: <th1@x>\r\n"));
for (let i = 0; i < 6; i++) await pass1("thread " + i);
eq([row("<th1@x>")?.folder, row("<th2@x>")?.folder], ["inbox", "inbox"], "both messages of the thread are in the inbox");
imap.move("INBOX", th2.uid, "Archive"); // on the phone, a moment before
const filed = await api("POST", "/api/thread", { key: "<th1@x>", from: "inbox", folder: "trash" });
eq([filed.status, filed.body?.n], [200, 1], "the move reports the one message it moved");
ok(holds("Deleted Messages", "<th1@x>") && row("<th1@x>").folder === "trash", "that message is in Trash at the provider and here");
ok(holds("Archive", "<th2@x>") && row("<th2@x>").folder !== "trash", "the one moved elsewhere is not shown as binned");
// Nothing left of the thread in the inbox at the provider: say so, change nothing.
DB.raw.prepare("UPDATE messages SET folder='inbox' WHERE mid='<th2@x>'").run();
const none = await api("POST", "/api/thread", { key: "<th1@x>", from: "inbox", folder: "trash" });
ok(none.status !== 200 && !!none.body?.error, "a thread the provider no longer has there is refused: " + JSON.stringify(none.body));
eq(row("<th2@x>").folder, "inbox", "and its row is left where it was");

// ── A block rule never destroys mail you wrote ──
DB.raw.prepare("INSERT INTO settings (key, value) VALUES ('aliases_acct1', ?)").run(JSON.stringify(["me@mydomain.example"]));
const ownRule = await api("POST", "/api/blocked", { pattern: "mydomain.example" });
eq(ownRule.status, 400, "a rule covering an address you send as is refused");
ok(!DB.raw.prepare("SELECT 1 FROM blocked_senders WHERE pattern='mydomain.example'").get(), "and not stored");
// An address you answered as without listing it, and a rule that covers it.
const asRelay = (id) => latin(`From: Me <me@relay.example>\r\nTo: z@x.fr\r\nSubject: Sent as a relay address\r\nDate: ${new Date((clock += 60_000)).toUTCString()}\r\nMessage-ID: ${id}\r\n\r\nhi\r\n`);
DB.raw.prepare("INSERT INTO blocked_senders (pattern, created_at) VALUES ('relay.example', 1)").run();
imap.add("Sent Messages", asRelay("<relay1@x>"), [SEEN]);
imap.add("INBOX", asRelay("<relay2@x>"));
for (let i = 0; i < 6; i++) await pass1("own mail " + i);
ok(holds("Sent Messages", "<relay1@x>") && row("<relay1@x>")?.folder === "sent", "the sync leaves your Sent copy alone under a matching rule");
ok(!holds("INBOX", "<relay2@x>") && !row("<relay2@x>"), "and still destroys what arrives from that address");
DB.raw.prepare("DELETE FROM blocked_senders WHERE pattern='relay.example'").run();
const late = await api("POST", "/api/blocked", { pattern: "relay.example" });
eq(late.status, 200, "making the rule afterwards is accepted");
ok(holds("Sent Messages", "<relay1@x>") && !!row("<relay1@x>"), "and clearing out what it matches spares Sent, at the provider and here");

// ── One message the server refuses to hand over does not stop the mail behind it ──
const refused = imap.add("INBOX", msg("<refused@x>", "The server will not read this one back"));
imap.broken = new Set([`INBOX:${refused.uid}`]);
imap.add("INBOX", msg("<after@x>", "Arrives after it"));
imap.add("Archive", msg("<elsewhere@x>", "Arrives in another folder"));
for (let i = 0; i < 6; i++) await pass1("refused " + i);
ok(!!row("<after@x>") && !!row("<elsewhere@x>"), "mail behind a refused message still arrives, in its folder and in others");
eq(row("<refused@x>")?.subject, "The server will not read this one back", "and the refused one is listed from its headers");
imap.broken = null;

// ── Opening an invitation puts it on the timeline if it is not there yet ──
imap.add(
  "INBOX",
  latin(
    `From: Zoé <zoe@x.fr>\r\nTo: me@example.com\r\nSubject: Point\r\nDate: ${new Date((clock += 60_000)).toUTCString()}\r\nMessage-ID: <inv@x>\r\n` +
      `Content-Type: multipart/alternative; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nYou are invited\r\n` +
      `--b1\r\nContent-Type: text/calendar; method=REQUEST; charset=utf-8\r\n\r\nBEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:ev1\r\n` +
      `DTSTART:20270115T100000Z\r\nDTEND:20270115T110000Z\r\nSUMMARY:Point\r\nORGANIZER:mailto:zoe@x.fr\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n--b1--\r\n`
  )
);
for (let i = 0; i < 6; i++) await pass1("invite " + i);
const inv = row("<inv@x>");
const onTimeline = () => !!DB.raw.prepare("SELECT 1 FROM events WHERE id=?").get(inv?.id);
ok(!!inv && onTimeline(), "an invitation is indexed when it arrives");
// One stored before the timeline existed has no event row.
DB.raw.prepare("DELETE FROM events WHERE id=?").run(inv.id);
const opened = await api("GET", `/api/messages/${inv.id}?peek=1`);
eq([opened.status, opened.body?.invite?.summary], [200, "Point"], "opening it returns the invitation");
ok(onTimeline(), "and puts it on the timeline");
// The timeline carries each answer without asking for it event by event.
DB.raw.prepare("INSERT INTO settings (key, value) VALUES (?, 'accepted')").run(`rsvp_${inv.id}`);
await api("GET", "/api/timeline"); // the first call also seeds the table
const sqlBefore = sqlLog.length;
const timeline = await api("GET", "/api/timeline");
eq(timeline.body?.events?.find((e) => e.id === inv.id)?.rsvp, "accepted", "the timeline shows the answer given to an invitation");
eq(sqlLog.slice(sqlBefore).filter((s) => /FROM settings WHERE key=\?/.test(s)).length, 0, "without one query per event");

// ── "Send later" pressed twice for one message queues it once ──
const later = { account_id: "acct1", to: "zoe@x.fr", subject: "Later", text: "hi", at: Date.now() + 3_600_000 };
const first = await api("POST", "/api/send", later, { "Idempotency-Key": "one-message" });
const again = await api("POST", "/api/send", later, { "Idempotency-Key": "one-message" });
eq([first.status, again.status, again.body?.repeat, again.body?.id], [202, 202, true, first.body?.id], "the second press gets the first answer back");
eq(DB.raw.prepare("SELECT COUNT(*) n FROM outbox").get().n, 1, "and one message waits in the outbox, not two");

// ── The nightly snapshot never replaces a complete one with a partial one ──
const { runBackup } = await import("../../src/backup.js");
const snapshots = () => [...MAIL.map.keys()].filter((k) => k.startsWith("backup/"));
const good = await runBackup(env, Date.now() - 86_400_000);
eq(good.counts.messages, count(), "a snapshot holds every message row");
ok(["image_senders", "revoked_sessions", "events"].every((t) => t in good.counts), "and the tables a restore needs: " + Object.keys(good.counts).join(","));
const realPrepare = DB.prepare;
DB.prepare = (sql) => {
  if (/FROM messages WHERE rowid/.test(sql)) throw new Error("D1_ERROR: Network connection lost");
  return realPrepare(sql);
};
const partial = await runBackup(env, Date.now()).then(() => "written", (e) => String(e.message));
DB.prepare = realPrepare;
ok(/connection lost/.test(partial), "a read that fails halfway fails the snapshot: " + partial);
eq(snapshots(), [good.key], "and the last complete snapshot is still the one held");
DB.raw.exec("DROP TABLE events");
const grown = await runBackup(env, Date.now());
eq([grown.counts.events, grown.counts.messages], [0, count()], "a table the database does not have yet is skipped, not fatal");

console.log(`${fail ? "✗" : "✓"} ${pass} assertions passées, ${fail} échec(s) (caps ${caps.join(" ")})`);
process.exit(fail ? 1 : 0);
