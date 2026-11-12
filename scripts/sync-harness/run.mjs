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
const { makeD1, makeR2, FakeImap, FakeSmtp, BS } = await import("./fake.mjs");
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
const smtp = new FakeSmtp();
// Submission is the only thing on 587; everything else is IMAP.
globalThis.__fakeConnect = (addr) => (addr?.port === 587 ? smtp.connect() : imap.connect());

const random = (n) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("base64");
const ENC_KEY = random(32);
// Made up on each run, like the sealing key: no real secret is ever written here.
const env = { DB, MAIL, ENC_KEY, APP_URL: "http://x", AUTH_SECRET: random(32), BOOTSTRAP_KEY: random(24) };

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

// ── Mail the provider has, with no row here, is fetched again ──
// The row of a message in Sent is lost here (its twin in Trash was deleted
// for good, say) while the copy in Sent is still at the provider.
ok(holds("Sent Messages", "<h@x>") && !!row("<h@x>"), "H is in Sent at the provider and here");
DB.raw.prepare("DELETE FROM messages WHERE mid='<h@x>'").run();
for (let i = 0; i < 10; i++) await pass1("orphan " + i);
eq([row("<h@x>")?.folder, row("<h@x>")?.mailbox], ["sent", "Sent Messages"], "a message the provider still has comes back");
// One that can never be stored is asked for again once, not on every pass.
const dead = imap.add("INBOX", msg("<dead@x>", "Neither body nor headers can be read back"));
imap.dead = new Set([`INBOX:${dead.uid}`]);
imap.log.length = 0;
for (let i = 0; i < 10; i++) await pass1("dead " + i);
const asked = imap.log.filter((l) => l === `UID FETCH ${dead.uid} (FLAGS BODY.PEEK[])`).length;
ok(asked >= 1 && asked <= 2, `a message that cannot be stored is retried once, not every pass: asked ${asked} times in 10 passes`);
ok(!row("<dead@x>"), "and is not stored");
imap.dead = null;

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

// ── A scheduled message is delivered by one hand at a time ──
const { flushOutbox, OUTBOX_LEASE_MS } = await import("../../src/outgoing.js");
const waiting = first.body.id;
const lease = `outbox_lock_${waiting}`;
const holdLease = (at) => DB.raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(lease, String(at));
const leaseHeld = () => !!DB.raw.prepare("SELECT 1 FROM settings WHERE key=?").get(lease);
const outboxRow = (id) => DB.raw.prepare("SELECT * FROM outbox WHERE id=?").get(id);
const wentOut = (subject) => smtp.sent.filter((m) => m.raw.includes(`Subject: ${subject}`)).length;
holdLease(Date.now()); // a delivery of it is under way
const busySend = await api("POST", `/api/outbox/${waiting}/send`);
const busyEdit = await api("POST", `/api/outbox/${waiting}/cancel`);
eq([busySend.status, busyEdit.status], [409, 409], "Send now and Edit are refused while the message is being sent");
ok(/being sent/.test(busySend.body?.error || "") && !busyEdit.body?.message, "with the reason, and without handing the message back");
ok(!!outboxRow(waiting) && MAIL.map.has(`outbox/${waiting}.json`) && wentOut("Later") === 0, "nothing was sent or removed");
DB.raw.prepare("UPDATE outbox SET at=? WHERE id=?").run(Date.now() - 1000, waiting);
await flushOutbox(env);
eq([outboxRow(waiting)?.tries, wentOut("Later"), leaseHeld()], [0, 0, true], "the cron leaves a row someone else is delivering exactly as it is");
// A lease left by a delivery that died does not hold the message for ever.
holdLease(Date.now() - OUTBOX_LEASE_MS - 1000);
const sentNow = await api("POST", `/api/outbox/${waiting}/send`);
eq([sentNow.status, wentOut("Later")], [202, 1], "Send now sends it once the lease has expired");
ok(!outboxRow(waiting) && !leaseHeld(), "and leaves neither the row nor the lease behind");
ok(holds("Sent Messages", smtp.sent.at(-1).raw.match(/^Message-ID: (.*)$/m)?.[1].trim()), "the copy is filed in Sent at the provider");
const sentAgain = await api("POST", `/api/outbox/${waiting}/send`);
await flushOutbox(env);
eq([sentAgain.status, wentOut("Later")], [404, 1], "a second press, and the next cron, send nothing more");
// The cron's own delivery, and Edit, give the lease back when they are done.
const due = await api("POST", "/api/send", { ...later, subject: "Due" });
const kept = await api("POST", "/api/send", { ...later, subject: "Kept" });
DB.raw.prepare("UPDATE outbox SET at=? WHERE id=?").run(Date.now() - 1000, due.body.id);
await flushOutbox(env);
eq([wentOut("Due"), !!outboxRow(due.body.id)], [1, false], "a message that has come due is sent by the cron");
const edited = await api("POST", `/api/outbox/${kept.body.id}/cancel`);
eq([edited.status, edited.body?.message?.subject, !!outboxRow(kept.body.id), wentOut("Kept")], [200, "Kept", false, 0], "Edit takes back one that is not being sent");
eq(DB.raw.prepare("SELECT COUNT(*) n FROM settings WHERE key LIKE 'outbox_lock_%'").get().n, 0, "no lease outlives what it guarded");

