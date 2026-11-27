/**
 * Rules through the real sync, against the same in-process fakes as run.mjs:
 * what a rule does to mail as it arrives, proven at the IMAP server and in
 * the database, and that it rings nothing. run.mjs starts this once per mode.
 *
 *   node --no-warnings scripts/sync-harness/rules.mjs <caps>
 */
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
const { makeD1, makeR2, FakeImap, FakeSmtp, BS } = await import("./fake.mjs");
const caps = (process.argv[2] || "IMAP4rev1,UIDPLUS,MOVE,CONDSTORE").split(",");
const { default: worker } = await import("../../src/index.js");
const { seal } = await import("../../src/crypto.js");
const { ensureSchema } = await import("../../src/schema.js");

let pass = 0, fail = 0;
const ok = (c, label) => (c ? pass++ : (fail++, console.log("  ✗ " + label)));
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), `${label}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const sqlLog = [];
const DB = makeD1(sqlLog);
const MAIL = makeR2();
const imap = new FakeImap({ caps });
globalThis.__fakeConnect = (addr) => (addr?.port === 587 ? new FakeSmtp().connect() : imap.connect());
const random = (n) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("base64");
const ENC_KEY = random(32);
const env = { DB, MAIL, ENC_KEY, APP_URL: "http://x", AUTH_SECRET: random(32), BOOTSTRAP_KEY: random(24) };

let clock = Date.now() - 3_600_000;
const msg = (id, subject, from = "Zoé <zoe@x.fr>", flagsHeader = "") =>
  Buffer.from(
    `From: ${from}\r\nTo: me@example.com\r\nSubject: ${subject}\r\nDate: ${new Date((clock += 60_000)).toUTCString()}\r\nMessage-ID: ${id}\r\n${flagsHeader}Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nhello\r\n`,
    "utf8"
  ).toString("latin1");

imap.box("INBOX", BS + "HasNoChildren");
imap.box("Sent Messages", BS + "HasNoChildren " + BS + "Sent");
imap.box("Deleted Messages", BS + "HasNoChildren " + BS + "Trash");
imap.box("Newsletters", BS + "HasNoChildren");
imap.box("Broken", BS + "HasNoChildren");
const SEEN = BS + "Seen";
const FLAGGED = BS + "Flagged";

await ensureSchema(env);
DB.raw.prepare("INSERT INTO accounts (id, provider, email, label, secret, created_at) VALUES (?,?,?,?,?,?)").run(
  "acct1", "icloud", "me@example.com", "", await seal(ENC_KEY, { password: "not-a-real-password" }), Date.now()
);

const signIn = await worker.fetch(
  new Request("http://x/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ k: env.BOOTSTRAP_KEY }) }),
  env,
  { waitUntil() {} }
);
const cookie = (signIn.headers.get("Set-Cookie") || "").split(";")[0];
const api = async (method, path, body) => {
  const res = await worker.fetch(
    new Request("http://x" + path, { method, headers: { Cookie: cookie, "X-Client": "ext-harness", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }),
    env,
    { waitUntil() {} }
  );
  return { status: res.status, body: await res.json() };
};
ok(cookie, "signed in");

let pushes = 0;
async function sync(label) {
  const before = sqlLog.length;
  const waits = [];
  await worker.scheduled({ cron: "* * * * *" }, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  const acct = DB.raw.prepare("SELECT last_error FROM accounts").get();
  if (acct.last_error) console.log(`  [${label}] account error: ${acct.last_error}`);
  pushes = sqlLog.slice(before).filter((s) => s.includes("FROM push_subs")).length;
}
const row = (mid) => DB.raw.prepare("SELECT * FROM messages WHERE mid=?").get(mid);
const at = (box, mid) => imap.box(box).msgs.find((m) => m.raw.includes(`Message-ID: ${mid}`));
const rule = (name) => DB.raw.prepare(`SELECT * FROM rules WHERE name=?`).get(name);
const rules = async () => (await api("GET", "/api/rules")).body.rules;

// ── the rules, made through the routes ──
const mk = async (name, conditions, actions, extra = {}) =>
  eq((await api("POST", "/api/rules", { name, conditions, actions, ...extra })).status, 201, `rule "${name}" created`);
await mk("News", [{ field: "from", op: "contains", value: "news@" }], [{ type: "move", value: "Newsletters" }]);
await mk("Receipts", [{ field: "subject", op: "contains", value: "receipt" }], [{ type: "read" }, { type: "star" }]);
await mk("Breaks", [{ field: "subject", op: "contains", value: "boom" }], [{ type: "move", value: "Broken" }]);
await mk("Junk", [{ field: "subject", op: "contains", value: "junk" }], [{ type: "trash" }]);

// ── the first read of the inbox is not an arrival ──
// A message that matches a rule, sitting in the inbox before the sync ever
// looked: history, not mail that has just come.
imap.add("INBOX", msg("<old@x>", "Old digest", "News <news@x.org>"));
for (let i = 0; i < 3; i++) await sync("first read " + i);
eq(row("<old@x>")?.folder, "inbox", "mail already in the inbox at the first read is left alone, though a rule matches it");
ok(at("INBOX", "<old@x>"), "and is still in the inbox at the server");
eq(rule("News").n, 0, "and counts nothing");

// ── new mail: a move, two flags, and a control ──
const oldUid = at("INBOX", "<old@x>").uid;
imap.add("INBOX", msg("<news@x>", "Weekly", "News <news@x.org>"));
imap.add("INBOX", msg("<rcpt@x>", "Your receipt", "Shop <shop@x.org>"));
imap.add("INBOX", msg("<junk@x>", "junk offer", "Spam <spam@x.org>"));
// Mail arriving in Sent matches the rules too, and is nobody's to sort.
imap.add("Sent Messages", msg("<sent@x>", "receipt for news", "Me <news@x.org>"), [SEEN]);
imap.log.length = 0;
await sync("arrivals");

const gone = (box, mid) => !at(box, mid);
ok(at("Newsletters", "<news@x>") && gone("INBOX", "<news@x>"), "a new inbox message matching a move rule is in the target mailbox at the server, and no longer in the inbox");
eq(row("<news@x>").folder, "Newsletters", "and filed under that folder here");
const rc = at("INBOX", "<rcpt@x>");
ok(rc.flags.has(SEEN) && rc.flags.has(FLAGGED), "'mark read and star' leaves both flags at the server");
eq([row("<rcpt@x>").unread, row("<rcpt@x>").starred, row("<rcpt@x>").folder], [0, 1, "inbox"], "and both here, in the inbox still");
ok(at("Deleted Messages", "<junk@x>") && gone("INBOX", "<junk@x>"), "the Trash action moves it to the Trash mailbox at the server");
eq(row("<junk@x>").folder, "trash", "and files it under trash here");
eq(row("<old@x>").folder, "inbox", "the history message is still untouched");
eq([row("<sent@x>").folder, at("Sent Messages", "<sent@x>").flags.has(FLAGGED)], ["sent", false], "mail arriving in Sent is untouched, here and at the server");
eq(pushes, 0, "mail a rule moved or marked read rings nothing");
eq([rule("News").n, rule("Receipts").n, rule("Junk").n, rule("Breaks").n], [1, 1, 1, 0], "each rule counts what it did");
eq([rule("News").last_error, rule("News").last_at > 0], [null, true], "and a rule that worked has no error");

// The commands a rule issued, for checking one by hand.
const issued = imap.log.filter((l) => /^UID (STORE|MOVE)/.test(l));
ok(issued.some((l) => l === `UID STORE ${rc.uid} +FLAGS (${SEEN})`) && issued.some((l) => l === `UID STORE ${rc.uid} +FLAGS (${FLAGGED})`), "flags are set with UID STORE +FLAGS");
ok(issued.some((l) => /^UID MOVE \d+ "Newsletters"$/.test(l)) && issued.some((l) => /^UID MOVE \d+ "Deleted Messages"$/.test(l)), "moves are UID MOVE to the resolved mailbox name");
ok(!imap.log.some((l) => /EXPUNGE/.test(l)), "and nothing is expunged");
console.log("  commands issued: " + issued.join(" | "));

// ── not again ──
const movesBefore = imap.log.filter((l) => /^UID MOVE/.test(l)).length;
for (let i = 0; i < 3; i++) await sync("again " + i);
eq(imap.log.filter((l) => /^UID MOVE/.test(l)).length, movesBefore, "later syncs move nothing more");
eq([rule("News").n, rule("Receipts").n, rule("Junk").n], [1, 1, 1], "and the counts do not grow");
eq(row("<news@x>").folder, "Newsletters", "the moved message, seen again in its new mailbox, stays filed there");
// Put back in the inbox from another device: the sync sees it come back, and a
// message it already knows is not new mail.
const back = at("Newsletters", "<news@x>");
imap.move("Newsletters", back.uid, "INBOX");
for (let i = 0; i < 2; i++) await sync("moved back " + i);
eq(row("<news@x>").folder, "inbox", "a message moved back into the inbox elsewhere is filed there");
ok(at("INBOX", "<news@x>"), "and the rule does not take it out again");
eq(rule("News").n, 1, "or count it twice");

// ── a failure at iCloud ──
imap.refuse = /^UID MOVE \d+ "Broken"$/;
imap.add("INBOX", msg("<boom@x>", "boom goes the move", "Zed <zed@x.org>"));
imap.add("INBOX", msg("<news2@x>", "Weekly again", "News <news@x.org>"));
await sync("failure");
ok(at("INBOX", "<boom@x>") && gone("Broken", "<boom@x>"), "when the server refuses the move, the message is still in the inbox at the server");
eq(row("<boom@x>")?.folder, "inbox", "and here");
ok(/./.test(rule("Breaks").last_error || ""), "the error is recorded on the rule: " + rule("Breaks").last_error);
eq(rule("Breaks").n, 0, "which has not acted");
ok(at("Newsletters", "<news2@x>"), "and the rest of the sync completes: the next message's rule still moved it");
eq(row("<news2@x>")?.folder, "Newsletters", "and filed it");
eq((await rules()).find((r) => r.name === "Breaks").last_error.length > 0, true, "the list shows the error");
ok(pushes >= 1, "a message that stayed unread in the inbox rings as ever");
const acct = DB.raw.prepare("SELECT status, last_error FROM accounts").get();
eq([acct.status, acct.last_error], ["ok", null], "the account is not flagged: a rule's failure is not the sync's");

// ── Run rules now ──
imap.refuse = null;
imap.log.length = 0;
const ran = await api("POST", "/api/rules/run", {});
// Three inbox messages match a rule and have not been dealt with: the one whose
// move was refused, the history message, and the one put back from elsewhere.
eq([ran.status, ran.body.changed, ran.body.failed, ran.body.next], [200, 3, 0, null], "run now applies the rules to what is in the inbox: three messages changed");
ok(at("Newsletters", "<old@x>") && gone("INBOX", "<old@x>"), "it takes in the history message the sync rightly left alone");
ok(at("Newsletters", "<news@x>") && gone("INBOX", "<news@x>"), "and the one moved back");
ok(at("Broken", "<boom@x>") && gone("INBOX", "<boom@x>"), "the message that failed before is moved now");
eq(row("<boom@x>").folder, "Broken", "and filed here");
eq([rule("Breaks").n, rule("Breaks").last_error], [1, null], "its rule counts it and loses its error");
ok(imap.log.some((l) => /^UID SEARCH HEADER "Message-ID" "<boom@x>"$/.test(l)), "run now finds the message again by Message-ID: " + imap.log.filter((l) => /SEARCH HEADER|MOVE/.test(l)).join(" | "));
eq((await api("POST", "/api/rules/run", {})).body.changed, 0, "and a second run changes nothing");
eq(rule("News").n, 4, "News counts every message it moved: two as they arrived and two from the run");

console.log(`${fail ? "✗" : "✓"} rules ${pass} assertions, ${fail} failed (caps ${caps.join(" ")})`);
process.exit(fail ? 1 : 0);
