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
    .replace(/\n\s*-- File names of the attachments[\s\S]*?att_names   TEXT,/m, "")
    // And the events table from before it told a floating time from a fixed one.
    .replace(/\n\s*floating    INTEGER[^\n]*/, "")
);
for (const s of OLD) DB.raw.exec(s);
const eventCols = () => DB.raw.prepare("SELECT name FROM pragma_table_info('events')").all().map((r) => r.name);
ok(eventCols().includes("all_day") && !eventCols().includes("floating"), "old schema has an events table without floating: " + eventCols().join(","));
const cols = DB.raw.prepare("SELECT name FROM pragma_table_info('messages')").all().map((r) => r.name);
ok(!cols.includes("uid") && !cols.includes("refs") && !cols.includes("att_names"), "old schema really lacks the new columns: " + cols.join(","));

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
ok(newCols.includes("att_names") && DB.raw.prepare("SELECT name FROM sqlite_master WHERE name='idx_messages_att_todo'").get(), "heal added att_names and its backlog index");
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
eq([filed.status, filed.body?.n, filed.body?.ids], [200, 1, [row("<th1@x>").id]], "the move reports the one message it moved, by id");
ok(holds("Deleted Messages", "<th1@x>") && row("<th1@x>").folder === "trash", "that message is in Trash at the provider and here");
ok(holds("Archive", "<th2@x>") && row("<th2@x>").folder !== "trash", "the one moved elsewhere is not shown as binned");
// Nothing left of the thread in the inbox at the provider: say so, change nothing.
DB.raw.prepare("UPDATE messages SET folder='inbox' WHERE mid='<th2@x>'").run();
const none = await api("POST", "/api/thread", { key: "<th1@x>", from: "inbox", folder: "trash" });
ok(none.status !== 200 && !!none.body?.error, "a thread the provider no longer has there is refused: " + JSON.stringify(none.body));
eq(row("<th2@x>").folder, "inbox", "and its row is left where it was");

// ── Filing a conversation leaves it unread, and Undo puts back exactly what moved ──
imap.add("Archive", msg("<u0@x>", "Undo me"), [SEEN]); // filed there long before
imap.add("INBOX", msg("<u1@x>", "Re: Undo me", "In-Reply-To: <u0@x>\r\nReferences: <u0@x>\r\n"));
imap.add("INBOX", msg("<u2@x>", "Re: Undo me", "In-Reply-To: <u1@x>\r\nReferences: <u0@x> <u1@x>\r\n"), [SEEN]);
for (let i = 0; i < 8; i++) await pass1("undo " + i);
const uFolders = () => ["<u0@x>", "<u1@x>", "<u2@x>"].map((m) => row(m)?.folder);
eq(uFolders(), ["archive", "inbox", "inbox"], "one message of the conversation is already archived, two are in the inbox");
const archived = await api("POST", "/api/thread", { key: "<u0@x>", from: "inbox", folder: "archive" });
eq([archived.status, archived.body?.n, [...(archived.body?.ids || [])].sort()], [200, 2, [row("<u1@x>").id, row("<u2@x>").id].sort()], "archiving moves the two and names them");
eq([row("<u1@x>").unread, row("<u2@x>").unread], [1, 0], "an unread message is still unread after the move");
ok(holds("Archive", "<u1@x>") && holds("Archive", "<u2@x>") && !holds("INBOX", "<u1@x>"), "both are in Archive at the provider");
const noneNamed = await api("POST", "/api/thread", { key: "<u0@x>", from: "archive", folder: "inbox", ids: [] });
const junkNamed = await api("POST", "/api/thread", { key: "<u0@x>", from: "archive", folder: "inbox", ids: ["nope", row("<a@x>").id] });
eq([noneNamed.body?.n, junkNamed.body?.n, uFolders()], [0, 0, ["archive", "archive", "archive"]], "a list of ids that names none of the conversation's rows moves nothing");
const undone = await api("POST", "/api/thread", { key: "<u0@x>", from: "archive", folder: "inbox", ids: archived.body.ids });
eq([undone.status, undone.body?.n, uFolders()], [200, 2, ["archive", "inbox", "inbox"]], "Undo with those ids puts back the two and leaves the third archived");
ok(holds("Archive", "<u0@x>") && holds("INBOX", "<u1@x>") && holds("INBOX", "<u2@x>") && !holds("Archive", "<u1@x>"), "at the provider as well");
eq([row("<u1@x>").unread, row("<u2@x>").unread], [1, 0], "and the unread one is unread still");

