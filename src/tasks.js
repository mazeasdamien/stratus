/**
 * Tasks: a to-do list with an optional due date and reminder, and a task can
 * be made from an email and link back to it.
 *
 * A task is one row. Two fields carry more than they seem to:
 *
 *   done_at   The only thing that says a task is done, and when. There is no
 *             separate "done" flag to drift out of step with it.
 *   due       A moment, or, with due_all_day, a calendar date. An all-day due
 *             is stored as that date's midnight in UTC, the way an all-day
 *             event is (see events in schema.js): the date written, wherever
 *             it is read. A timed due is an instant and lands on whichever
 *             day it falls in the reader's zone.
 *
 * Which group a task is listed under (Overdue, Today, Upcoming, No date,
 * Done) is decided here, by groupTasks, from the reader's zone, so the page
 * only draws what it is given. The groups go by calendar day, not by the
 * minute: a task due at 00:30 is Today all day, and turns Overdue when the
 * day ends, which is also when an all-day task due today does.
 *
 * A task's reminder is the reminders primitive's job (src/reminders.js), kind
 * "task". This file only says when one should exist: while a task is open and
 * has a reminder time still ahead.
 */

import { clearReminder, setReminder } from "./reminders.js";
import { json, ui } from "./util.js";

const DAY_MS = 86_400_000;
/** The most a title, the notes and a reminder's text may hold. */
const TITLE_MAX = 300;
const NOTES_MAX = 5000;
const BODY_MAX = 200;
/** How many finished tasks a read returns; the rest are only counted. */
const DONE_SHOWN = 100;

export const GROUPS = [
  ["overdue", ui("Overdue")],
  ["today", ui("Today")],
  ["upcoming", ui("Upcoming")],
  ["nodate", ui("No date")],
  ["done", ui("Done")],
];

/** The reader's zone as Date#getTimezoneOffset minutes, read as parseSearch reads it. */
export function zoneOffset(v) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && Math.abs(n) <= 840 ? Math.round(n) : 0;
}

/**
 * Where a task's due sits on the reader's calendar, as a day number. Both
 * kinds are put on one scale, "local milliseconds", so that comparing them,
 * and sorting them, needs no special case.
 */
const localMs = (t, off) => (t.due_all_day ? t.due : t.due - off * 60_000);
const dayNumber = (ms) => Math.floor(ms / DAY_MS);

/**
 * Sorts rows into the five groups the view shows. Open tasks with a due date
 * go by that date, soonest first; those with none keep the order they were
 * added in; done tasks run newest first. Pure: `now` and the zone are
 * arguments, so a test can stand at any moment in any zone.
 *
 * @returns {{ groups: {id:string,label:string,tasks:object[]}[], due: number, doneCount: number }}
 *   `due` is Overdue plus Today, what the tab's dot counts.
 */
export function groupTasks(rows, now, tzOffsetMin) {
  const off = zoneOffset(tzOffsetMin);
  const today = dayNumber(now - off * 60_000);
  const by = { overdue: [], today: [], upcoming: [], nodate: [], done: [] };
  for (const t of rows) {
    if (t.done_at != null) by.done.push(t);
    else if (t.due == null) by.nodate.push(t);
    else {
      const d = dayNumber(localMs(t, off));
      (d < today ? by.overdue : d === today ? by.today : by.upcoming).push(t);
    }
  }
  const byDue = (a, b) => localMs(a, off) - localMs(b, off) || a.position - b.position || a.created_at - b.created_at;
  for (const k of ["overdue", "today", "upcoming"]) by[k].sort(byDue);
  by.nodate.sort((a, b) => a.position - b.position || a.created_at - b.created_at);
  by.done.sort((a, b) => b.done_at - a.done_at || b.created_at - a.created_at);
  const doneCount = by.done.length;
  by.done = by.done.slice(0, DONE_SHOWN);
  return {
    groups: GROUPS.map(([id, label]) => ({ id, label, tasks: by[id] })),
    due: by.overdue.length + by.today.length,
    doneCount,
  };
}