// ── The list: the same answer as the query it replaced, and pages that skip nothing ──
// A conversation with a mix of read, unread and starred messages in one folder.
imap.add("INBOX", msg("<p1@x>", "Pager one"), [BS + "Flagged"]);
imap.add("INBOX", msg("<p2@x>", "Re: Pager one", "In-Reply-To: <p1@x>\r\nReferences: <p1@x>\r\n"), [SEEN]);
imap.add("INBOX", msg("<p3@x>", "Re: Pager one", "In-Reply-To: <p2@x>\r\nReferences: <p1@x> <p2@x>\r\n"));
imap.add("INBOX", msg("<p4@x>", "Pager two"));
imap.add("INBOX", msg("<p5@x>", "Pager three"), [SEEN]);
for (let i = 0; i < 8; i++) await pass1("pager " + i);
eq(["<p1@x>", "<p2@x>", "<p3@x>"].map((m) => row(m)?.thread_key), ["<p1@x>", "<p1@x>", "<p1@x>"], "the three messages share a conversation");
// The grouped query the route ran until now, word for word.
const ownAddresses = ["me@example.com", ...JSON.parse(DB.raw.prepare("SELECT value FROM settings WHERE key='aliases_acct1'").get().value)];
const oldList = (folder, { starred = false, account = "" } = {}) => {
  let sql = `SELECT id, account_id, thread_key, from_name, from_email, subject, snippet,
                MAX(date) AS date, SUM(unread) AS unread, SUM(starred) AS starred,
                folder, has_body, COUNT(*) AS n
           FROM messages WHERE 1=1`;
  const vals = [];
  if (folder === "sent") {
    sql += ` AND (folder='sent' OR (lower(from_email) IN (${ownAddresses.map(() => "?").join(",")}) AND folder NOT IN ('trash','spam','drafts')))`;
    vals.push(...ownAddresses);
  } else if (folder !== "all") {
    sql += " AND folder=?";
    vals.push(folder);
  }
  if (account) {
    sql += " AND account_id=?";
    vals.push(account);
  }
  if (starred) sql += " AND starred=1";
  sql += " GROUP BY CASE WHEN thread_key='' THEN id ELSE thread_key END ORDER BY date DESC LIMIT ?";
  return DB.raw.prepare(sql).all(...vals, 100).map((r) => ({ ...r }));
};
// The old order between two conversations of the same date was left to chance.
const newestFirst = (rows) => [...rows].sort((a, b) => b.date - a.date || (a.id < b.id ? 1 : -1));
const listOf = async (query) => (await api("GET", `/api/messages?${query}`)).body.messages;
for (const [folder, extra, opts] of [
  ["inbox", "", {}],
  ["archive", "", {}],
  ["sent", "", {}],
  ["all", "", {}],
  ["all", "&starred=1", { starred: true }],
  ["sent", "&account=acct1", { account: "acct1" }],
  ["inbox", "&account=nobody", { account: "nobody" }],
]) {
  const want = newestFirst(oldList(folder, opts));
  const got = await listOf(`folder=${folder}&limit=100${extra}`);
  ok(folder === "inbox" && extra ? want.length === 0 : want.length > 0, `the old query lists something for ${folder}${extra}: ${want.length}`);
  eq(got, want, `folder=${folder}${extra} answers what the grouped query answered`);
}
const pagerRow = (await listOf("folder=inbox&limit=100")).find((m) => m.thread_key === "<p1@x>");
eq([pagerRow?.id, pagerRow?.n, pagerRow?.unread, pagerRow?.starred], [row("<p3@x>").id, 3, 2, 1], "a conversation shows its newest message, with its count and the sums of its flags");
// Same date either side of a page boundary: three conversations, and two
// messages of one conversation.
const tied = row("<p4@x>").date;
DB.raw.prepare("UPDATE messages SET date=? WHERE mid IN ('<p5@x>','<c@x>','<n@x>')").run(tied);
DB.raw.prepare("UPDATE messages SET date=? WHERE mid='<p2@x>'").run(row("<p3@x>").date);
const pageThrough = async (query, withId) => {
  const out = [];
  for (let cursor = "", turns = 0; turns < 100; turns++) {
    const batch = await listOf(`${query}&limit=2${cursor}`);
    out.push(...batch);
    if (batch.length < 2) break;
    const last = batch[batch.length - 1];
    cursor = `&before=${last.date}` + (withId ? `&before_id=${last.id}` : "");
  }
  return out;
};
const whole = await listOf("folder=inbox&limit=100");
const paged = await pageThrough("folder=inbox", true);
ok(whole.filter((m) => m.date === tied).length >= 4, "four conversations share one date");
eq(paged.map((m) => m.id), whole.map((m) => m.id), "paging two at a time with before and before_id returns every conversation once, in order");
eq(new Set(paged.map((m) => m.thread_key || m.id)).size, paged.length, "and none of them twice");
eq(whole.find((m) => m.thread_key === "<p1@x>")?.n, 3, "two messages of one conversation with the same date are still one row");
ok((await pageThrough("folder=inbox", false)).length < whole.length, "the date alone, as the cursor was, skips rows that share it");
// Search is not grouped, and pages the same way.
const found = await listOf("folder=all&q=Pager&limit=100");
eq(found.map((m) => m.n), [1, 1, 1, 1, 1], "a search lists each matching message on its own");
eq((await pageThrough("folder=all&q=Pager", true)).map((m) => m.id), found.map((m) => m.id), "and paging through it returns each once, in order");

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

