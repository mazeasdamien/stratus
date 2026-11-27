/**
 * Reminders: the one path by which anything in the app nudges you at a time.
 *
 * A calendar entry, a task and a follow-up flag each want a notification at a
 * moment. None of them writes its own: each calls setReminder, and this file
 * rings the phone, lists what is due and lets it be snoozed or dismissed.
 *
 *   setReminder(env, { kind, ref, title, body, at })
 *   clearReminder(env, kind, ref)
 *
 * `kind` names the feature ("event", "task", "followup") and `ref` is that
 * feature's own id for the thing, so a reminder is found again by the pair
 * and one thing has at most one reminder.
 *
 * A reminder is in one of three states and moves between them in one table,
 * NEXT, rather than through flags tested where they happen to be needed:
 *
 *   scheduled --fire--> fired --dismiss--> dismissed
 *                         `-----snooze----> scheduled (at a new time)
 *
 * The state is stored as two timestamps, fired_at and dismissed_at, because
 * they also say when. Every change goes through `move`, which is one UPDATE
 * guarded by the state it leaves, so two requests (or two cron runs) racing
 * for the same reminder cannot both win it.
 */

import { pushAll } from "./push.js";
import { json } from "./util.js";

/** The row filter that means each state; the only place a timestamp is read as one. */
const IN = {
  scheduled: "fired_at IS NULL AND dismissed_at IS NULL",
  fired: "fired_at IS NOT NULL AND dismissed_at IS NULL",
  dismissed: "dismissed_at IS NOT NULL",
};

/** state --event--> { to, set }: `set` is the UPDATE's assignments, bound in order. */
const NEXT = {
  scheduled: { fire: { to: "fired", set: "fired_at=?" } },
  fired: {
    dismiss: { to: "dismissed", set: "dismissed_at=?" },
    snooze: { to: "scheduled", set: "at=?, fired_at=NULL" },
  },
  dismissed: {},
};

/** Which states can take `event`: where it may be applied from. */
const sources = (event) => Object.keys(NEXT).filter((s) => NEXT[s][event]);

/**
 * Applies `event` to every reminder it can apply to that also matches `where`.
 * Returns how many moved; 0 means none was in a state that allows it.
 */
async function move(env, event, arg, where = "1", binds = []) {
  const from = sources(event);
  if (from.length !== 1) throw new Error(`reminders: ${event} must leave exactly one state`);
  const { set } = NEXT[from[0]][event];
  const r = await env.DB.prepare(`UPDATE reminders SET ${set} WHERE ${IN[from[0]]} AND ${where}`)
    .bind(arg, ...binds)
    .run();
  return r.meta?.changes ?? 0;
}

/**
 * Makes sure a reminder exists for (kind, ref) and says `title`, `body` and
 * `at` (ms). Safe to call as often as you like: with nothing changed it
 * changes nothing, including a reminder that has already fired or been
 * dismissed. Moving `at` to a time still ahead brings it back to scheduled, so
 * a rescheduled meeting rings again. Moving it to a time already past does not,
 * since that would ring at once for something the user has dealt with.
 */
export async function setReminder(env, { kind, ref, title = "", body = "", at }) {
  if (!kind || !ref || !Number.isFinite(at)) throw new Error("reminders: kind, ref and a numeric at are required");
  const now = Date.now();
  const t = Math.round(at);
  // Compared with base_at, the time the feature asked for last, and not with
  // `at`, which a snooze moves. A feature that saves its event again with the
  // same time would otherwise undo the snooze and ring at once. In an UPDATE
  // the right-hand sides see the old row.
  const moved = "excluded.base_at <> reminders.base_at";
  const rearm = `CASE WHEN ${moved} AND excluded.base_at > ? THEN NULL ELSE`;
  await env.DB.prepare(
    `INSERT INTO reminders (id, kind, ref, title, body, at, base_at, created_at) VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(kind, ref) DO UPDATE SET
       title=excluded.title, body=excluded.body,
       fired_at=${rearm} reminders.fired_at END,
       dismissed_at=${rearm} reminders.dismissed_at END,
       at=CASE WHEN ${moved} THEN excluded.base_at ELSE reminders.at END,
       base_at=excluded.base_at`
  )
    .bind(crypto.randomUUID(), String(kind), String(ref), String(title), String(body), t, t, now, now, now)
    .run();
}

/** Forgets the reminder for (kind, ref), in any state. Nothing to forget is fine. */
export async function clearReminder(env, kind, ref) {
  await env.DB.prepare("DELETE FROM reminders WHERE kind=? AND ref=?").bind(String(kind), String(ref)).run();
}

/**
 * Fires everything whose time has come, in one statement, then rings once.
 *
 * The UPDATE is the whole decision: a reminder still scheduled is marked fired
 * by whichever run gets there first, and the other run changes nothing and
 * stays quiet, so overlapping runs cannot ring twice for one reminder. One
 * ring wakes every device however many reminders are in the batch; the service
 * worker then asks which.
 */
export async function fireDue(env, now = Date.now()) {
  const n = await move(env, "fire", now, "at<=?", [now]);
  if (n) await pushAll(env);
  return n;
}

/** How long after firing a reminder still counts as news for a push, in ms. */
const RECENT_MS = 3 * 60_000;

const COLUMNS = "id, kind, ref, title, body, at, fired_at";

/** Reminders fired in the last few minutes and not yet dismissed: what a push is about. */
export async function recentReminders(env, now = Date.now()) {
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM reminders WHERE ${IN.fired} AND fired_at>=? ORDER BY at, id`
  )
    .bind(now - RECENT_MS)
    .all();
  return results ?? [];
}

async function listFired(env) {
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM reminders WHERE ${IN.fired} ORDER BY at, id`
  ).all();
  const reminders = results ?? [];
  return { reminders, count: reminders.length };
}

async function api(request, env, path) {
  if (path === "/api/reminders" && request.method === "GET") return json(await listFired(env));

  const m = path.match(/^\/api\/reminders\/([^/]+)\/(dismiss|snooze)$/);
  if (!m || request.method !== "POST") return null;
  const id = decodeURIComponent(m[1]);

  let arg = Date.now();
  if (m[2] === "snooze") {
    const b = await request.json().catch(() => ({}));
    arg = Number(b.until);
    if (!Number.isFinite(arg) || arg <= Date.now()) return json({ error: "Pick a time in the future" }, 400);
  }
  const moved = await move(env, m[2], Math.round(arg), "id=?", [id]);
  if (moved) return json({ ok: true });

  // Nothing moved: no such reminder, or one that is not waiting on the user.
  // Dismissing what is already dismissed is the answer the user wanted.
  const row = await env.DB.prepare("SELECT id, fired_at, dismissed_at FROM reminders WHERE id=?").bind(id).first();
  if (!row) return json({ error: "No such reminder" }, 404);
  if (m[2] === "dismiss" && row.dismissed_at) return json({ ok: true });
  return json({ error: "That reminder is not waiting" }, 409);
}

export const remindersModule = {
  name: "reminders",
  api,
  cron: (env) => fireDue(env),
  tables: ["reminders"],
};
