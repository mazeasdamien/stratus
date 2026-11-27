/**
 * Follow-up: a message you want to come back to, and mail you sent that wants
 * an answer.
 *
 *   flag     remind me at a time. The message is starred (at iCloud too) and a
 *            reminder is set for `due`.
 *   noreply  set on a message you sent: remind me at `due`, unless somebody
 *            has answered by then, in which case say nothing.
 *
 * There is one follow-up per message, and it is one small state machine kept
 * in one table, NEXT, rather than flags tested wherever they are needed:
 *
 *   waiting --fire--> reminded
 *   waiting --ring--> rang         a noreply reminded whose star did not take
 *   waiting --reply--> (gone)      the conversation has a message from someone else
 *   waiting --clear--> (gone)      Mark complete, or the message was deleted
 *   reminded, rang --clear--> (gone)
 *   waiting, reminded --unstar--> (gone)   the star was taken off, here or on another device
 *
 * A rang follow-up has no star of its own, so a message with none is not one
 * whose star was taken off, and only clearing it ends it.
 *
 * "Gone" means the row is deleted together with its reminder: a follow-up that
 * is over leaves nothing behind to be listed or searched. The state column
 * holds only the three live states.
 *
 *   GET  /api/followups                    the open ones
 *   POST /api/followups { message_id, kind, due }   set one (again: it moves)
 *   POST /api/followups/:id/complete       Mark complete
 *
 * The cron looks at the open ones every minute in one bounded query, so it
 * costs a single read when there are none. That sweep is also what notices a
 * star taken off by a sync or a message deleted by one, so neither of those
 * paths had to learn about follow-ups.
 *
 * The query asks for two things apart: the waiting ones, soonest first, which
 * it must never miss, and of the rest only those whose star or message has
 * gone. It once read every open one by due date under one limit, and a
 * reminded one stays until it is cleared, so two hundred reminded follow-ups
 * would have hidden a newer waiting one for ever.
 */

import { aliasesOf, accountById } from "./filing.js";
import { imapFlag } from "./imap.js";
import { icloudAct } from "./mailbox.js";
import { clearReminder, setReminder } from "./reminders.js";
import { FLAG_FLAGGED, json, ui } from "./util.js";

export const KIND = "followup"; // the reminders table's kind for these
const KINDS = ["flag", "noreply"];
const OPEN_MAX = 200; // the most one sweep looks at, of each of its two kinds
const DAYS_MAX = 60;
const DAY_MS = 86_400_000;

/**
 * state --event--> next state; null means over, and the row goes. Nothing
 * else moves a follow-up, so an event a state does not list is a no-op.
 */
const NEXT = {
  waiting: { fire: "reminded", ring: "rang", reply: null, clear: null, unstar: null },
  reminded: { clear: null, unstar: null },
  rang: { clear: null },
};

/** The states `event` may be applied from. */
const sources = (event) => Object.keys(NEXT).filter((s) => event in NEXT[s]);
const marks = (n) => Array(n).fill("?").join(",");

/**
 * Applies `event` to the follow-up of `id`, from whatever state allows it.
 * Returns whether it moved, so two sweeps racing for one follow-up cannot both
 * win it. Ending one clears its reminder first: a crash between the two leaves
 * a row the next sweep ends again, where the other order would leave a
 * reminder that rings for nothing.
 */
