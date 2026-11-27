/**
 * Follow-up (src/followup.js) against a real SQLite with a clock the test
 * moves. Every outcome is read back through the reminders table, which is what
 * would ring a phone.
 *
 * Starring at iCloud is the one thing replaced (deps.star): there is no IMAP
 * server here. The send path, with a real SMTP and IMAP fake, is checked in
 * scripts/sync-harness/run.mjs.
 */
import { register } from "node:module";
import { eq, ok } from "./harness.mjs";

register("../scripts/sync-harness/hooks.mjs", import.meta.url);
const { makeD1, makeR2 } = await import("../scripts/sync-harness/fake.mjs");
const { SCHEMA } = await import("../src/schema.js");
const { handleApi } = await import("../src/api.js");
const { MODULES } = await import("../src/modules.js");
const { remindersModule } = await import("../src/reminders.js");
const { followupModule, deps, sweep, followupForSent } = await import("../src/followup.js");
const { forgetMessages } = await import("../src/store.js");
const { parseSearch } = await import("../src/query.js");

const log = [];
const DB = makeD1(log);
for (const s of SCHEMA) DB.raw.exec(s);
const env = { DB, MAIL: makeR2(), ENC_KEY: "x", APP_URL: "http://x" };

const realNow = Date.now;
let clock = Date.UTC(2026, 5, 1, 9, 0, 0);
Date.now = () => clock;
const MIN = 60_000;
const DAY = 86_400_000;

// The only outside call: the star, here and at iCloud.
const realStar = deps.star;
deps.star = async (e, id, on) => {
  e.DB.raw.prepare("UPDATE messages SET starred=? WHERE id=?").run(on ? 1 : 0, id);
};

const hex = (n) => n.toString(16).padStart(16, "0");
DB.raw.prepare("INSERT INTO accounts (id, provider, email, label, created_at) VALUES ('acct1','icloud','me@example.com','',0)").run();
DB.raw.prepare("INSERT INTO settings (key, value) VALUES ('aliases_acct1', ?)").run(JSON.stringify(["alias@example.com"]));
let n = 0;
const put = (o) => {
  const id = hex(++n);
  const r = { folder: "inbox", from_email: "zoe@x.fr", from_name: "Zoe", thread_key: "", subject: "Subject " + n, to_line: "", date: clock, starred: 0, ...o };
  DB.raw
    .prepare("INSERT INTO messages (id, account_id, pid, folder, from_email, from_name, thread_key, subject, to_line, date, starred, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,0)")
    .run(id, "acct1", "p" + id, r.folder, r.from_email, r.from_name, r.thread_key, r.subject, r.to_line, r.date, r.starred);
  return id;
};
const sent = (thread, extra = {}) => put({ folder: "sent", from_email: "me@example.com", from_name: "Me", thread_key: thread, to_line: "zoe@x.fr", ...extra });

const call = async (method, path, body) => {
  const res = await handleApi(new Request("http://x" + path, { method, body: body ? JSON.stringify(body) : undefined }), env, path, undefined, undefined);
  return { status: res.status, body: await res.json() };
};
const open = () => DB.raw.prepare("SELECT message_id, kind, state, due FROM followups ORDER BY message_id").all().map((r) => ({ ...r }));
const reminder = (id) => DB.raw.prepare("SELECT * FROM reminders WHERE kind='followup' AND ref=?").get(id);
const starred = (id) => DB.raw.prepare("SELECT starred FROM messages WHERE id=?").get(id).starred;
const cron = async () => {
  await followupModule.cron(env);
  await remindersModule.cron(env);
};
const reset = () => {
  DB.raw.exec("DELETE FROM followups; DELETE FROM reminders; DELETE FROM messages");
};
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(null, { status: 201 });