// ── Folder names with accents travel in modified UTF-7, and are filed under what the server lists ──
const accented = "R&AOk-unions &- caf&AOk-";
const madeFolder = await api("POST", "/api/folders", { name: "Réunions & café" });
eq([madeFolder.status, madeFolder.body?.name, madeFolder.body?.label], [200, accented, "Réunions & café"], "creating a folder answers its key and the name to show");
ok(imap.boxes.has(accented) && imap.log.includes(`CREATE "${accented}"`), "and the server was asked for it in modified UTF-7");
const folderEntry = async (key) => (await api("GET", "/api/folders")).body.folders.find((f) => f.folder === key);
eq([(await folderEntry(accented))?.label, (await folderEntry("inbox"))?.label], ["Réunions & café", "inbox"], "the folder list carries a label beside each key");
imap.add("INBOX", msg("<acc@x>", "To be filed under an accent"));
for (let i = 0; i < 6; i++) await pass1("accent " + i);
const intoAccent = await api("POST", `/api/messages/${row("<acc@x>").id}/move`, { folder: accented });
eq([intoAccent.status, holds(accented, "<acc@x>"), row("<acc@x>").folder], [200, true, accented], "a message moves into it by its key");
for (let i = 0; i < 6; i++) await pass1("accent sync " + i);
eq([row("<acc@x>").folder, row("<acc@x>").mailbox], [accented, accented], "and the sync keeps it filed under the name the server lists");
// Renamed by the name a person sees: found, and the new name encoded.
const renamed = await api("POST", "/api/folders/rename", { from: "Réunions & café", to: "Séminaires" });
eq([renamed.status, renamed.body?.name, renamed.body?.label], [200, "S&AOk-minaires", "Séminaires"], "renaming answers the new key and its label");
ok(imap.boxes.has("S&AOk-minaires") && !imap.boxes.has(accented) && row("<acc@x>").folder === "S&AOk-minaires", "the mailbox is renamed at the provider and its mail refiled under the new key");
// A nested mailbox keeps its parent as listed; only the new leaf is encoded.
imap.box("Clients/Old", BS + "HasNoChildren");
const nested = await api("POST", "/api/folders/rename", { from: "Clients/Old", to: "Été" });
eq([nested.status, nested.body?.name, nested.body?.label], [200, "Clients/&AMk-t&AOk-", "Clients/Été"], "a nested folder is renamed under its parent");
const dropped = await api("DELETE", `/api/folders/${encodeURIComponent("Clients/Été")}`);
eq([dropped.status, imap.boxes.has("Clients/&AMk-t&AOk-")], [200, false], "and can be named by its label to delete it");

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

// ── Plain text is shown as written, whatever it happens to spell ──
imap.add("INBOX", msg("<plain@x>", "Plain text that looks like markup", "", "see src=https://example.com/a and <b>this</b>, then href=javascript:x"));
for (let i = 0; i < 6; i++) await pass1("plain " + i);
const plainBody = JSON.parse(MAIL.map.get(`body/${row("<plain@x>").id}.json`)).html;
ok(
  plainBody.includes('src=<a href="https://example.com/a"') && plainBody.includes("&lt;b&gt;this&lt;/b&gt;") && /href=javascript:x\s*<\/div>$/.test(plainBody),
  "a plain-text message keeps its link, its escaped text and its wrapper: " + plainBody
);

