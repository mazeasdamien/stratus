/**
 * Reminders (src/reminders.js) against a real SQLite, through what a feature
 * and the page can reach: setReminder, clearReminder, the per-minute cron the
 * module registers, the three routes and /api/push/state.
 */
import { register } from "node:module";
import { eq, ok } from "./harness.mjs";

register("../scripts/sync-harness/hooks.mjs", import.meta.url);
const { makeD1 } = await import("../scripts/sync-harness/fake.mjs");
const { SCHEMA } = await import("../src/schema.js");
const { handleApi } = await import("../src/api.js");
const { MODULES } = await import("../src/modules.js");
const { setReminder, clearReminder, remindersModule } = await import("../src/reminders.js");

const DB = makeD1();
for (const s of SCHEMA) DB.raw.exec(s);
const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const env = { DB, ENC_KEY: key, APP_URL: "http://x" };

// One registered device, and a fetch that counts the rings it receives.
DB.raw.prepare("INSERT INTO push_subs (endpoint, sub, created_at) VALUES (?,?,0)").run(
  "https://fcm.googleapis.com/fcm/send/device-1",
  JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/device-1" })
);
let rings = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => (rings++, new Response(null, { status: 201 }));

// A clock the test moves, so "a minute later" does not take a minute.
const realNow = Date.now;
let clock = Date.UTC(2026, 5, 1, 9, 0, 0);
Date.now = () => clock;
const MIN = 60_000;

const call = (method, path, body) =>
  handleApi(
    new Request("http://x" + path, { method, body: body ? JSON.stringify(body) : undefined }),
    env, path, undefined, undefined
  );
const listed = async () => (await call("GET", "/api/reminders")).json();
const cron = () => remindersModule.cron(env);
const state = async () => (await call("GET", "/api/push/state")).json();
const row = (kind, ref) => DB.raw.prepare("SELECT * FROM reminders WHERE kind=? AND ref=?").get(kind, ref);
const idOf = (kind, ref) => row(kind, ref).id;