try {
  ok(MODULES.includes(followupModule), "the module is registered");
  ok(followupModule.tables.includes("followups"), "its table is in the snapshot");

  /* ── nothing open costs one read ── */
  {
    const before = log.length;
    await sweep(env);
    eq(log.length - before, 1, "a sweep with nothing open is one query");
  }

  /* ── a flag follow-up reminds at its time ── */
  {
    const m = put({ subject: "Contract", thread_key: "<c@x>" });
    const due = clock + 2 * 60 * MIN;
    const set = await call("POST", "/api/followups", { message_id: m, kind: "flag", due });
    eq(set.status, 200, "setting a flag follow-up is accepted");
    eq(starred(m), 1, "the message is starred");
    eq([reminder(m)?.at, reminder(m)?.fired_at], [due, null], "a reminder waits for its time");
    eq(open().map((f) => [f.kind, f.state]), [["flag", "waiting"]], "one open follow-up, waiting");
    clock = due - MIN;
    await cron();
    eq(reminder(m).fired_at, null, "nothing rings before the time");
    clock = due + 1;
    await cron();
    ok(reminder(m).fired_at !== null, "the reminder fires at its time");
    eq(open()[0].state, "reminded", "and the follow-up is reminded");
    eq((await call("GET", "/api/reminders")).body.reminders.map((r) => r.title), ["Follow up: Contract"], "it is listed as due");
    eq((await call("GET", "/api/followups")).body.followups.length, 1, "and still open until you complete it");
    // Mark complete.
    eq((await call("POST", `/api/followups/${m}/complete`)).status, 200, "Mark complete answers ok");
    eq([open(), reminder(m)], [[], undefined], "complete: the follow-up and its reminder are gone");
    eq(starred(m), 1, "the star is left as the user's");
    eq((await call("POST", `/api/followups/${m}/complete`)).status, 200, "completing it again is fine");
    reset();
  }

  /* ── noreply: cancelled by a reply, not by your own words ── */
  {
    const s = sent("<t1@x>", { date: clock });
    const days3 = clock + 3 * DAY;
    eq((await call("POST", "/api/followups", { message_id: s, kind: "noreply", due: days3 })).status, 200, "a noreply follow-up on a sent message is accepted");
    eq([reminder(s), starred(s)], [undefined, 0], "no reminder yet and no star: it only rings if nobody answers");

    // Your own second message, and one from your alias: neither is an answer.
    clock += 60 * MIN;
    put({ folder: "sent", from_email: "me@example.com", thread_key: "<t1@x>", date: clock });
    put({ folder: "inbox", from_email: "Alias@Example.com", thread_key: "<t1@x>", date: clock + 1 });
    // A draft is not an answer, and neither is an older message.
    put({ folder: "drafts", from_email: "zoe@x.fr", thread_key: "<t1@x>", date: clock + 2 });
    put({ folder: "inbox", from_email: "zoe@x.fr", thread_key: "<t1@x>", date: clock - 5 * DAY });
    await cron();
    eq(open().map((f) => f.state), ["waiting"], "your own second message and your alias do not cancel it");

    // Someone else answers.
    clock += 60 * MIN;
    put({ folder: "inbox", from_email: "zoe@x.fr", thread_key: "<t1@x>", date: clock });
    await cron();
    eq([open(), reminder(s)], [[], undefined], "a reply from someone else cancels it, with no reminder");
    clock = days3 + DAY;
    await cron();
    eq((await call("GET", "/api/reminders")).body.count, 0, "and nothing ever rings for it");
    eq(starred(s), 0, "the message was never starred");
    reset();
  }

  /* ── noreply: fires when nobody answered ── */
  {
    const s = sent("<t2@x>", { subject: "Quote", to_line: "zoe@x.fr" });
    const due = clock + 2 * DAY;
    await call("POST", "/api/followups", { message_id: s, kind: "noreply", due });
    // An unrelated conversation, answered, changes nothing here.
    put({ thread_key: "<other@x>", date: clock + 1 });
    clock = due - MIN;
    await cron();
    eq([open()[0].state, reminder(s)], ["waiting", undefined], "still waiting a minute before");
    clock = due + 1;
    await cron();
    eq([open()[0].state, starred(s)], ["reminded", 1], "at its time it is starred and reminded");
    const r = reminder(s);
    ok(r && r.fired_at !== null && /No reply yet: Quote/.test(r.title) && /Nobody has replied/.test(r.body), "the reminder says nobody has replied");
    // A reply arriving after the reminder does not take it back.
    put({ thread_key: "<t2@x>", date: clock + 10 });
    await cron();
    eq(open().map((f) => f.state), ["reminded"], "a late reply leaves the reminder alone");

    // Taking the star off, in a sync, ends it.
    DB.raw.prepare("UPDATE messages SET starred=0 WHERE id=?").run(s);
    await cron();
    eq([open(), reminder(s)], [[], undefined], "removing the star (as a sync would) clears it and its reminder");
    reset();
  }

  /* ── a failed star leaves it waiting to be tried again ── */
  {
    const s = sent("<t3@x>");
    await call("POST", "/api/followups", { message_id: s, kind: "noreply", due: clock + MIN });
    clock += 2 * MIN;
    const ok1 = deps.star;
    deps.star = async () => { throw new Error("iCloud is down"); };
    const lines = [];
    const logSave = console.log;
    console.log = (x) => lines.push(x);
    await cron();
    console.log = logSave;
    eq([open()[0].state, reminder(s)], ["waiting", undefined], "iCloud refusing the star keeps it waiting, not reminded unstarred");
    ok(lines.some((l) => /iCloud is down/.test(l)), "and the reason is logged");
    deps.star = ok1;
    await cron();
    eq(open()[0].state, "reminded", "the next minute it goes through");
    reset();
  }

  /* ── clearing: un-star, delete, complete, each through the reminders table ── */
  {
    // Un-starring through the flag route's hook.
    const { onUnstar } = await import("../src/followup.js");
    const a = put({});
    await call("POST", "/api/followups", { message_id: a, kind: "flag", due: clock + DAY });
    ok(reminder(a), "a reminder is set");
    ok(await onUnstar(env, a), "taking the star off moves it");
    eq([open(), reminder(a)], [[], undefined], "un-starring clears the follow-up and its reminder");

    // Deleting the message, through forgetMessages.
    const b = put({});
    await call("POST", "/api/followups", { message_id: b, kind: "flag", due: clock + DAY });
    const c = sent("<t4@x>");
    await call("POST", "/api/followups", { message_id: c, kind: "noreply", due: clock + DAY });
    await forgetMessages(env, [b, c]);
    eq([open(), reminder(b), reminder(c)], [[], undefined, undefined], "deleting the messages clears the follow-ups and their reminders");

    // A message deleted by a path that does not know about follow-ups.
    const d = put({});
    await call("POST", "/api/followups", { message_id: d, kind: "flag", due: clock + DAY });
    DB.raw.prepare("DELETE FROM messages WHERE id=?").run(d);
    await cron();
    eq([open(), reminder(d)], [[], undefined], "a message deleted behind its back is noticed by the next sweep");

    // Mark complete on one that has not rung yet.
    const e = put({});
    await call("POST", "/api/followups", { message_id: e, kind: "flag", due: clock + DAY });
    await call("POST", `/api/followups/${e}/complete`);
    eq([open(), reminder(e)], [[], undefined], "Mark complete clears one that is still waiting");
    reset();
  }

  /* ── one follow-up per message ── */
  {
    const m = put({});
    const due = clock + DAY;
    await call("POST", "/api/followups", { message_id: m, kind: "flag", due });
    await call("POST", "/api/followups", { message_id: m, kind: "flag", due });
    eq([open().length, DB.raw.prepare("SELECT COUNT(*) n FROM reminders").get().n], [1, 1], "setting it twice leaves one follow-up and one reminder");
    await call("POST", "/api/followups", { message_id: m, kind: "flag", due: due + DAY });
    eq([open().length, open()[0].due, reminder(m).at], [1, due + DAY, due + DAY], "setting it again with a new time moves it");
    // A reminded one set again with the same time stays reminded.
    clock = due + DAY + 1;
    await cron();
    await call("POST", "/api/followups", { message_id: m, kind: "flag", due: due + DAY }).catch(() => {});
    // That time is now past, so it is refused: still one, still reminded.
    eq(open().map((f) => f.state), ["reminded"], "a time already past is refused and changes nothing");

    const s = sent("<t5@x>");
    await call("POST", "/api/followups", { message_id: s, kind: "flag", due: clock + DAY });
    ok(reminder(s), "a flag reminder is set");
    await call("POST", "/api/followups", { message_id: s, kind: "noreply", due: clock + 2 * DAY });
    eq([open().filter((f) => f.message_id === s).length, reminder(s)], [1, undefined], "turning it into a noreply replaces it and drops the old reminder");
    reset();
  }

  /* ── what the routes refuse ── */
  {
    const m = put({});
    eq((await call("POST", "/api/followups", { message_id: m, kind: "noreply", due: clock + DAY })).status, 400, "mail you received cannot wait for a reply");
    eq((await call("POST", "/api/followups", { message_id: m, kind: "weird", due: clock + DAY })).status, 400, "an unknown kind is refused");
    eq((await call("POST", "/api/followups", { message_id: m, kind: "flag", due: clock - 1 })).status, 400, "a time in the past is refused");
    eq((await call("POST", "/api/followups", { message_id: hex(999), kind: "flag", due: clock + DAY })).status, 404, "an unknown message is refused");
    eq(open(), [], "none of those left anything behind");
    reset();
  }

  /* ── nothing for a send that did not go ── */
  {
    const s = sent("<t6@x>");
    eq(await followupForSent(env, s, {}), false, "a send that asked for nothing sets nothing");
    eq(await followupForSent(env, hex(12345), { followup_days: 2 }), false, "no Sent row (filing failed): nothing is attached");
    eq(await followupForSent(env, s, { followup_days: 9999 }), false, "an absurd number of days is ignored");
    eq(open(), [], "nothing was created");
    eq(await followupForSent(env, s, { followup_days: 3 }), true, "the days a send asked for are counted from when it went");
    eq(open()[0].due, clock + 3 * DAY, "to the day it will remind");
    reset();
  }

  /* ── search ── */
  {
    const m = put({});
    put({});
    await call("POST", "/api/followups", { message_id: m, kind: "flag", due: clock + DAY });
    const q = parseSearch("is:followup", { tz: 0 });
    const hits = DB.raw.prepare(`SELECT id FROM messages m WHERE ${q.where}`).all(...q.values).map((r) => r.id);
    eq(hits, [m], "is:followup finds the message with an open follow-up and no other");
    reset();
  }
} finally {
  Date.now = realNow;
  deps.star = realStar;
  globalThis.fetch = realFetch;
}
