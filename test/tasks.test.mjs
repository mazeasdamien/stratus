/**
 * Tasks (src/tasks.js) against a real SQLite, through the routes the page
 * calls: create, read, edit, complete and reopen, delete, clear completed.
 * What a task does to its reminder is read from the reminders table, where
 * the reminders module keeps it.
 */
import { register } from "node:module";
import { eq, ok } from "./harness.mjs";

register("../scripts/sync-harness/hooks.mjs", import.meta.url);
const { makeD1 } = await import("../scripts/sync-harness/fake.mjs");
const { SCHEMA } = await import("../src/schema.js");
const { handleApi } = await import("../src/api.js");
const { MODULES } = await import("../src/modules.js");
const { tasksModule, groupTasks } = await import("../src/tasks.js");

const DB = makeD1();
for (const s of SCHEMA) DB.raw.exec(s);
const env = { DB, APP_URL: "http://x" };

const realNow = Date.now;
const MIN = 60_000;
const HOUR = 60 * MIN;
// Friday 11 December 2026, 11:00 UTC: noon in Paris (CET) and 03:00 in Los
// Angeles (PST), both on the 11th.
const START = Date.UTC(2026, 11, 11, 11, 0, 0);
let clock = START;
Date.now = () => clock;

// Date#getTimezoneOffset minutes: UTC minus local.
const PARIS = -60;
const LA = 480;

const call = async (method, path, body) => {
  const res = await handleApi(
    new Request("http://x" + path, { method, body: body ? JSON.stringify(body) : undefined }),
    env, path.split("?")[0], undefined, undefined
  );
  return { status: res.status, body: await res.json() };
};
const read = async (tz) => {
  const { body } = await call("GET", `/api/tasks?tz=${tz}`);
  return Object.fromEntries(body.groups.map((g) => [g.id, g.tasks.map((t) => t.title)]));
};
const add = async (b) => (await call("POST", "/api/tasks", b)).body.task;
const reminderRow = (id) => DB.raw.prepare("SELECT * FROM reminders WHERE kind='task' AND ref=?").get(id);
const reminderCount = () => DB.raw.prepare("SELECT COUNT(*) AS n FROM reminders").get().n;