// ── Reply-To travels with the stored body ──
imap.add("INBOX", msg("<rt@x>", "From a list", "Reply-To: =?UTF-8?Q?Zo=C3=A9?= <zoe@list.example>\r\n"));
// Past the size a Worker holds whole: only its headers and structure are read.
imap.add("INBOX", msg("<rtbig@x>", "A very large one", "Reply-To: big@list.example\r\n", "x".repeat(2 * 1024 * 1024 + 1000)));
for (let i = 0; i < 6; i++) await pass1("reply-to " + i);
const storedBody = (mid) => JSON.parse(MAIL.map.get(`body/${row(mid).id}.json`));
eq([storedBody("<rt@x>").replyTo, storedBody("<c@x>").replyTo], ["Zoé <zoe@list.example>", ""], "Reply-To is stored decoded, and empty when the message has none");
eq((await api("GET", `/api/messages/${row("<rt@x>").id}?peek=1`)).body?.body?.replyTo, "Zoé <zoe@list.example>", "and comes back with the message");
eq([storedBody("<rtbig@x>").tooLarge, storedBody("<rtbig@x>").replyTo], [true, "big@list.example"], "a message too large to hold keeps its Reply-To from the headers");
// The same message read again on demand, as when its stored body is lost.
MAIL.map.delete(`body/${row("<rtbig@x>").id}.json`);
const reread = await api("GET", `/api/messages/${row("<rtbig@x>").id}?peek=1`);
eq([reread.body?.body?.tooLarge, reread.body?.body?.replyTo], [true, "big@list.example"], "and when it is fetched again on opening");

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
// A time written with no zone is that hour wherever it is read, and the
// timeline has to be told so. The column is one an older database lacks.
ok(eventCols().includes("floating"), "the heal added events.floating to the old database");
const invite = (id, uid, dtstart) =>
  latin(
    `From: Zoé <zoe@x.fr>\r\nTo: me@example.com\r\nSubject: ${uid}\r\nDate: ${new Date((clock += 60_000)).toUTCString()}\r\nMessage-ID: ${id}\r\n` +
      `Content-Type: multipart/alternative; boundary="b2"\r\n\r\n--b2\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nYou are invited\r\n` +
      `--b2\r\nContent-Type: text/calendar; method=REQUEST; charset=utf-8\r\n\r\nBEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:${uid}\r\n` +
      `${dtstart}\r\nSUMMARY:${uid}\r\nORGANIZER:mailto:zoe@x.fr\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n--b2--\r\n`
  );
imap.add("INBOX", invite("<floats@x>", "floats", "DTSTART:20270115T090000"));
imap.add("INBOX", invite("<fixed@x>", "fixed", "DTSTART:20270115T090000Z"));
for (let i = 0; i < 6; i++) await pass1("floating " + i);
const shown = (await api("GET", "/api/timeline")).body?.events ?? [];
const startOf = (mid) => shown.find((e) => e.id === row(mid)?.id)?.start;
eq([startOf("<floats@x>")?.floating, startOf("<floats@x>")?.ms], [true, Date.UTC(2027, 0, 15, 9)], "a time with no zone reaches the timeline marked floating, at the hour written");
eq(startOf("<fixed@x>")?.floating, false, "and a time in UTC does not");
// Events indexed before the column existed are indexed again, once.
ok(DB.raw.prepare("SELECT value FROM settings WHERE key='migrations'").get().value.includes("events_floating"), "the timeline is re-seeded once so older invitations get the flag");
// An event indexed before links were held to https still has what it was given.
const eventUrl = async (stored) => {
  DB.raw.prepare("UPDATE events SET url=? WHERE id=?").run(stored, inv.id);
  return (await api("GET", "/api/timeline")).body.events.find((e) => e.id === inv.id)?.url;
};
eq([await eventUrl("javascript:alert(1)"), await eventUrl("https://meet.example/abc")], ["", "https://meet.example/abc"], "the timeline hands out an https link and nothing else");

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