try {
  ok(MODULES.includes(remindersModule), "the module is registered");

  // Nothing set: nothing listed, nothing rung.
  eq(await listed(), { reminders: [], count: 0 }, "no reminders to begin with");
  await cron();
  eq(rings, 0, "a cron with nothing due rings nobody");

  // Three reminders, all due a minute from now.
  const due = clock + MIN;
  await setReminder(env, { kind: "event", ref: "e1", title: "Standup", body: "Room 4", at: due + 2000 });
  await setReminder(env, { kind: "task", ref: "t1", title: "Send invoice", body: "", at: due });
  await setReminder(env, { kind: "followup", ref: "m1", title: "Chase Camille", body: "No reply yet", at: due + 1000 });
  eq((await listed()).count, 0, "a reminder is not listed before it has fired");
  await cron();
  eq(rings, 0, "and does not ring before its time");

  // Two overlapping runs, as when one heartbeat outlives a minute.
  clock = due + 5000;
  await Promise.all([cron(), cron()]);
  eq(rings, 1, "two overlapping cron runs ring once, for the whole batch of three");
  const first = await listed();
  eq(first.count, 3, "all three are listed once they have fired");
  eq(first.reminders.map((r) => r.ref), ["t1", "m1", "e1"], "soonest first");
  eq(
    first.reminders[0],
    { id: first.reminders[0].id, kind: "task", ref: "t1", title: "Send invoice", body: "", at: due, fired_at: clock },
    "a listed reminder carries its kind, ref, title, body, due time and when it fired"
  );
  await cron();
  eq(rings, 1, "a later run does not ring again for what has already fired");

  // Setting the same thing again changes nothing, even after it has fired.
  const before = JSON.stringify(row("task", "t1"));
  await setReminder(env, { kind: "task", ref: "t1", title: "Send invoice", body: "", at: due });
  eq(JSON.stringify(row("task", "t1")), before, "re-setting identical values leaves the row exactly as it was");
  eq((await listed()).count, 3, "and a fired reminder stays fired");
  eq(DB.raw.prepare("SELECT COUNT(*) AS n FROM reminders").get().n, 3, "and does not add a second one for the same kind and ref");

  // New words alone do not bring it back; a new future time does.
  clock += MIN;
  await setReminder(env, { kind: "task", ref: "t1", title: "Send the invoice", body: "Before noon", at: due });
  eq((await listed()).reminders.find((r) => r.ref === "t1").title, "Send the invoice", "a changed title is kept");
  eq((await listed()).count, 3, "without re-arming it");
  await setReminder(env, { kind: "task", ref: "t1", title: "Send the invoice", body: "Before noon", at: due - 3000 });
  eq((await listed()).count, 3, "moving it to another time already past does not re-arm it");

  const later = clock + 30 * MIN;
  await setReminder(env, { kind: "event", ref: "e1", title: "Standup", body: "Room 4", at: later });
  eq((await listed()).reminders.map((r) => r.ref), ["t1", "m1"], "moving a fired reminder to a future time takes it off the list");
  await cron();
  eq(rings, 1, "and it waits for that time");
  clock = later + 1000;
  await cron();
  eq(rings, 2, "then rings again");
  eq((await listed()).reminders.map((r) => r.ref), ["t1", "m1", "e1"], "and is listed again, by its new time, last");

  // Snooze.
  const m1 = idOf("followup", "m1");
  eq((await call("POST", `/api/reminders/${m1}/snooze`, { until: clock - 1 })).status, 400, "snoozing to a time in the past is refused");
  eq((await call("POST", `/api/reminders/${m1}/snooze`, {})).status, 400, "so is snoozing to nothing");
  eq((await call("POST", "/api/reminders/nope/snooze", { until: clock + MIN })).status, 404, "an unknown id is a 404");
  const until = clock + 10 * MIN;
  eq((await call("POST", `/api/reminders/${m1}/snooze`, { until })).status, 200, "snoozing a fired reminder works");
  eq((await listed()).reminders.map((r) => r.ref), ["t1", "e1"], "it leaves the list");
  eq((await call("POST", `/api/reminders/${m1}/snooze`, { until: until + MIN })).status, 409, "a reminder that is not waiting cannot be snoozed again");
  await cron();
  eq(rings, 2, "a snoozed reminder does not ring early");
  clock = until + 1000;
  await cron();
  eq(rings, 3, "it rings when the snooze is over");
  const back = (await listed()).reminders.find((r) => r.ref === "m1");
  eq([back.at, back.fired_at], [until, clock], "and comes back due at the snoozed time");

  // The push state names what has just fired, for the service worker.
  const s = await state();
  eq(s.reminders.map((r) => r.ref), ["m1"], "push state lists reminders fired in the last few minutes");
  eq(
    [s.reminders[0].title, s.reminders[0].body, s.unread, s.total],
    ["Chase Camille", "No reply yet", 0, 0],
    "with their title and body, beside the usual mail fields"
  );
  clock += 10 * MIN;
  eq((await state()).reminders, [], "and no longer once they are old news");
  eq((await listed()).count, 3, "though they stay on the list until dealt with");

  // Dismiss.
  const t1 = idOf("task", "t1");
  eq((await call("POST", `/api/reminders/${t1}/dismiss`)).status, 200, "dismissing works");
  eq((await call("POST", `/api/reminders/${t1}/dismiss`)).status, 200, "and dismissing twice is no complaint");
  eq((await call("POST", "/api/reminders/nope/dismiss")).status, 404, "an unknown id is a 404");
  eq((await listed()).reminders.map((r) => r.ref), ["e1", "m1"], "a dismissed reminder is off the list");
  await setReminder(env, { kind: "task", ref: "t1", title: "Send the invoice", body: "Before noon", at: due - 3000 });
  eq((await listed()).count, 2, "setting it again unchanged does not bring it back");
  const stillDue = clock;
  await cron();
  eq(rings, 3, "and it does not ring");
  await setReminder(env, { kind: "task", ref: "t1", title: "Send the invoice", body: "", at: stillDue + 5 * MIN });
  clock = stillDue + 6 * MIN;
  await cron();
  eq((await listed()).reminders.map((r) => r.ref).includes("t1"), true, "a new future time revives a dismissed reminder, and it fires");
  eq(rings, 4, "with a ring");

  // Dismissing before it fires is not an event the user can have asked for.
  await setReminder(env, { kind: "task", ref: "t2", title: "Not yet", body: "", at: clock + 60 * MIN });
  eq((await call("POST", `/api/reminders/${idOf("task", "t2")}/dismiss`)).status, 409, "a reminder that has not fired cannot be dismissed");

  // Clear.
  await clearReminder(env, "task", "t2");
  eq(row("task", "t2"), undefined, "clearing a scheduled reminder removes it");
  await clearReminder(env, "event", "e1");
  eq((await listed()).reminders.map((r) => r.ref), ["m1", "t1"], "clearing a fired one takes it off the list");
  await clearReminder(env, "event", "e1");
  ok(true, "clearing what is not there is fine");
  await setReminder(env, { kind: "event", ref: "e1", title: "Standup", body: "", at: clock - 1000 });
  eq(row("event", "e1").fired_at, null, "a cleared reminder set again starts over, scheduled");
  const rung = rings;
  await cron();
  eq([rings, (await listed()).reminders.some((r) => r.ref === "e1")], [rung + 1, true], "and fires like a new one");
  await Promise.all([cron(), cron()]);
  eq(rings, rung + 1, "with nothing left due, no run rings");
} finally {
  Date.now = realNow;
  globalThis.fetch = realFetch;
}