try {
  ok(MODULES.includes(tasksModule), "the module is registered");

  // Empty, and the five groups are always there, in the order the view shows them.
  let r = await call("GET", "/api/tasks?tz=-60");
  eq([r.status, r.body.due, r.body.doneCount], [200, 0, 0], "an empty list is empty");
  eq(r.body.groups.map((g) => g.id), ["overdue", "today", "upcoming", "nodate", "done"], "the five groups, in order");

  // Create.
  eq((await call("POST", "/api/tasks", { title: "   " })).status, 400, "a task needs a title");
  eq((await call("POST", "/api/tasks", { title: "x", due: "soon" })).status, 400, "a due date that is not a date is refused");
  eq((await call("POST", "/api/tasks", { title: "x", reminder: clock - MIN })).status, 400, "a reminder in the past is refused");
  eq((await call("GET", "/api/tasks")).body.doneCount, 0, "and nothing was added by the refusals");
  const plain = await add({ title: "  Buy stamps  " });
  eq(
    [plain.title, plain.notes, plain.due, plain.allDay, plain.reminder, plain.important, plain.doneAt, plain.message],
    ["Buy stamps", "", null, false, null, false, null, null],
    "a bare task is a trimmed title and nothing else"
  );
  eq(reminderCount(), 0, "with no reminder asked for, none is made");
  eq((await call("GET", `/api/tasks/${plain.id}`)).body.task.title, "Buy stamps", "one task is read by its id");
  eq((await call("GET", "/api/tasks/nope")).status, 404, "an unknown id is a 404");

  // Edit: only what is sent changes.
  const edited = (await call("POST", `/api/tasks/${plain.id}`, { notes: "Post office", important: true })).body.task;
  eq([edited.title, edited.notes, edited.important], ["Buy stamps", "Post office", true], "an edit changes only the fields it names");
  eq((await call("POST", `/api/tasks/${plain.id}`, { title: "" })).status, 400, "a title cannot be emptied");
  eq((await call("POST", "/api/tasks/nope", { title: "x" })).status, 404, "editing an unknown task is a 404");

  // Delete.
  const gone = await add({ title: "Throwaway" });
  eq((await call("DELETE", `/api/tasks/${gone.id}`)).status, 200, "a task is deleted");
  eq((await call("DELETE", `/api/tasks/${gone.id}`)).status, 404, "and not twice");
  eq((await call("GET", `/api/tasks/${gone.id}`)).status, 404, "and is gone");

  // ── Grouping at day boundaries, in two zones ──
  // 00:30 on Friday 11 December in Paris is 23:30 UTC on the 10th: Today for
  // Paris, though it is noon and the time is long past, and Overdue for
  // Los Angeles, where it was 15:30 on the 10th.
  const justAfterMidnight = await add({ title: "Just after midnight", due: Date.UTC(2026, 11, 10, 23, 30) });
  // All-day: the date as written, wherever it is read.
  const allDayToday = await add({ title: "All day Friday", due: Date.UTC(2026, 11, 11, 15, 0), allDay: true });
  const allDayYesterday = await add({ title: "All day Thursday", due: Date.UTC(2026, 11, 10), allDay: true });
  const nextWeek = await add({ title: "Next week", due: Date.UTC(2026, 11, 18, 9, 0) });
  eq(allDayToday.due, Date.UTC(2026, 11, 11), "an all-day due is kept as that date's midnight UTC");

  let g = await read(PARIS);
  eq(g.overdue, ["All day Thursday"], "Paris: yesterday's all-day task is Overdue");
  eq(g.today, ["All day Friday", "Just after midnight"], "Paris: a task due 00:30 local is Today, not Overdue, and so is an all-day task due today");
  eq(g.upcoming, ["Next week"], "Paris: next week is Upcoming");
  eq(g.nodate, ["Buy stamps"], "a task with no date is under No date");
  eq(g.done, [], "nothing is done yet");

  g = await read(LA);
  eq(g.overdue, ["All day Thursday", "Just after midnight"], "Los Angeles: the same instant is yesterday afternoon, so Overdue");
  eq(g.today, ["All day Friday"], "Los Angeles: the all-day task for the 11th is Today");
  eq(g.upcoming, ["Next week"], "Los Angeles: next week is Upcoming");

  eq((await call("GET", `/api/tasks?tz=${PARIS}`)).body.due, 3, "the tab's count is Overdue plus Today");

  // An all-day task due today stays Today until the day ends, then is Overdue.
  clock = Date.UTC(2026, 11, 11, 22, 59); // 23:59 Friday in Paris
  eq((await read(PARIS)).today.includes("All day Friday"), true, "Paris at 23:59: the all-day task is still Today");
  clock = Date.UTC(2026, 11, 11, 23, 0); // 00:00 Saturday in Paris
  g = await read(PARIS);
  eq([g.overdue.includes("All day Friday"), g.today.includes("All day Friday")], [true, false], "Paris at midnight: it is Overdue");
  eq((await read(LA)).today, ["All day Friday"], "Los Angeles, 15:00 on the 11th: it is Today there");
  eq((await read(undefined)).today, ["All day Friday"], "an unusable zone is read as UTC (23:00 on the 11th)");
  eq((await read("junk")).today, ["All day Friday"], "so is one that is not a number");
  clock = START;

  // The rule itself, with nothing else around: boundaries to the minute.
  const t = (due, allDay = 0) => ({ id: "t", title: "t", due, due_all_day: allDay, done_at: null, position: 1, created_at: 1 });
  const which = (task, now, tz) => groupTasks([task], now, tz).groups.find((x) => x.tasks.length).id;
  const midnight = Date.UTC(2026, 11, 11, 23, 0); // 00:00 on Saturday the 12th, Paris
  eq(which(t(midnight - MIN), midnight - MIN, PARIS), "today", "at 23:59 a task due 23:59 is Today");
  eq(which(t(midnight - MIN), midnight, PARIS), "overdue", "once the day has ended it is Overdue");
  eq(which(t(midnight), midnight - MIN, PARIS), "upcoming", "a task due at the next midnight is Upcoming until it begins");
  eq(which(t(midnight), midnight, PARIS), "today", "and Today from the moment it does");

  // ── Complete, reopen, and the reminder each time ──
  const ahead = clock + 2 * HOUR;
  const withReminder = await add({ title: "Call the bank", notes: "Ask about the fee", reminder: ahead });
  eq(withReminder.reminder, ahead, "the reminder time is kept");
  let rem = reminderRow(withReminder.id);
  eq([rem.title, rem.body, rem.at], ["Call the bank", "Ask about the fee", ahead], "a task with a reminder makes one, with its title and notes");

  // Moving the time moves the reminder; removing it removes the reminder.
  await call("POST", `/api/tasks/${withReminder.id}`, { reminder: ahead + HOUR });
  eq(reminderRow(withReminder.id).at, ahead + HOUR, "changing the time moves the reminder");
  await call("POST", `/api/tasks/${withReminder.id}`, { title: "Call the bank today" });
  eq([reminderRow(withReminder.id).title, reminderRow(withReminder.id).at], ["Call the bank today", ahead + HOUR], "a new title reaches it and leaves the time");
  await call("POST", `/api/tasks/${withReminder.id}`, { reminder: null });
  eq(reminderRow(withReminder.id), undefined, "clearing the time clears the reminder");
  await call("POST", `/api/tasks/${withReminder.id}`, { reminder: ahead });

  const done = await call("POST", `/api/tasks/${withReminder.id}/complete`);
  eq([done.status, done.body.task.doneAt], [200, clock], "completing stamps done_at");
  eq(reminderRow(withReminder.id), undefined, "and clears the reminder");
  eq((await read(PARIS)).done, ["Call the bank today"], "a done task is listed under Done");
  eq((await read(PARIS)).nodate.includes("Call the bank today"), false, "and nowhere else");
  eq((await call("GET", "/api/tasks?tz=0")).body.doneCount, 1, "and counted");

  clock += MIN;
  const again = await call("POST", `/api/tasks/${withReminder.id}/complete`);
  eq(again.body.task.doneAt, done.body.task.doneAt, "completing twice keeps the first time");
  eq(reminderRow(withReminder.id), undefined, "and arms nothing");

  // Editing a done task does not bring its reminder back.
  await call("POST", `/api/tasks/${withReminder.id}`, { notes: "Done, but a note" });
  eq(reminderRow(withReminder.id), undefined, "editing a done task leaves its reminder cleared");

  const reopened = await call("POST", `/api/tasks/${withReminder.id}/reopen`);
  eq(reopened.body.task.doneAt, null, "reopening clears done_at");
  eq(reminderRow(withReminder.id)?.at, ahead, "and sets the reminder again, since its time is still ahead");

  // A reminder that has gone by while the task was done is not set again.
  await call("POST", `/api/tasks/${withReminder.id}/complete`);
  clock = ahead + MIN;
  await call("POST", `/api/tasks/${withReminder.id}/reopen`);
  eq(reminderRow(withReminder.id), undefined, "reopening after the reminder's time has passed does not ring at once");
  eq((await call("GET", `/api/tasks/${withReminder.id}`)).body.task.reminder, ahead, "though the time is still on the task");
  await call("POST", `/api/tasks/${withReminder.id}`, { notes: "Edited late" });
  eq(reminderRow(withReminder.id), undefined, "and saving it again unchanged does not arm it either");
  eq((await call("POST", `/api/tasks/${withReminder.id}`, { reminder: clock - 2 * MIN })).status, 400, "though moving it to another past time is refused");
  clock = START;

  // Deleting clears the reminder too.
  const doomed = await add({ title: "Doomed", reminder: clock + HOUR });
  ok(!!reminderRow(doomed.id), "a reminder to delete");
  await call("DELETE", `/api/tasks/${doomed.id}`);
  eq(reminderRow(doomed.id), undefined, "deleting a task clears its reminder");

  // ── Clear completed ──
  const open = await add({ title: "Still open", reminder: clock + 3 * HOUR });
  const d1 = await add({ title: "Finished one" });
  const d2 = await add({ title: "Finished two" });
  await call("POST", `/api/tasks/${d1.id}/complete`);
  clock += MIN;
  await call("POST", `/api/tasks/${d2.id}/complete`);
  eq((await read(PARIS)).done.slice(0, 2), ["Finished two", "Finished one"], "Done runs newest first");
  const cleared = await call("POST", "/api/tasks/clear-completed");
  eq([cleared.status, cleared.body.removed], [200, 2], "clearing removes every done task");
  g = await read(PARIS);
  eq(g.done, [], "and Done is empty");
  eq(g.nodate.includes("Still open"), true, "open tasks stay");
  eq(reminderRow(open.id)?.at, open.reminder, "with their reminders");
  eq((await call("POST", "/api/tasks/clear-completed")).body.removed, 0, "clearing again removes nothing");
  clock = START;

  // ── A task made from a message, and the message goes away ──
  DB.raw.prepare("INSERT INTO messages (id, account_id, pid, subject, date, created_at) VALUES (?,?,?,?,?,?)")
    .run("m1", "acc", "p1", "Invoice 42", clock, clock);
  const linked = await add({ title: "Invoice 42", messageId: "m1" });
  eq(linked.message, { id: "m1", subject: "Invoice 42" }, "a task made from mail carries the message it came from");
  g = (await call("GET", "/api/tasks?tz=0")).body.groups.flatMap((x) => x.tasks).find((x) => x.id === linked.id);
  eq(g.message.id, "m1", "and the list says so too");
  DB.raw.prepare("DELETE FROM messages WHERE id='m1'").run();
  const orphan = (await call("GET", `/api/tasks/${linked.id}`)).body.task;
  eq([orphan.title, orphan.message], ["Invoice 42", null], "once the message is deleted the task is still there and simply has no link");
  const stillEditable = await call("POST", `/api/tasks/${linked.id}`, { title: "Invoice 42, paid?", due: clock + 10 * HOUR });
  eq([stillEditable.status, stillEditable.body.task.message], [200, null], "and can still be edited");
  eq((await call("POST", `/api/tasks/${linked.id}/complete`)).status, 200, "and completed");

  // A module's tables are in the nightly backup.
  eq(tasksModule.tables, ["tasks"], "the module names its table for the backup");
} finally {
  Date.now = realNow;
}