// ── A send whose answer never came is not reported as a failure, nor sent twice ──
const { UNCERTAIN } = await import("../../src/outgoing.js");
const direct = (subject) => ({ account_id: "acct1", to: "zoe@x.fr", subject, text: "hi" });
smtp.drop = "after-data"; // the server takes the message, and the connection dies before its 250
const lost = await api("POST", "/api/send", direct("Lost answer"), { "Idempotency-Key": "lost-answer" });
smtp.drop = "";
eq([lost.status, lost.body?.uncertain, lost.body?.error, wentOut("Lost answer")], [504, true, UNCERTAIN, 1], "a connection lost after the message was handed over is answered as uncertain");
const pressedAgain = await api("POST", "/api/send", direct("Lost answer"), { "Idempotency-Key": "lost-answer" });
eq([pressedAgain.status, pressedAgain.body?.uncertain, pressedAgain.body?.repeat, wentOut("Lost answer")], [504, true, true, 1], "a second press with the same key gets the same answer, and nothing is sent again");
const decided = await api("POST", "/api/send", direct("Lost answer"), { "Idempotency-Key": "lost-answer-again" });
eq([decided.status, wentOut("Lost answer")], [202, 2], "sending it again under a new key does send it");
// A refusal is a plain failure: nothing went, nothing is remembered, and a retry sends.
smtp.drop = "refuse";
const refusedSend = await api("POST", "/api/send", direct("Refused"), { "Idempotency-Key": "refused" });
smtp.drop = "";
eq([refusedSend.status, !!refusedSend.body?.uncertain, wentOut("Refused")], [502, false, 0], "a message the server refuses is a failure, not an uncertainty: " + JSON.stringify(refusedSend.body));
eq([(await api("POST", "/api/send", direct("Refused"), { "Idempotency-Key": "refused" })).status, wentOut("Refused")], [202, 1], "and pressing Send again sends it");
// The cron does not try an uncertain delivery again by itself.
const unsure = await api("POST", "/api/send", { ...later, subject: "Unsure" });
DB.raw.prepare("UPDATE outbox SET at=? WHERE id=?").run(Date.now() - 1000, unsure.body.id);
smtp.drop = "after-data";
await flushOutbox(env);
smtp.drop = "";
eq([outboxRow(unsure.body.id)?.tries, outboxRow(unsure.body.id)?.last_error, wentOut("Unsure")], [5, UNCERTAIN, 1], "a scheduled message that may have gone stays listed, marked, and out of the cron's hands");
DB.raw.prepare("UPDATE outbox SET at=? WHERE id=?").run(Date.now() - 1000, unsure.body.id);
await flushOutbox(env);
eq(wentOut("Unsure"), 1, "the next cron does not send it a second time");
eq([(await api("POST", `/api/outbox/${unsure.body.id}/send`)).status, wentOut("Unsure"), !!outboxRow(unsure.body.id)], [202, 2, false], "Send now still does, when somebody decides to");
// The same when it was "Send now" that lost the answer.
const unsureNow = await api("POST", "/api/send", { ...later, subject: "Unsure now" });
smtp.drop = "after-data";
const nowLost = await api("POST", `/api/outbox/${unsureNow.body.id}/send`);
smtp.drop = "";
eq([nowLost.status, nowLost.body?.uncertain, outboxRow(unsureNow.body.id)?.tries], [504, true, 5], "Send now answers uncertain and parks the message");
DB.raw.prepare("UPDATE outbox SET at=? WHERE id=?").run(Date.now() - 1000, unsureNow.body.id);
await flushOutbox(env);
eq(wentOut("Unsure now"), 1, "so the cron does not send it again at its appointed time");
await api("POST", `/api/outbox/${unsureNow.body.id}/cancel`);