async function move(env, event, id) {
  const from = sources(event);
  const to = NEXT[from[0]][event];
  if (to === null) {
    const row = await env.DB.prepare(`SELECT 1 AS x FROM followups WHERE message_id=? AND state IN (${marks(from.length)})`)
      .bind(id, ...from)
      .first();
    if (!row) return false;
    await clearReminder(env, KIND, id);
    const r = await env.DB.prepare(`DELETE FROM followups WHERE message_id=? AND state IN (${marks(from.length)})`)
      .bind(id, ...from)
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }
  const r = await env.DB.prepare(`UPDATE followups SET state=? WHERE message_id=? AND state IN (${marks(from.length)})`)
    .bind(to, id, ...from)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

/** The star came off this message: its follow-up, if it has one, is over. */
export const onUnstar = (env, id) => move(env, "unstar", id);

/** What touches the outside world, replaceable so a test needs no IMAP server. */
export const deps = {
  /** Stars or unstars a message at iCloud and here, as the flag route does. */
  async star(env, id, on) {
    const msg = await env.DB.prepare("SELECT * FROM messages WHERE id=?").bind(id).first();
    if (!msg) throw new Error(ui("Unknown message"));
    if (!!Number(msg.starred) === on) return;
    const acct = await accountById(env, msg.account_id);
    if (!acct) throw new Error(ui("Unknown account"));
    const done = await icloudAct(env, acct, msg.mid || msg.pid, msg.folder, (im, _b, _h, uid) =>
      imapFlag(im, uid, FLAG_FLAGGED, on)
    );
    if (!done) throw new Error(ui("This account has no stored credential"));
    await env.DB.prepare("UPDATE messages SET starred=? WHERE id=?").bind(on ? 1 : 0, id).run();
  },
};

/** Every address of yours that a message could have been written from. */
async function myAddresses(env, acct, extra = "") {
  const all = [acct?.email, extra, ...(acct ? await aliasesOf(env, acct) : [])];
  return new Set(all.filter(Boolean).map((a) => String(a).trim().toLowerCase()));
}

/**
 * Whether somebody else has written in this conversation since the message
 * you sent. Your own later messages, and anything from one of your aliases or
 * the address it was sent from, are not an answer. A draft is not one either.
 */
async function answered(env, f, sent) {
  if (!f.thread_key) return false; // nothing ties a later message to this one
  const acct = await accountById(env, f.account_id);
  const mine = await myAddresses(env, acct, sent.from_email);
  const { results } = await env.DB.prepare(
    `SELECT from_email FROM messages
      WHERE account_id=? AND thread_key=? AND date>? AND id<>? AND folder<>'drafts' LIMIT 100`
  )
    .bind(f.account_id, f.thread_key, sent.date, f.message_id)
    .all();
  return (results ?? []).some((r) => !mine.has(String(r.from_email || "").trim().toLowerCase()));
}

/**
 * What the reminder says, once there is something to say. A missing subject
 * has its own whole wording, so the device translates the title in one piece.
 */
const noReplyTitle = (s) => {
  const subject = String(s || "").trim();
  return subject ? ui(`No reply yet: ${subject}`) : ui("No reply yet: (no subject)");
};
const followUpTitle = (s) => {
  const subject = String(s || "").trim();
  return subject ? ui(`Follow up: ${subject}`) : ui("Follow up: (no subject)");
};

/**
 * One pass: ends what is over, fires what is due. `now` and `deps` are
 * parameters so a test controls the clock and the iCloud side.
 */
export async function sweep(env, now = Date.now()) {
  const cols = `f.message_id, f.account_id, f.thread_key, f.kind, f.due, f.state,
            m.id AS present, m.starred, m.date, m.subject, m.from_email, m.to_line
       FROM followups f LEFT JOIN messages m ON m.id=f.message_id`;
  const { results } = await env.DB.prepare(
    `SELECT * FROM (SELECT ${cols} WHERE f.state='waiting' ORDER BY f.due LIMIT ?)
     UNION ALL
     SELECT * FROM (SELECT ${cols} WHERE f.state<>'waiting' AND (m.id IS NULL OR (f.state='reminded' AND m.starred=0)) LIMIT ?)`
  )
    .bind(OPEN_MAX, OPEN_MAX)
    .all();
  let fired = 0;
  for (const f of results ?? []) {
    try {
      if (!f.present) {
        await move(env, "clear", f.message_id);
        continue;
      }
      // The star is the follow-up's own for a flag, and for a noreply once it
      // has been raised. Before that a noreply is not starred and is not meant to be.
      const unstarred = !Number(f.starred);
      if (unstarred && (f.kind === "flag" || f.state === "reminded")) {
        await move(env, "unstar", f.message_id);
        continue;
      }
      if (f.state !== "waiting") continue;
      if (f.kind === "noreply" && (await answered(env, f, f))) {
        await move(env, "reply", f.message_id);
        continue;
      }
      if (f.due > now) continue;
      let event = "fire";
      if (f.kind === "noreply") {
        // Remind, then star, then claim: both are idempotent, so a second
        // sweep that gets here too does no harm. The reminder is the point
        // and the star a courtesy, tried once. A Sent copy that never reached
        // iCloud has nothing there to star, and a star retried every minute
        // was an iCloud login every minute and a reminder never set.
        await setReminder(env, {
          kind: KIND,
          ref: f.message_id,
          title: noReplyTitle(f.subject),
          body: f.to_line ? ui(`Nobody has replied to your message to ${f.to_line}`) : ui("Nobody has replied to your message"),
          at: now,
        });
        try {
          await deps.star(env, f.message_id, true);
        } catch (e) {
          console.log(`followup: ${f.message_id} reminded without its star: ${e && e.message ? e.message : e}`);
          event = "ring";
        }
      }
      if (await move(env, event, f.message_id)) fired++;
    } catch (e) {
      console.log(`followup: ${f.message_id} ${e && e.message ? e.message : e}`);
    }
  }
  return fired;
}

/** The open follow-ups, soonest first. */
async function list(env) {
  const { results } = await env.DB.prepare(
    "SELECT message_id, account_id, thread_key, kind, due, state FROM followups ORDER BY due, message_id"
  ).all();
  return results ?? [];
}

/**
 * Opens or moves the follow-up of a message. Setting it again changes the
 * time and nothing else: a follow-up already reminded stays reminded when
 * neither its kind nor its time moved.
 */
export async function setFollowup(env, msg, kind, due, now = Date.now()) {
  if (kind === "flag") await deps.star(env, msg.id, true);
  await env.DB.prepare(
    `INSERT INTO followups (message_id, account_id, thread_key, kind, due, created_at) VALUES (?,?,?,?,?,?)
     ON CONFLICT(message_id) DO UPDATE SET
       thread_key=excluded.thread_key,
       state=CASE WHEN followups.kind=excluded.kind AND followups.due=excluded.due THEN followups.state ELSE 'waiting' END,
       kind=excluded.kind, due=excluded.due`
  )
    .bind(msg.id, msg.account_id, msg.thread_key || "", kind, Math.round(due), now)
    .run();
  if (kind === "flag") {
    const sender = msg.from_name || msg.from_email;
    await setReminder(env, {
      kind: KIND,
      ref: msg.id,
      title: followUpTitle(msg.subject),
      body: sender ? ui(`From ${sender}`) : "",
      at: due,
    });
  } else {
    // A noreply rings only once nobody has answered, and sets its reminder
    // then. One that was a flag a moment ago must not ring at its old time.
    await clearReminder(env, KIND, msg.id);
  }
}

/**
 * Called right after a sent message has been filed in Sent: the follow-up the
 * composer asked for ("remind me if nobody replies"). `want` is the send's own
 * body: `followup_days` after now, or `followup_at` as a date. Returns whether
 * one was set, and never throws: the message has gone, and nothing here may
 * turn that into an error.
 */
export async function followupForSent(env, messageId, want, now = Date.now()) {
  const days = Number(want?.followup_days);
  const at = Number(want?.followup_at);
  const due = days > 0 && days <= DAYS_MAX ? now + Math.round(days) * DAY_MS : at > now ? Math.round(at) : 0;
  if (!due) return false;
  try {
    const msg = await env.DB.prepare("SELECT * FROM messages WHERE id=?").bind(messageId).first();
    if (!msg) return false;
    await setFollowup(env, msg, "noreply", due, now);
    return true;
  } catch (e) {
    console.log(`followup: sent ${messageId} ${e && e.message ? e.message : e}`);
    return false;
  }
}

async function api(request, env, path) {
  if (path === "/api/followups" && request.method === "GET") return json({ followups: await list(env) });

  if (path === "/api/followups" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const kind = String(b.kind || "");
    const due = Number(b.due);
    if (!KINDS.includes(kind)) return json({ error: ui("Unknown kind of follow-up") }, 400);
    if (!Number.isFinite(due) || due <= Date.now() + 30_000) return json({ error: ui("Pick a time in the future") }, 400);
    const msg = await env.DB.prepare("SELECT * FROM messages WHERE id=?").bind(String(b.message_id || "")).first();
    if (!msg) return json({ error: ui("Unknown message") }, 404);
    if (kind === "noreply") {
      const mine = await myAddresses(env, await accountById(env, msg.account_id));
      if (!mine.has(String(msg.from_email || "").toLowerCase()) && msg.folder !== "sent") {
        return json({ error: ui("Only a message you sent can wait for a reply") }, 400);
      }
    }
    try {
      await setFollowup(env, msg, kind, due);
    } catch (e) {
      return json({ error: String(e && e.message ? e.message : e).slice(0, 200) }, 502);
    }
    return json({ ok: true });
  }

  const done = path.match(/^\/api\/followups\/([a-f0-9]{16})\/complete$/);
  if (done && request.method === "POST") {
    // Gone already is what was asked for.
    await move(env, "clear", done[1]);
    return json({ ok: true });
  }
  return null;
}

export const followupModule = {
  name: "followup",
  api,
  cron: (env) => sweep(env),
  tables: ["followups"],
};