// ── The activation key: never in a URL the server reads, and not guessable at speed ──
const { AUTH_FAIL_MAX, AUTH_FAIL_WINDOW_MS } = await import("../../src/auth.js");
const activate = async (key, ip, path = "/auth") => {
  const res = await worker.fetch(
    new Request("http://x" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(ip ? { "CF-Connecting-IP": ip } : {}) },
      body: JSON.stringify({ k: key }),
    }),
    env,
    { waitUntil() {} }
  );
  return { status: res.status, cookie: res.headers.get("Set-Cookie") || "", retry: Number(res.headers.get("Retry-After")) || 0, body: await res.json().catch(() => null) };
};
const failRows = () => DB.raw.prepare("SELECT value FROM settings WHERE key LIKE 'auth_fail:%'").all().map((r) => JSON.parse(r.value));
const oldLink = await worker.fetch(new Request(`http://x/auth?k=${encodeURIComponent(env.BOOTSTRAP_KEY)}`), env, { waitUntil() {} });
eq([oldLink.status, oldLink.headers.get("Location")], [302, `/auth#k=${encodeURIComponent(env.BOOTSTRAP_KEY)}`], "an old ?k= link is sent on to the fragment form");
ok(!oldLink.headers.get("Set-Cookie"), "and signs nobody in by itself");
const signedIn = await activate(env.BOOTSTRAP_KEY, "203.0.113.1");
ok(signedIn.status === 200 && /dmzs_session=/.test(signedIn.cookie), "the right key, posted, activates the device");
eq(failRows(), [], "and leaves no count behind");
// A few wrong keys, then the right one: accepted, and the count is cleared.
for (let i = 0; i < 3; i++) await activate("wrong", "203.0.113.2");
eq(failRows().map((r) => r.n), [3], "wrong keys are counted per address");
eq([(await activate(env.BOOTSTRAP_KEY, "203.0.113.2")).status, failRows().length], [200, 0], "a right key under the limit is accepted and clears the count");
// Too many: refused before the key is looked at, on both endpoints.
const wrong = [];
for (let i = 0; i < AUTH_FAIL_MAX; i++) wrong.push((await activate("wrong", "203.0.113.3")).status);
ok(wrong.every((s) => s === 401), `the first ${AUTH_FAIL_MAX} wrong keys are each answered 401: ` + wrong.join(","));
const locked = await activate(env.BOOTSTRAP_KEY, "203.0.113.3");
ok(locked.status === 429 && !locked.cookie && locked.retry > 0 && locked.retry <= AUTH_FAIL_WINDOW_MS / 1000, "after that even the right key is answered 429 with Retry-After: " + JSON.stringify(locked));
const lockedExt = await activate(env.BOOTSTRAP_KEY, "203.0.113.3", "/api/extension/activate");
ok(lockedExt.status === 429 && !lockedExt.body?.token, "the extension's endpoint shares the count");
eq((await activate(env.BOOTSTRAP_KEY, "203.0.113.1")).status, 200, "another address is not held up by it");
const ext = await activate(env.BOOTSTRAP_KEY, "203.0.113.1", "/api/extension/activate");
ok(ext.status === 200 && !!ext.body?.token, "and the extension still activates from it");
eq((await activate("wrong", "203.0.113.1", "/api/extension/activate")).status, 401, "a wrong key there is refused");
// The window passes: the address may try again.
DB.raw.prepare("UPDATE settings SET value=json_set(value, '$.at', ?) WHERE key LIKE 'auth_fail:%' AND json_extract(value, '$.n') >= ?").run(Date.now() - AUTH_FAIL_WINDOW_MS - 1000, AUTH_FAIL_MAX);
eq((await activate("wrong", "203.0.113.3")).status, 401, "once the window has passed a wrong key is a 401 again");
eq((await activate(env.BOOTSTRAP_KEY, "203.0.113.3")).status, 200, "and the right key is accepted");
// A database that cannot answer locks nobody out.
const prepareBeforeAuth = DB.prepare;
DB.prepare = (sql) => {
  if (/settings/.test(sql)) throw new Error("D1_ERROR: no such table: settings");
  return prepareBeforeAuth(sql);
};
const blind = [await activate("wrong", "203.0.113.4"), await activate(env.BOOTSTRAP_KEY, "203.0.113.4")].map((r) => r.status);
DB.prepare = prepareBeforeAuth;
eq(blind, [401, 200], "with the settings table unreadable the right key still activates");
// The nightly run sweeps counts whose window has passed, and only those.
DB.raw.prepare("DELETE FROM settings WHERE key LIKE 'auth_fail:%'").run();
await activate("wrong", "203.0.113.5");
DB.raw.prepare("INSERT INTO settings (key, value) VALUES ('auth_fail:stale', ?)").run(JSON.stringify({ n: 4, at: Date.now() - AUTH_FAIL_WINDOW_MS - 1000 }));
const nightly = [];
await worker.scheduled({ cron: "17 3 * * *" }, env, { waitUntil: (p) => nightly.push(p) });
await Promise.all(nightly);
eq(failRows().map((r) => r.n), [1], "the nightly run drops the counts that have expired and keeps the live one");

console.log(`${fail ? "✗" : "✓"} ${pass} assertions passées, ${fail} échec(s) (caps ${caps.join(" ")})`);
process.exit(fail ? 1 : 0);