/** What a row looks like to the page. A message that has gone leaves no link. */
function shape(r) {
  return {
    id: r.id,
    title: r.title,
    notes: r.notes,
    due: r.due,
    allDay: !!r.due_all_day,
    reminder: r.reminder,
    important: !!r.important,
    doneAt: r.done_at,
    message: r.mid ? { id: r.mid, subject: r.msubject } : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SELECT = `SELECT t.*, m.id AS mid, m.subject AS msubject
  FROM tasks t LEFT JOIN messages m ON m.id = t.message_id`;

const rowById = (env, id) => env.DB.prepare(`${SELECT} WHERE t.id=?`).bind(id).first();

/** The reminder a task should have right now, or none. See the header. */
async function syncReminder(env, t, now) {
  if (t.done_at != null || t.reminder == null) return clearReminder(env, "task", t.id);
  // Already past, and the user's own setting from before: nothing to arm, and
  // arming it would ring at once for a time that has gone.
  if (t.reminder <= now) return;
  await setReminder(env, {
    kind: "task",
    ref: t.id,
    title: t.title,
    body: t.notes.slice(0, BODY_MAX),
    at: t.reminder,
  });
}

/** A time field from the request: a finite number of ms, or null. NaN is an error. */
function timeField(v) {
  if (v === null || v === "" || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : NaN;
}

/**
 * The columns a request body asks to set, checked. `existing` is the row for
 * an update, so a partial body leaves the other fields alone.
 * @returns {{ error: string } | { set: object }}
 */
function parseBody(b, existing, now) {
  const set = {};
  if ("title" in b || !existing) {
    const title = String(b.title ?? "").trim().slice(0, TITLE_MAX);
    if (!title) return { error: ui("A task needs a title") };
    set.title = title;
  }
  if ("notes" in b) set.notes = String(b.notes ?? "").slice(0, NOTES_MAX);
  if ("important" in b) set.important = b.important ? 1 : 0;

  const due = "due" in b ? timeField(b.due) : existing ? existing.due : null;
  if (Number.isNaN(due)) return { error: ui("That due date is not a date") };
  const allDay = due == null ? 0 : "allDay" in b ? (b.allDay ? 1 : 0) : existing ? existing.due_all_day : 0;
  if ("due" in b || "allDay" in b || !existing) {
    set.due = due == null ? null : allDay ? Math.floor(due / DAY_MS) * DAY_MS : due;
    set.due_all_day = allDay;
  }

  if ("reminder" in b) {
    const at = timeField(b.reminder);
    if (Number.isNaN(at)) return { error: ui("That reminder time is not a time") };
    // Only a change has to be ahead: saving a task whose reminder has since
    // gone by must not fail on a field the user did not touch.
    if (at != null && at <= now && at !== (existing ? existing.reminder : null)) {
      return { error: ui("Pick a reminder time in the future") };
    }
    set.reminder = at;
  }
  return { set };
}

async function list(env, url) {
  const { results } = await env.DB.prepare(SELECT).all();
  const rows = results ?? [];
  const g = groupTasks(rows, Date.now(), url.searchParams.get("tz"));
  return json({
    due: g.due,
    doneCount: g.doneCount,
    groups: g.groups.map((x) => ({ ...x, tasks: x.tasks.map(shape) })),
  });
}

async function create(request, env) {
  const b = await request.json().catch(() => ({}));
  const now = Date.now();
  const p = parseBody(b, null, now);
  if (p.error) return json({ error: p.error }, 400);
  const id = crypto.randomUUID();
  const { n } = (await env.DB.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS n FROM tasks").first()) ?? { n: 1 };
  const s = { notes: "", important: 0, due: null, due_all_day: 0, reminder: null, ...p.set };
  const messageId = b.messageId ? String(b.messageId).slice(0, 64) : null;
  await env.DB.prepare(
    `INSERT INTO tasks (id, title, notes, due, due_all_day, reminder, important, message_id, position, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(id, s.title, s.notes, s.due, s.due_all_day, s.reminder, s.important, messageId, n, now, now)
    .run();
  const row = await rowById(env, id);
  await syncReminder(env, row, now);
  return json({ task: shape(row) }, 201);
}

async function update(request, env, id) {
  const existing = await rowById(env, id);
  if (!existing) return json({ error: ui("No such task") }, 404);
  const b = await request.json().catch(() => ({}));
  const now = Date.now();
  const p = parseBody(b, existing, now);
  if (p.error) return json({ error: p.error }, 400);
  const cols = Object.keys(p.set);
  if (cols.length) {
    await env.DB.prepare(`UPDATE tasks SET ${cols.map((c) => `${c}=?`).join(", ")}, updated_at=? WHERE id=?`)
      .bind(...cols.map((c) => p.set[c]), now, id)
      .run();
  }
  const row = await rowById(env, id);
  await syncReminder(env, row, now);
  return json({ task: shape(row) });
}

/**
 * Done and not done are the same UPDATE with the opposite value, guarded by
 * the state it leaves, so two taps (or two devices) cannot stamp a second
 * done_at over the first. Either way the answer is the task as it now is.
 */
async function setDone(env, id, done) {
  const existing = await rowById(env, id);
  if (!existing) return json({ error: ui("No such task") }, 404);
  const now = Date.now();
  const r = await env.DB.prepare(
    done
      ? "UPDATE tasks SET done_at=?, updated_at=? WHERE id=? AND done_at IS NULL"
      : "UPDATE tasks SET done_at=NULL, updated_at=? WHERE id=? AND done_at IS NOT NULL"
  )
    .bind(...(done ? [now, now, id] : [now, id]))
    .run();
  const row = await rowById(env, id);
  if ((r.meta?.changes ?? 0) > 0) await syncReminder(env, row, now);
  return json({ task: shape(row) });
}

async function remove(env, id) {
  await clearReminder(env, "task", id);
  const r = await env.DB.prepare("DELETE FROM tasks WHERE id=?").bind(id).run();
  return (r.meta?.changes ?? 0) ? json({ ok: true }) : json({ error: ui("No such task") }, 404);
}

async function clearCompleted(env) {
  const r = await env.DB.prepare("DELETE FROM tasks WHERE done_at IS NOT NULL").run();
  return json({ ok: true, removed: r.meta?.changes ?? 0 });
}

async function api(request, env, path) {
  if (!path.startsWith("/api/tasks")) return null;
  const method = request.method;
  if (path === "/api/tasks") {
    if (method === "GET") return list(env, new URL(request.url));
    if (method === "POST") return create(request, env);
    return null;
  }
  if (path === "/api/tasks/clear-completed") return method === "POST" ? clearCompleted(env) : null;

  const m = path.match(/^\/api\/tasks\/([^/]+?)(?:\/(complete|reopen))?$/);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  if (m[2]) return method === "POST" ? setDone(env, id, m[2] === "complete") : null;
  if (method === "GET") {
    const row = await rowById(env, id);
    return row ? json({ task: shape(row) }) : json({ error: ui("No such task") }, 404);
  }
  if (method === "POST") return update(request, env, id);
  if (method === "DELETE") return remove(env, id);
  return null;
}

export const tasksModule = {
  name: "tasks",
  api,
  tables: ["tasks"],
};