// ── Follow-ups ride the real send and the real sync ──
{
  const DAY = 86_400_000;
  const open = () => DB.raw.prepare("SELECT message_id, kind, state, due FROM followups ORDER BY created_at, message_id").all().map((r) => ({ ...r }));
  const sentRow = (subject) => DB.raw.prepare("SELECT * FROM messages WHERE folder='sent' AND subject=?").get(subject);
  const reminderFor = (id) => DB.raw.prepare("SELECT * FROM reminders WHERE kind='followup' AND ref=?").get(id);

  // Sent now: the follow-up is on the Sent copy, and counts its days from the send.
  const before = Date.now();
  const sentFu = await api("POST", "/api/send", { ...direct("Follow me"), followup_days: 3 });
  const s1 = sentRow("Follow me");
  eq([sentFu.status, sentFu.body?.followup], [202, true], "a send that asked for a reminder says one was set");
  eq(open().map((f) => [f.message_id, f.kind, f.state]), [[s1?.id, "noreply", "waiting"]], "it is attached to the Sent copy of that very message");
  ok(open()[0].due >= before + 3 * DAY && open()[0].due <= Date.now() + 3 * DAY, "due three days after the send");
  eq(reminderFor(s1.id), undefined, "and nothing rings yet");
  eq(s1.thread_key, s1.mid, "the Sent copy keys its conversation on its own Message-ID, which a reply will quote");

  // Scheduled: nothing exists until it has gone, and then it is attached to the copy that was filed.
  const sched = await api("POST", "/api/send", { ...later, subject: "Follow later", followup_days: 2 });
  eq([sched.status, open().length, !!sentRow("Follow later")], [202, 1, false], "a scheduled message has no follow-up before it goes");
  DB.raw.prepare("UPDATE outbox SET at=? WHERE id=?").run(Date.now() - 1000, sched.body.id);
  await flushOutbox(env);
  const s2 = sentRow("Follow later");
  eq(open().map((f) => f.message_id), [s1.id, s2?.id], "the outbox's delivery attaches it to its own Sent copy");

  // A refusal and an uncertain answer go nowhere, so nothing is attached.
  smtp.drop = "refuse";
  const refused = await api("POST", "/api/send", { ...direct("Follow refused"), followup_days: 3 });
  smtp.drop = "after-data";
  const lostFu = await api("POST", "/api/send", { ...direct("Follow lost"), followup_days: 3 });
  smtp.drop = "";
  eq([refused.status, lostFu.status, sentRow("Follow refused"), sentRow("Follow lost"), open().length], [502, 504, undefined, undefined, 2], "a send that failed, or may not have gone, sets no follow-up");

  // Somebody answers: the sync stores the reply and the cron cancels the follow-up, quietly.
  const reply = latin(
    `From: Zoé <zoe@x.fr>\r\nTo: me@example.com\r\nSubject: Re: Follow me\r\nDate: ${new Date(Date.now() + 60_000).toUTCString()}\r\nMessage-ID: <fu-reply@x>\r\n` +
      `In-Reply-To: ${s1.mid}\r\nReferences: ${s1.mid}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nyes\r\n`
  );
  imap.add("INBOX", reply);
  for (let i = 0; i < 4; i++) await pass1("follow-up reply " + i);
  eq(row("<fu-reply@x>")?.thread_key, s1.mid, "the reply lands in the conversation of the message you sent");
  eq(open().map((f) => f.message_id), [s2.id], "the reply cancels that follow-up and not the other");
  eq(reminderFor(s1.id), undefined, "with nothing to ring");

  // The star is taken off on another device: the sync notices, and the follow-up ends.
  const F = imap.add("INBOX", msg("<fu-flag@x>", "Flag me"), [SEEN]);
  for (let i = 0; i < 3; i++) await pass1("follow-up flag " + i);
  const flagged = await api("POST", "/api/followups", { message_id: row("<fu-flag@x>").id, kind: "flag", due: Date.now() + DAY });
  eq(flagged.status, 200, "a flag follow-up is set through the route: " + JSON.stringify(flagged.body));
  ok(imap.find("INBOX", F.uid).flags.has(BS + "Flagged"), "and the message is starred at the provider");
  ok(reminderFor(row("<fu-flag@x>").id), "with its reminder");
  imap.setFlag("INBOX", F.uid, BS + "Flagged", false);
  for (let i = 0; i < 3; i++) await pass1("follow-up unflag " + i);
  eq(row("<fu-flag@x>").starred, 0, "the sync takes the star off here");
  eq([open().some((f) => f.message_id === row("<fu-flag@x>").id), reminderFor(row("<fu-flag@x>").id)], [false, undefined], "and the follow-up and its reminder go with it");

  // Leave nothing behind, so later sections see the world they expect.
  DB.raw.exec("DELETE FROM followups; DELETE FROM reminders WHERE kind='followup'");
}

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
  // Nothing is pinned, important or categorised yet at this point. The fields
  // are written in rather than aggregated: a second MAX() would let SQLite
  // take the bare columns from a different row than the newest.
  return DB.raw.prepare(sql).all(...vals, 100).map(({ folder, has_body, n, ...head }) => ({ ...head, pinned: 0, importance: 0, folder, has_body, n, cats: [] }));
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

// Categories: on one message, the conversation's row shows it; on the whole
// conversation, every message has it; taking it off leaves nothing behind.
const catOne = await api("POST", `/api/messages/${row("<p1@x>").id}/categories`, { add: [3] });
eq([catOne.status, catOne.body.cats], [200, [3]], "a category goes on one message");
eq((await listOf("folder=inbox&limit=100")).find((m) => m.thread_key === "<p1@x>")?.cats, [3], "the conversation's row shows a category one of its messages has");
const catAll = await api("POST", `/api/messages/${row("<p3@x>").id}/categories`, { add: [5], thread: true });
eq(catAll.status, 200, "with thread, the whole conversation takes it");
eq(DB.raw.prepare("SELECT COUNT(*) AS n FROM message_categories WHERE category_id=5").get().n, 3, "every message of it");
await api("POST", `/api/messages/${row("<p3@x>").id}/categories`, { remove: [3, 5], thread: true });
eq(DB.raw.prepare("SELECT COUNT(*) AS n FROM message_categories").get().n, 0, "removing takes them off again");
const pinRes = await api("POST", `/api/messages/${row("<p3@x>").id}/pin`, { pinned: true });
eq([pinRes.status, pinRes.body.n], [200, 3], "a pin goes on the whole conversation");
eq((await listOf("folder=inbox&limit=100"))[0].thread_key, "<p1@x>", "and the pinned conversation leads the list");
await api("POST", `/api/messages/${row("<p3@x>").id}/pin`, { pinned: false });
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
const { runBackup, latestBackup, restoreBackup } = await import("../../src/backup.js");
const backupKeys = () => [...MAIL.map.keys()].filter((k) => k.startsWith("backup/")).sort();
const manifests = () => backupKeys().filter((k) => k.endsWith("/manifest.json"));
const folderOf = (manifestKey) => manifestKey.replace(/manifest\.json$/, "");
const held = (key) => JSON.parse(MAIL.map.get(key));
// A table longer than one part, so the split is the real one.
DB.raw.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 4100) INSERT INTO contacts_hidden (email, created_at) SELECT 'bulk' || i || '@x.fr', i FROM n");
const good = await runBackup(env, Date.now() - 86_400_000);
eq(good.counts.messages, count(), "a snapshot holds every message row");
ok(["image_senders", "revoked_sessions", "events"].every((t) => t in good.counts), "and the tables a restore needs: " + Object.keys(good.counts).join(","));
// Written in parts, with the manifest naming each of them.
const manifest = held(good.key);
eq([manifests(), backupKeys().length], [[good.key], manifest.parts.length + 1], "a snapshot is its parts and one manifest, all under one stamp");
ok(backupKeys().every((k) => k.startsWith(folderOf(good.key))), "nothing else is held under backup/");
eq(manifest.parts.filter((p) => p.table === "contacts_hidden").map((p) => p.rows), [2000, 2000, 100], "a table of 4100 rows is written as parts of at most 2000");
ok(manifest.parts.every((p) => held(p.key).length === p.rows && p.rows <= 2000), "each part holds the rows the manifest says it does");
eq(manifest.parts.filter((p) => p.table === "messages").reduce((n, p) => n + p.rows, 0), count(), "the parts of messages add up to every message");
const realPrepare = DB.prepare;
DB.prepare = (sql) => {
  if (/FROM messages WHERE rowid/.test(sql)) throw new Error("D1_ERROR: Network connection lost");
  return realPrepare(sql);
};
const partial = await runBackup(env, Date.now()).then(() => "written", (e) => String(e.message));
DB.prepare = realPrepare;
ok(/connection lost/.test(partial), "a read that fails halfway fails the snapshot: " + partial);
eq(manifests(), [good.key], "and the last complete snapshot is still the one held");
ok(backupKeys().every((k) => k.startsWith(folderOf(good.key))), "with none of the failed run's parts left beside it");
// Parts a run left behind without a manifest are not a snapshot.
MAIL.map.set("backup/9999-01-01T00-00-00-000Z/messages-0.json", "[]");
const latest = (await api("GET", "/api/backup")).body.latest;
eq([latest.key, latest.messages, latest.kept], [good.key, count(), 1], "the newest manifest is the snapshot held, whatever lies beside it");
eq(latest.bytes, backupKeys().filter((k) => k.startsWith(folderOf(good.key))).reduce((n, k) => n + Buffer.byteLength(MAIL.map.get(k)), 0), "its size is the size of all its parts");
// Restoring brings back what has gone missing, a part at a time, and nothing else.
const beforeLoss = count();
DB.raw.exec("DELETE FROM messages WHERE folder='archive'");
DB.raw.exec("DELETE FROM contacts_hidden WHERE created_at > 1500");
ok(count() < beforeLoss, "some rows are lost");
const back = await api("POST", "/api/backup/restore", { confirm: "restore" });
eq([back.status, back.body?.key, count(), back.body?.restored?.contacts_hidden], [200, good.key, beforeLoss, 2600], "a restore puts back exactly the rows that were missing");
eq((await restoreBackup(env)).restored.messages, 0, "and a second one changes nothing");
// A part that is gone is said, before anything is written.
const lostPart = manifest.parts.find((p) => p.table === "messages").key;
const lostBody = MAIL.map.get(lostPart);
MAIL.map.delete(lostPart);
DB.raw.exec("DELETE FROM contacts_hidden WHERE created_at > 4000");
const incomplete = await api("POST", "/api/backup/restore", { confirm: "restore" });
ok(incomplete.status === 502 && /incomplete/.test(incomplete.body?.error || ""), "a snapshot with a part missing is refused: " + JSON.stringify(incomplete.body));
eq(DB.raw.prepare("SELECT COUNT(*) n FROM contacts_hidden").get().n, 4000, "and nothing was restored from the rest of it");
MAIL.map.set(lostPart, lostBody);
// A single file from before this layout is still restored when it is the newest thing held.
MAIL.map.delete("backup/9999-01-01T00-00-00-000Z/messages-0.json");
const legacyKey = `backup/dmzs-mail-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
await MAIL.put(legacyKey, JSON.stringify({ version: 1, takenAt: "then", tables: { contacts_added: [{ email: "old@x.fr", name: "Old", created_at: 1 }] } }), { customMetadata: { messages: "7" } });
const legacyLatest = await latestBackup(env);
eq([legacyLatest.key, legacyLatest.messages, legacyLatest.kept], [legacyKey, 7, 2], "a newer single-file snapshot is the latest");
const fromLegacy = await restoreBackup(env);
eq([fromLegacy.key, fromLegacy.restored.contacts_added, !!DB.raw.prepare("SELECT 1 FROM contacts_added WHERE email='old@x.fr'").get()], [legacyKey, 1, true], "and it is restored from");
// The next good snapshot replaces all of it, however many listings that takes.
MAIL.pageSize = 3;
DB.raw.exec("DROP TABLE events");
const grown = await runBackup(env, Date.now());
MAIL.pageSize = 1000;
eq([grown.counts.events, grown.counts.messages], [0, count()], "a table the database does not have yet is skipped, not fatal");
eq(manifests(), [grown.key], "the new snapshot is the only one left");
ok(backupKeys().every((k) => k.startsWith(folderOf(grown.key))) && grown.removed === manifest.parts.length + 2, "the old parts and the single file are pruned, across listing pages: removed " + grown.removed);
MAIL.pageSize = 3;
eq((await latestBackup(env))?.key, grown.key, "and it is found through a listing that comes in pages");
MAIL.pageSize = 1000;

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

// ── Search operators over mail that really went through the sync ──
// Three new messages: one with a file, one with only an inline logo, one with
// nothing. The first is the only one has:attachment may find.
const mime = (id, subject, parts) =>
  latin(
    `From: Zoé <zoe@x.fr>\r\nTo: me@example.com\r\nSubject: ${subject}\r\nDate: ${new Date((clock += 60_000)).toUTCString()}\r\nMessage-ID: ${id}\r\nMIME-Version: 1.0\r\n` +
      `Content-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nle devis est prêt\r\n${parts}--B--\r\n`
  );
imap.add("INBOX", mime("<att@x>", "Devis joint", `--B\r\nContent-Type: application/pdf; name="devis-2026.pdf"\r\nContent-Disposition: attachment; filename="devis-2026.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0=\r\n`));
imap.add("INBOX", mime("<logo@x>", "Devis logo", `--B\r\nContent-Type: image/png; name="logo.png"\r\nContent-Disposition: inline; filename="logo.png"\r\nContent-ID: <logo1>\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0=\r\n`));
imap.add("INBOX", msg("<none@x>", "Devis seul", "", "le devis est prêt"));
for (let i = 0; i < 3; i++) await pass1("attachments " + i);
eq([row("<att@x>").att_names, row("<logo@x>").att_names, row("<none@x>").att_names], ["devis-2026.pdf", "", ""], "a newly synced message records its attachment names; an inline logo and a plain mail record none");

const cookie = signedIn.cookie.split(";")[0];
const searchIds = async (q) => {
  const res = await worker.fetch(new Request(`http://x/api/messages?folder=all&limit=100&tz=-120&q=${encodeURIComponent(q)}`, { headers: { Cookie: cookie } }), env, { waitUntil() {} });
  return (await res.json()).messages.map((m) => m.subject).sort();
};
eq(await searchIds("devis"), ["Devis joint", "Devis logo", "Devis seul"], "the route still searches plain words");
eq(await searchIds("devis has:attachment"), ["Devis joint"], "has:attachment finds the message synced with a file, and not the other two");
eq(await searchIds("attachment:2026"), ["Devis joint"], "attachment:name finds it by file name");
eq(await searchIds("devis from:zoe is:unread -joint"), ["Devis logo", "Devis seul"], "operators and a negative together, through the route");

// Mail stored before the column existed has no answer until the cron reaches
// it: it matches neither operator, and then it does.
DB.raw.prepare("UPDATE messages SET att_names=NULL WHERE mid='<att@x>'").run();
eq(await searchIds("devis has:attachment"), [], "a message whose attachments are unknown is not found by has:attachment");
await pass1("backfill");
eq(row("<att@x>").att_names, "devis-2026.pdf", "the backfill reads the names back from the stored body");
eq(await searchIds("devis has:attachment"), ["Devis joint"], "and then has:attachment finds it");
eq(DB.raw.prepare("SELECT COUNT(*) n FROM messages WHERE att_names IS NULL").get().n, 0, "nothing is left waiting");

console.log(`${fail ? "✗" : "✓"} ${pass} assertions passées, ${fail} échec(s) (caps ${caps.join(" ")})`);
process.exit(fail ? 1 : 0);
