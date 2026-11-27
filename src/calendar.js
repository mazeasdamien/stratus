/**
 * The calendar: events you make, calendars you subscribe to, and the
 * invitations from your mail, read through one door.
 *
 * Events live in this app's own database (`cal_events`), not at iCloud. A
 * calendar is `local` (yours to change) or a `subscription` (a feed on the
 * web, read-only, replaced as a whole each time it is fetched). The meetings
 * the mail sync finds stay in `events`, driven by mail; they are read as a
 * third, read-only "Invitations" calendar and never copied here.
 *
 * Three rules hold the rest together.
 *
 *  - An event is one row. A series is one master row with an RRULE; an
 *    occurrence of it that was edited alone is a second row with a
 *    `recurrence_id`; one that was removed alone is an `exdates` entry on the
 *    master. src/rrule.js turns that into occurrences for a window, and
 *    GET /api/calendar/events is the only place that does: the page never
 *    expands a rule itself.
 *  - Times are stored as src/ics.js models them. A timed event is an instant
 *    with the zone its wall clock is read in; an all-day event or an hour with
 *    no zone is its wall time held as UTC, with no instant at all.
 *  - A reminder is made only through src/reminders.js. One event has one
 *    reminder, always for its next occurrence still ahead.
 */

import { seal, open } from "./crypto.js";
import { parseCalendar, writeCalendar, httpsUrl } from "./ics.js";
import { expand, formatRule, instantOf, occurrences, parseRule, wallOf } from "./rrule.js";
import { clearReminder, setReminder } from "./reminders.js";
import { json } from "./util.js";

const DAY = 86_400_000;

/** The ceilings. Mutable so a test can reach one without a 10 second wait. */
export const LIM = {
  feedBytes: 5_000_000,
  feedEvents: 2000,
  feedTimeoutMs: 10_000,
  feedRedirects: 3,
  importBytes: 2_000_000,
  importEvents: 1000,
  importReminders: 300,
  windowDays: 400,
  windowOut: 5000,
};

const COLORS = ["#1f6fd0", "#d9534f", "#2e9e5b", "#e0892b", "#8a5cc7", "#17a2b8", "#c2569d", "#6b7280"];
const REFRESH_MIN = [15, 30, 60, 180, 360, 720, 1440];
const COLOR = /^#[0-9a-f]{6}$/i;

/** The Invitations calendar: not a row, so it can be neither changed nor deleted. */
export const INVITATIONS = { id: "invitations", name: "Invitations", color: "#6b7280", kind: "invitations", readOnly: true };

// ── calendars ──────────────────────────────────────────────

const calendarOf = (c) => ({
  id: c.id,
  name: c.name,
  color: c.color,
  kind: c.kind,
  readOnly: c.kind !== "local",
  refreshMin: c.refresh_min,
  fetchedAt: c.fetched_at,
  lastError: c.last_error,
  position: c.position,
  events: c.n ?? 0,
});

/**
 * One local calendar exists from the start. Made on first use rather than by
 * the schema, which would make a deleted one come back with the next schema
 * change; a calendar can be deleted only while another local one remains.
 */
async function ensureLocal(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM calendars WHERE kind='local'").first();
  if (row?.n) return;
  await env.DB.prepare(
    "INSERT INTO calendars (id, name, color, kind, position, created_at) VALUES (?, 'Calendar', ?, 'local', 0, ?)"
  )
    .bind(crypto.randomUUID(), COLORS[0], Date.now())
    .run();
}

async function listCalendars(env) {
  await ensureLocal(env);
  const { results } = await env.DB.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM cal_events e WHERE e.calendar_id=c.id AND e.recurrence_id IS NULL) AS n
     FROM calendars c ORDER BY c.position, c.created_at, c.id`
  ).all();
  return (results ?? []).map(calendarOf);
}

const getCalendar = (env, id) => env.DB.prepare("SELECT * FROM calendars WHERE id=?").bind(id).first();

/** One calendar as the page sees it, with the number of events it holds. */
const shownCalendar = async (env, id) =>
  calendarOf(
    await env.DB.prepare(
      "SELECT c.*, (SELECT COUNT(*) FROM cal_events e WHERE e.calendar_id=c.id AND e.recurrence_id IS NULL) AS n FROM calendars c WHERE c.id=?"
    )
      .bind(id)
      .first()
  );

/** A calendar's name and colour, as the page may set them; null when not usable. */
function nameAndColor(b, base = {}) {
  const name = String(b.name ?? base.name ?? "").trim().slice(0, 80);
  const color = String(b.color ?? base.color ?? COLORS[0]);
  if (!name) return { error: "Give the calendar a name" };
  if (!COLOR.test(color)) return { error: "Pick a colour" };
  return { name, color: color.toLowerCase() };
}

const refreshMinutes = (v, fallback = 60) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(1440, Math.max(15, n)) : fallback;
};

// ── subscriptions ──────────────────────────────────────────

/** A feed problem worded for the person who sees it beside the calendar. */
class FeedError extends Error {}

/**
 * The address of a feed as the one `fetch` will be given, or { error }.
 *
 * Only https, and only a name: a Worker is reachable from the page, so an
 * address that points at an IP or at localhost would let anyone who can save
 * a subscription make it fetch from places only the server can see. webcal://
 * is how calendars are shared and means https. Checked again on every
 * redirect, since a redirect is the usual way past this.
 */
export function feedUrl(input) {
  const s = String(input || "").trim().replace(/^webcals?:\/\//i, "https://");
  if (!s || s.length > 2000) return { error: "Enter the calendar's address" };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { error: "That is not a web address" };
  }
  if (u.protocol !== "https:") return { error: "Only https:// and webcal:// addresses can be subscribed to" };
  if (u.username || u.password) return { error: "An address with a user name or password is not supported" };
  if (u.port && u.port !== "443") return { error: "Only the standard port is supported" };
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const bare = !host.includes(".");
  const literal = host.includes(":") || /^\d+(\.\d+){0,3}$/.test(host) || /\.\d+$/.test(host);
  const own = host === "localhost" || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host);
  if (literal) return { error: "Use the calendar's name, not an IP address" };
  if (bare || own) return { error: "That address is not on the public web" };
  return { url: u.href };
}

/** The body of a response as text, refusing one past the size limit without reading it all. */
async function readCapped(res) {
  const tooBig = new FeedError(`That calendar is too large (over ${Math.round(LIM.feedBytes / 1_000_000)} MB)`);
  if (Number(res.headers.get("content-length")) > LIM.feedBytes) throw tooBig;
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    if (text.length > LIM.feedBytes) throw tooBig;
    return text;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > LIM.feedBytes) {
      reader.cancel().catch(() => {});
      throw tooBig;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(all);
}

/** The calendar a feed address serves, or a FeedError saying why not. */
async function fetchFeed(start) {
  let address = start;
  for (let hop = 0; hop <= LIM.feedRedirects; hop++) {
    const checked = feedUrl(address);
    if (checked.error) throw new FeedError(hop ? `The calendar moved somewhere it cannot follow. ${checked.error}` : checked.error);
    let res;
    try {
      res = await fetch(checked.url, {
        redirect: "manual",
        signal: AbortSignal.timeout(LIM.feedTimeoutMs),
        headers: { Accept: "text/calendar, text/plain;q=0.8, */*;q=0.5", "User-Agent": "Stratus calendar" },
      });
    } catch (e) {
      throw new FeedError(e?.name === "TimeoutError" || e?.name === "AbortError" ? "The server took too long to answer" : "Could not reach the server");
    }
    if (res.status >= 300 && res.status < 400) {
      const to = res.headers.get("location");
      try {
        address = new URL(to, checked.url).href;
      } catch {
        throw new FeedError("The server redirected somewhere that makes no sense");
      }
      continue;
    }
    if (!res.ok) throw new FeedError(`The server answered ${res.status}`);
    try {
      return await readCapped(res);
    } catch (e) {
      if (e instanceof FeedError) throw e;
      throw new FeedError(e?.name === "TimeoutError" || e?.name === "AbortError" ? "The server took too long to send it" : "The connection dropped while it was being read");
    }
  }
  throw new FeedError("Too many redirects");
}

/** A short stable hash of a string, for ids and change detection (not for secrets). */
function cyrb53(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Rule text kept as a normalised rule, or "" when it cannot be expanded here. */
const keepRule = (text) => {
  const r = parseRule(text);
  return r ? formatRule(r) : "";
};

const COLUMNS = [
  "id", "calendar_id", "uid", "summary", "location", "description", "url", "start_ms", "end_ms",
  "all_day", "tzid", "rrule", "exdates", "reminder_min", "recurrence_id", "created_at", "updated_at",
];
const INSERT = `INSERT OR REPLACE INTO cal_events (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`;
const insertEvent = (env, row) => env.DB.prepare(INSERT).bind(...COLUMNS.map((c) => row[c] ?? null));

/**
 * A parsed file's events as rows. `uidFor` gives an event with no UID one that
 * is the same next time, so a feed that never writes UIDs keeps its rows' ids
 * from one fetch to the next instead of making new ones.
 */
function rowsFrom(calendarId, events, { uidFor, idFor, reminders, now }) {
  const seen = new Set();
  const rows = [];
  for (const ev of events) {
    const uid = ev.uid || uidFor(ev);
    let id = idFor(uid, ev.recurrenceId);
    for (let n = 1; seen.has(id); n++) id = `${idFor(uid, ev.recurrenceId)}-${n}`; // a feed that repeats itself
    seen.add(id);
    rows.push({
      id,
      calendar_id: calendarId,
      uid,
      summary: ev.summary,
      location: ev.location,
      description: ev.description,
      url: ev.url,
      start_ms: ev.startMs,
      end_ms: ev.endMs,
      all_day: ev.allDay ? 1 : 0,
      tzid: ev.tzid,
      rrule: ev.recurrenceId === null ? keepRule(ev.rrule) : "",
      exdates: ev.recurrenceId === null ? ev.exdates.slice(0, 1000).join(",") : "",
      reminder_min: reminders && ev.recurrenceId === null ? ev.reminderMin : null,
      recurrence_id: ev.recurrenceId,
      created_at: now,
      updated_at: now,
    });
  }
  return rows;
}

/**
 * Fetches a subscription and replaces its events as a whole.
 *
 * Never throws: a failure is written on the calendar (`last_error`), where
 * the person looking at the calendar sees it, and the events it had stay. A
 * feed that parses to what was stored last time is left alone, which is also
 * how a feed whose only change is a new timestamp on every request costs one
 * read and no writes.
 */
export async function refreshCalendar(env, cal, now = Date.now()) {
  const settle = async (error) => {
    await env.DB.prepare("UPDATE calendars SET fetched_at=?, last_error=? WHERE id=?").bind(now, error, cal.id).run();
    return { ok: false, error };
  };
  try {
    const sealed = cal.url_sealed ? await open(env.ENC_KEY, cal.url_sealed) : null;
    if (!sealed?.url) return settle("The saved address cannot be read. Subscribe again.");
    const text = await fetchFeed(sealed.url);
    if (!/BEGIN:VCALENDAR/i.test(text)) return settle("That address did not return a calendar");
    const parsed = parseCalendar(text, { max: LIM.feedEvents });
    const rows = rowsFrom(cal.id, parsed.events, {
      uidFor: (ev) => `nouid-${cyrb53([ev.summary, ev.startMs, ev.endMs, ev.rrule, ev.recurrenceId].join("|"))}`,
      idFor: (uid, rid) => `s-${cal.id.slice(0, 8)}-${cyrb53(`${uid}|${rid ?? ""}`)}`,
      reminders: false, // a feed's alarms are its author's, not this person's
      now,
    });
    const note = parsed.skipped && rows.length >= LIM.feedEvents ? `Showing the first ${LIM.feedEvents} events` : "";
    const fingerprint = cyrb53(
      JSON.stringify(rows.map((r) => COLUMNS.filter((c) => !/_at$/.test(c)).map((c) => r[c])).sort())
    );
    if (fingerprint === cal.hash) {
      await env.DB.prepare("UPDATE calendars SET fetched_at=?, last_error=? WHERE id=?").bind(now, note, cal.id).run();
      return { ok: true, changed: false, events: rows.length };
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM cal_events WHERE calendar_id=?").bind(cal.id),
      ...rows.map((r) => insertEvent(env, r)),
      env.DB.prepare("UPDATE calendars SET fetched_at=?, last_error=?, hash=? WHERE id=?").bind(now, note, fingerprint, cal.id),
    ]);
    return { ok: true, changed: true, events: rows.length };
  } catch (e) {
    if (!(e instanceof FeedError)) console.log(`calendar ${cal.id}: ${e && e.stack ? e.stack : e}`);
    return settle(e instanceof FeedError ? e.message : "Could not read that calendar");
  }
}

/** Subscriptions whose time has come, a couple a minute so one slow feed cannot hog the heartbeat. */
async function refreshDue(env, now = Date.now()) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM calendars WHERE kind='subscription' AND (fetched_at IS NULL OR fetched_at + refresh_min*60000 <= ?)
     ORDER BY fetched_at LIMIT 2`
  )
    .bind(now)
    .all();
  for (const cal of results ?? []) {
    // Claimed before it is fetched, so two overlapping runs do not fetch one feed twice.
    const claimed = await env.DB.prepare(
      "UPDATE calendars SET fetched_at=? WHERE id=? AND (fetched_at IS NULL OR fetched_at + refresh_min*60000 <= ?)"
    )
      .bind(now, cal.id, now)
      .run();
    if (claimed.meta?.changes) await refreshCalendar(env, cal, now);
  }
}

// ── events: reading ────────────────────────────────────────

const getEvent = (env, id) => env.DB.prepare("SELECT * FROM cal_events WHERE id=?").bind(id).first();
const wallType = (r) => !!r.all_day || !r.tzid;
const exdatesOf = (r) => String(r.exdates || "").split(",").filter(Boolean).map(Number);

/** What the sheet needs to show and edit one event. */
function eventOf(r, cal) {
  return {
    id: r.id,
    calendarId: r.calendar_id,
    calendarName: cal?.name ?? "",
    uid: r.uid,
    summary: r.summary,
    location: r.location,
    description: r.description,
    url: httpsUrl(r.url),
    start: r.start_ms,
    end: r.end_ms,
    allDay: !!r.all_day,
    tzid: r.tzid,
    floating: wallType(r) && !r.all_day,
    rrule: r.rrule,
    reminderMin: r.reminder_min,
    recurrenceId: r.recurrence_id,
    recurring: !!r.rrule || r.recurrence_id !== null,
    readOnly: cal ? cal.kind !== "local" : true,
  };
}

/** One occurrence in the shape the views draw. */
const occurrenceOf = (r, startMs, endMs, recurrenceId, recurring) => ({
  id: recurring && recurrenceId !== null && r.recurrence_id === null ? `${r.id}@${recurrenceId}` : r.id,
  eventId: r.id,
  calendarId: r.calendar_id,
  start: startMs,
  end: endMs,
  allDay: !!r.all_day,
  floating: !r.all_day && !r.tzid,
  summary: r.summary,
  location: r.location,
  recurring,
  occurrence: recurring ? recurrenceId : null,
  readOnly: false, // set by the caller, who knows the calendar
});

/**
 * The occurrences that touch [from, to), invitations among them.
 *
 * An all-day date or an hour with no zone has no instant, so the window is
 * widened by a day and a half for those and the page places each by the day
 * it is written on. A timed event is held to the window exactly.
 */
export async function readWindow(env, from, to) {
  const M = 1.5 * DAY;
  const cals = new Map((await listCalendars(env)).map((c) => [c.id, c]));
  const out = [];
  const push = (o) => {
    o.readOnly = cals.get(o.calendarId)?.readOnly ?? true;
    out.push(o);
  };
  const touches = (r, s, e) => {
    const [lo, hi] = wallType(r) ? [from - M, to + M] : [from, to];
    return s < hi && (e > lo || s >= lo);
  };

  const { results: singles } = await env.DB.prepare(
    "SELECT * FROM cal_events WHERE rrule='' AND recurrence_id IS NULL AND start_ms < ? AND end_ms > ?"
  )
    .bind(to + M, from - M)
    .all();
  for (const r of singles ?? []) if (touches(r, r.start_ms, r.end_ms)) push(occurrenceOf(r, r.start_ms, r.end_ms, null, false));

  const { results: masters } = await env.DB.prepare(
    "SELECT * FROM cal_events WHERE rrule<>'' AND recurrence_id IS NULL AND start_ms < ?"
  )
    .bind(to + M)
    .all();
  const { results: edited } = (masters ?? []).length
    ? await env.DB.prepare(
        `SELECT o.* FROM cal_events o WHERE o.recurrence_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM cal_events m WHERE m.calendar_id=o.calendar_id AND m.uid=o.uid
             AND m.recurrence_id IS NULL AND m.rrule<>'' AND m.start_ms < ?)`
      )
        .bind(to + M)
        .all()
    : { results: [] };
  const overrides = new Map();
  for (const o of edited ?? []) {
    const k = `${o.calendar_id}|${o.uid}`;
    overrides.set(k, [...(overrides.get(k) ?? []), { ...o, recurrenceId: o.recurrence_id, startMs: o.start_ms, endMs: o.end_ms }]);
  }
  for (const m of masters ?? []) {
    const series = { startMs: m.start_ms, endMs: m.end_ms, allDay: !!m.all_day, tzid: m.tzid, rule: m.rrule, exdates: exdatesOf(m) };
    const [lo, hi] = wallType(m) ? [from - M, to + M] : [from, to];
    for (const o of occurrences(series, overrides.get(`${m.calendar_id}|${m.uid}`) ?? [], lo, hi)) {
      push(occurrenceOf(o.override ?? m, o.startMs, o.endMs, o.recurrenceId, true));
    }
  }

  // Invitations: the meetings the mail sync found, with the answer given to each.
  const { results: invites } = await env.DB.prepare(
    `SELECT e.*, m.subject AS msg_subject, s.value AS rsvp
     FROM events e JOIN messages m ON m.id = e.id
     LEFT JOIN settings s ON s.key = 'rsvp_' || e.id
     WHERE m.folder NOT IN ('trash', 'spam') AND e.start_ms < ? AND e.end_ms > ?`
  )
    .bind(to + M, from - M)
    .all();
  for (const e of invites ?? []) {
    out.push({
      id: `inv:${e.id}`,
      eventId: e.id,
      calendarId: INVITATIONS.id,
      start: e.start_ms,
      end: e.end_ms,
      allDay: !!e.all_day,
      floating: !!e.floating,
      summary: e.summary || e.msg_subject || "Meeting",
      location: e.location,
      recurring: false,
      occurrence: null,
      readOnly: true,
      messageId: e.id,
      status: e.status,
      rsvp: e.rsvp || "",
      organizer: e.organizer,
      url: httpsUrl(e.url),
    });
  }

  out.sort((a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : 1));
  return out.slice(0, LIM.windowOut);
}

// ── events: writing ────────────────────────────────────────

const clip = (v, n) => String(v ?? "").slice(0, n);
const whole = (v) => (v === null || v === undefined || v === "" ? NaN : Math.round(Number(v)));
const midnight = (ms) => Math.floor(ms / DAY) * DAY;
/** Whether a zone name is one Intl knows. */
const knownZone = (z) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: z });
    return true;
  } catch {
    return false;
  }
};

/**
 * The event a request describes, laid over `base` (the row it edits, if any).
 * Returns { row } with only the columns the request set, or { error }.
 */
function readEvent(b, base) {
  const row = {};
  if (b.summary !== undefined) row.summary = clip(b.summary, 300).trim();
  if (b.location !== undefined) row.location = clip(b.location, 300);
  if (b.description !== undefined) row.description = clip(b.description, 4000);
  if (b.url !== undefined) row.url = httpsUrl(b.url);
  const allDay = b.allDay !== undefined ? !!b.allDay : base ? !!base.all_day : false;
  row.all_day = allDay ? 1 : 0;

  let tzid = b.tzid !== undefined ? String(b.tzid) : base ? base.tzid : "UTC";
  if (tzid && !knownZone(tzid)) return { error: "That time zone is not known" };
  row.tzid = tzid;

  if (b.start !== undefined || b.end !== undefined || !base) {
    let s = whole(b.start ?? base?.start_ms);
    let e = whole(b.end ?? base?.end_ms);
    if (!Number.isFinite(s)) return { error: "Give the event a start" };
    if (!Number.isFinite(e)) e = s + (allDay ? DAY : 3600_000);
    if (allDay) {
      s = midnight(s);
      e = Math.max(midnight(e), s + DAY);
    }
    if (e < s) return { error: "The event cannot end before it starts" };
    row.start_ms = s;
    row.end_ms = e;
  }
  if (b.reminderMin !== undefined) {
    if (b.reminderMin === null || b.reminderMin === "") row.reminder_min = null;
    else {
      const n = whole(b.reminderMin);
      if (!(n >= -1440 && n <= 40_320)) return { error: "That reminder is not one that can be set" };
      row.reminder_min = n;
    }
  }
  if (b.rrule !== undefined) {
    const text = String(b.rrule || "").trim();
    if (!text) row.rrule = "";
    else {
      const rule = parseRule(text);
      if (!rule) return { error: "That repeat is not one this calendar can keep" };
      row.rrule = formatRule(rule);
    }
  }
  return { row };
}

/** A series' start moved to its first occurrence, which a rule's own days may put after it. */
function alignToRule(r) {
  if (!r.rrule) return r;
  const s = { startMs: r.start_ms, endMs: r.end_ms, allDay: !!r.all_day, tzid: r.tzid, rule: r.rrule };
  const first = expand(s, r.start_ms, r.start_ms + 1500 * DAY, { limit: 1 })[0];
  if (!first) return null;
  const by = first.startMs - r.start_ms;
  return by ? { ...r, start_ms: r.start_ms + by, end_ms: r.end_ms + by } : r;
}

/** The instant a stored start means, for ringing: an all-day or floating one has only a wall time. */
const instantOfStart = (r, ms) => (wallType(r) ? instantOf({ tzid: r.tzid || "UTC", allDay: false }, ms) : ms);

/** "In 10 minutes", "Tomorrow": what a reminder says about when. */
function whenText(r) {
  const m = r.reminder_min;
  if (r.all_day) return m <= 0 ? "Today" : m <= 1440 ? "Tomorrow" : `In ${Math.ceil(m / 1440)} days`;
  if (m <= 0) return "Starting now";
  if (m < 60) return `In ${m} minute${m === 1 ? "" : "s"}`;
  if (m === 1440) return "Tomorrow";
  if (m % 1440 === 0) return `In ${m / 1440} days`;
  if (m % 60 === 0) return `In ${m / 60} hour${m === 60 ? "" : "s"}`;
  return `In ${m} minutes`;
}

/**
 * When an event's reminder should next ring, as { at, start } for the first
 * occurrence whose reminder time is still ahead; null when there is none.
 * Pure: `overrides` are the series' edited occurrences, as rows.
 */
export function nextReminder(r, overrides, now = Date.now()) {
  if (r.reminder_min === null || r.reminder_min === undefined || r.recurrence_id !== null) return null;
  const lead = r.reminder_min * 60_000;
  const pick = (list) => {
    let best = null;
    for (const s of list) {
      const at = instantOfStart(r, s) - lead;
      if (at > now && (!best || at < best.at)) best = { at, start: s };
    }
    return best;
  };
  if (!r.rrule) return pick([r.start_ms]);
  const series = { startMs: r.start_ms, endMs: r.end_ms, allDay: !!r.all_day, tzid: r.tzid, rule: r.rrule, exdates: exdatesOf(r) };
  const edited = overrides.map((o) => ({ recurrenceId: o.recurrence_id, startMs: o.start_ms, endMs: o.end_ms }));
  // Started looking a day and a half before the earliest start that can still
  // ring, which keeps the straddling occurrences few for a daily series.
  const from = now + lead - 1.5 * DAY;
  return pick(occurrences(series, edited, from, from + 1500 * DAY, { limit: 24 }).map((o) => o.startMs));
}

const reminderBody = (r) => [whenText(r), r.location].filter(Boolean).join(" · ");

async function overridesOf(env, r) {
  const { results } = await env.DB.prepare("SELECT * FROM cal_events WHERE calendar_id=? AND uid=? AND recurrence_id IS NOT NULL")
    .bind(r.calendar_id, r.uid)
    .all();
  return results ?? [];
}

/** Makes the event's one reminder say what its next occurrence needs, or removes it. */
export async function armReminder(env, r, now = Date.now()) {
  if (r.recurrence_id !== null) return;
  const next = nextReminder(r, r.rrule ? await overridesOf(env, r) : [], now);
  if (!next) return clearReminder(env, "event", r.id);
  await setReminder(env, { kind: "event", ref: r.id, title: r.summary || "Event", body: reminderBody(r), at: next.at });
}

/**
 * A recurring event's reminder, once the occurrence it was for has been
 * dismissed or is over, moves to the next occurrence.
 *
 * It waits for one of those rather than moving the moment it rings: the
 * reminder that rang stays on the list, and in the notification, until it is
 * dealt with, and the next one replaces it only then.
 */
async function advanceReminders(env, now = Date.now()) {
  const { results } = await env.DB.prepare(
    `SELECT e.*, r.base_at AS rem_at, r.dismissed_at AS rem_dismissed
     FROM reminders r JOIN cal_events e ON e.id = r.ref
     WHERE r.kind='event' AND r.fired_at IS NOT NULL AND r.base_at <= ? AND e.rrule <> '' AND e.recurrence_id IS NULL`
  )
    .bind(now)
    .all();
  for (const r of results ?? []) {
    const startedAt = r.rem_at + r.reminder_min * 60_000;
    const over = startedAt + (r.end_ms - r.start_ms) <= now;
    if (r.rem_dismissed || over) await armReminder(env, r, now);
  }
}

// ── events: requests ───────────────────────────────────────

const bad = (error, status = 400) => json({ error }, status);

async function createEvent(env, b) {
  await ensureLocal(env);
  let cal = b.calendarId
    ? await getCalendar(env, String(b.calendarId))
    : await env.DB.prepare("SELECT * FROM calendars WHERE kind='local' ORDER BY position, created_at LIMIT 1").first();
  if (!cal) return bad("No such calendar", 404);
  if (cal.kind !== "local") return bad("That calendar is read-only");
  const { row, error } = readEvent(b, null);
  if (error) return bad(error);
  const now = Date.now();
  const aligned = alignToRule({
    id: crypto.randomUUID(),
    calendar_id: cal.id,
    uid: `${crypto.randomUUID()}@stratus`,
    summary: "",
    location: "",
    description: "",
    url: "",
    rrule: "",
    exdates: "",
    reminder_min: null,
    recurrence_id: null,
    created_at: now,
    updated_at: now,
    ...row,
  });
  if (!aligned) return bad("That repeat never happens");
  await insertEvent(env, aligned).run();
  await armReminder(env, aligned, now);
  return json({ event: eventOf(aligned, cal) }, 201);
}

/** The series an edited occurrence belongs to. */
const masterOf = (env, o) =>
  env.DB.prepare("SELECT * FROM cal_events WHERE calendar_id=? AND uid=? AND recurrence_id IS NULL").bind(o.calendar_id, o.uid).first();

/** Both edits of a series at once: its own text, and moving the whole of it. */
async function editSeries(env, master, b, shownStart) {
  const { row, error } = readEvent(b, master);
  if (error) return { error };
  let next = { ...master, ...row, updated_at: Date.now() };
  if (b.start !== undefined) {
    // The page says where the occurrence it edited stood and where it stands
    // now. The series moves by that much on the wall clock, so a 9:00 meeting
    // dragged to 10:00 is 10:00 every week, across clock changes too.
    const was = { tzid: master.tzid, allDay: !!master.all_day };
    const now = { tzid: next.tzid, allDay: !!next.all_day };
    const shown = Number.isFinite(whole(b.from)) ? whole(b.from) : shownStart;
    const by = wallOf(now, row.start_ms) - wallOf(was, shown);
    const length = row.end_ms - row.start_ms;
    next.start_ms = instantOf(now, wallOf(was, master.start_ms) + by);
    if (next.all_day) next.start_ms = midnight(next.start_ms);
    next.end_ms = next.start_ms + length;
  }
  const aligned = alignToRule(next);
  if (!aligned) return { error: "That repeat never happens" };
  const timing = ["start_ms", "end_ms", "all_day", "tzid", "rrule"].some((k) => aligned[k] !== master[k]);
  // New timing makes the one-off edits and removals of the old one meaningless.
  if (timing) aligned.exdates = "";
  return { row: aligned, timing };
}

async function patchEvent(env, id, b) {
  const row = await getEvent(env, id);
  if (!row) return bad("No such event", 404);
  const cal = await getCalendar(env, row.calendar_id);
  if (!cal || cal.kind !== "local") return bad("That calendar is read-only", 403);
  if (b.calendarId !== undefined && b.calendarId !== row.calendar_id) {
    const to = await getCalendar(env, String(b.calendarId));
    if (!to || to.kind !== "local") return bad("Move it to one of your own calendars");
  }
  const scope = b.scope === "one" ? "one" : "all";
  const now = Date.now();

  // One occurrence of a series, edited alone.
  if (scope === "one" && (row.rrule || row.recurrence_id !== null)) {
    const master = row.recurrence_id === null ? row : await masterOf(env, row);
    if (!master) return bad("That series is gone", 404);
    const rid = row.recurrence_id !== null ? row.recurrence_id : whole(b.occurrence);
    if (!Number.isFinite(rid)) return bad("Say which occurrence");
    const mine = row.recurrence_id !== null ? row : (await overridesOf(env, master)).find((o) => o.recurrence_id === rid);
    if (!mine) {
      const series = { startMs: master.start_ms, endMs: master.end_ms, allDay: !!master.all_day, tzid: master.tzid, rule: master.rrule, exdates: exdatesOf(master) };
      if (expand(series, rid, rid + 1, { limit: 1 })[0]?.startMs !== rid) return bad("The series has no occurrence there");
    }
    const base = mine ?? { ...master, start_ms: rid, end_ms: rid + (master.end_ms - master.start_ms), reminder_min: null };
    const { row: edit, error } = readEvent({ ...b, rrule: undefined, reminderMin: undefined, tzid: undefined }, base);
    if (error) return bad(error);
    const saved = {
      ...base,
      ...edit,
      id: mine ? mine.id : crypto.randomUUID(),
      calendar_id: master.calendar_id,
      uid: master.uid,
      rrule: "",
      exdates: "",
      reminder_min: null,
      recurrence_id: rid,
      created_at: mine ? mine.created_at : now,
      updated_at: now,
    };
    await insertEvent(env, saved).run();
    await armReminder(env, master, now);
    return json({ event: eventOf(saved, cal) });
  }

  // The whole series, from one of its occurrences.
  if (row.rrule || row.recurrence_id !== null) {
    const master = row.recurrence_id === null ? row : await masterOf(env, row);
    if (!master) return bad("That series is gone", 404);
    const shown = row.recurrence_id !== null ? row.start_ms : master.start_ms;
    const done = await editSeries(env, master, b, shown);
    if (done.error) return bad(done.error);
    const to = b.calendarId ? String(b.calendarId) : master.calendar_id;
    done.row.calendar_id = to;
    const stmts = [];
    if (done.timing || !done.row.rrule) {
      stmts.push(env.DB.prepare("DELETE FROM cal_events WHERE calendar_id=? AND uid=? AND recurrence_id IS NOT NULL").bind(master.calendar_id, master.uid));
    } else if (to !== master.calendar_id) {
      stmts.push(env.DB.prepare("UPDATE cal_events SET calendar_id=? WHERE calendar_id=? AND uid=? AND recurrence_id IS NOT NULL").bind(to, master.calendar_id, master.uid));
    }
    await env.DB.batch([...stmts, insertEvent(env, done.row)]);
    await armReminder(env, done.row, now);
    return json({ event: eventOf(done.row, cal) });
  }

  // An event that does not repeat, which may start to.
  const { row: edit, error } = readEvent(b, row);
  if (error) return bad(error);
  const merged = alignToRule({ ...row, ...edit, ...(b.calendarId ? { calendar_id: String(b.calendarId) } : {}), updated_at: now });
  if (!merged) return bad("That repeat never happens");
  await insertEvent(env, merged).run();
  await armReminder(env, merged, now);
  return json({ event: eventOf(merged, cal) });
}

async function deleteEvent(env, id, scope, occurrence) {
  const row = await getEvent(env, id);
  if (!row) return json({ ok: true }); // gone is what was asked for
  const cal = await getCalendar(env, row.calendar_id);
  if (!cal || cal.kind !== "local") return bad("That calendar is read-only", 403);
  const isSeries = !!row.rrule || row.recurrence_id !== null;
  const master = !isSeries ? row : row.recurrence_id === null ? row : await masterOf(env, row);

  if (scope === "one" && isSeries) {
    const rid = row.recurrence_id !== null ? row.recurrence_id : whole(occurrence);
    if (!Number.isFinite(rid)) return bad("Say which occurrence");
    if (!master) return json({ ok: true });
    const ex = [...new Set([...exdatesOf(master), rid])].slice(-1000).join(",");
    await env.DB.batch([
      env.DB.prepare("UPDATE cal_events SET exdates=?, updated_at=? WHERE id=?").bind(ex, Date.now(), master.id),
      env.DB.prepare("DELETE FROM cal_events WHERE calendar_id=? AND uid=? AND recurrence_id=?").bind(master.calendar_id, master.uid, rid),
    ]);
    await armReminder(env, { ...master, exdates: ex });
    return json({ ok: true });
  }

  const target = master ?? row;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM cal_events WHERE calendar_id=? AND uid=?").bind(target.calendar_id, target.uid),
  ]);
  await clearReminder(env, "event", target.id);
  return json({ ok: true });
}

// ── import and export ──────────────────────────────────────

async function importInto(env, cal, text) {
  if (!/BEGIN:VCALENDAR/i.test(text)) return bad("That file is not a calendar");
  const parsed = parseCalendar(text, { max: LIM.importEvents });
  const now = Date.now();
  // The rows already here, so an event imported again takes the place of the
  // one it was, rather than doubling it.
  const { results: have } = await env.DB.prepare("SELECT id, uid, recurrence_id FROM cal_events WHERE calendar_id=?").bind(cal.id).all();
  const known = new Map((have ?? []).map((r) => [`${r.uid}|${r.recurrence_id ?? ""}`, r.id]));
  const rows = rowsFrom(cal.id, parsed.events, {
    uidFor: () => `${crypto.randomUUID()}@stratus`,
    idFor: () => crypto.randomUUID(),
    reminders: true,
    now,
  }).map((r) => ({ ...r, id: known.get(`${r.uid}|${r.recurrence_id ?? ""}`) ?? r.id }));
  const aligned = rows.map((r) => (r.recurrence_id === null ? alignToRule(r) ?? { ...r, rrule: "" } : r));
  const droppedRules = parsed.events.filter((e, i) => e.rrule && !aligned[i].rrule).length;
  for (let i = 0; i < aligned.length; i += 400) {
    await env.DB.batch(aligned.slice(i, i + 400).map((r) => insertEvent(env, r)));
  }
  let armed = 0;
  let unarmed = 0;
  const overrides = new Map();
  for (const r of aligned) if (r.recurrence_id !== null) overrides.set(r.uid, [...(overrides.get(r.uid) ?? []), r]);
  for (const r of aligned) {
    if (r.recurrence_id !== null) continue;
    if (r.reminder_min === null && !known.has(`${r.uid}|`)) continue;
    if (r.reminder_min !== null && !nextReminder(r, overrides.get(r.uid) ?? [], now)) {
      await clearReminder(env, "event", r.id);
      continue;
    }
    if (armed >= LIM.importReminders) {
      unarmed++;
      continue;
    }
    armed++;
    await armReminder(env, r, now);
  }
  return json({ imported: aligned.length, skipped: parsed.skipped, droppedRules, unarmed });
}

async function exportOf(env, cal) {
  const { results } = await env.DB.prepare("SELECT * FROM cal_events WHERE calendar_id=? ORDER BY uid, recurrence_id").bind(cal.id).all();
  const safe = cal.name.replace(/[^\w .-]+/g, "").trim().slice(0, 60) || "calendar";
  return new Response(writeCalendar(cal.name, results ?? []), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safe}.ics"`,
      "Cache-Control": "no-store",
    },
  });
}

// ── routes ─────────────────────────────────────────────────

async function createCalendar(env, b) {
  const { name, color, error } = nameAndColor(b);
  if (error) return bad(error);
  const { n } = await env.DB.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM calendars").first();
  const id = crypto.randomUUID();
  const now = Date.now();
  if (b.url === undefined) {
    await ensureLocal(env);
    await env.DB.prepare("INSERT INTO calendars (id, name, color, kind, position, created_at) VALUES (?, ?, ?, 'local', ?, ?)").bind(id, name, color, n, now).run();
    return json({ calendar: await shownCalendar(env, id) }, 201);
  }
  const feed = feedUrl(b.url);
  if (feed.error) return bad(feed.error);
  const sealed = await seal(env.ENC_KEY, { url: feed.url });
  await env.DB.prepare(
    "INSERT INTO calendars (id, name, color, kind, url_sealed, refresh_min, position, created_at) VALUES (?, ?, ?, 'subscription', ?, ?, ?, ?)"
  )
    .bind(id, name, color, sealed, refreshMinutes(b.refreshMin), n, now)
    .run();
  // The first fetch is made now so the person sees events, or the reason there are none.
  await refreshCalendar(env, await getCalendar(env, id), now);
  return json({ calendar: await shownCalendar(env, id) }, 201);
}

async function patchCalendar(env, cal, b) {
  const { name, color, error } = nameAndColor(b, cal);
  if (error) return bad(error);
  let refresh = cal.refresh_min;
  let sealed = cal.url_sealed;
  let reset = false;
  if (cal.kind === "subscription") {
    if (b.refreshMin !== undefined) refresh = refreshMinutes(b.refreshMin, cal.refresh_min);
    if (b.url) {
      const feed = feedUrl(b.url);
      if (feed.error) return bad(feed.error);
      sealed = await seal(env.ENC_KEY, { url: feed.url });
      reset = true;
    }
  }
  await env.DB.prepare(
    `UPDATE calendars SET name=?, color=?, refresh_min=?, url_sealed=?${reset ? ", hash='', fetched_at=NULL, last_error=''" : ""} WHERE id=?`
  )
    .bind(name, color, refresh, sealed, cal.id)
    .run();
  if (reset) await refreshCalendar(env, await getCalendar(env, cal.id));
  return json({ calendar: await shownCalendar(env, cal.id) });
}

async function deleteCalendar(env, cal) {
  if (cal.kind === "local") {
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM calendars WHERE kind='local'").first();
    if (n <= 1) return bad("Keep at least one calendar of your own");
  }
  const { results } = await env.DB.prepare("SELECT id FROM cal_events WHERE calendar_id=? AND reminder_min IS NOT NULL").bind(cal.id).all();
  for (const r of results ?? []) await clearReminder(env, "event", r.id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM cal_events WHERE calendar_id=?").bind(cal.id),
    env.DB.prepare("DELETE FROM calendars WHERE id=?").bind(cal.id),
  ]);
  return json({ ok: true });
}

async function api(request, env, path) {
  const method = request.method;

  if (path === "/api/calendar/calendars") {
    if (method === "GET") return json({ calendars: [...(await listCalendars(env)), INVITATIONS] });
    if (method === "POST") return createCalendar(env, await request.json().catch(() => ({})));
    return null;
  }

  const one = path.match(/^\/api\/calendar\/calendars\/([^/]+)$/);
  if (one && (method === "PATCH" || method === "DELETE")) {
    const cal = await getCalendar(env, decodeURIComponent(one[1]));
    if (!cal) return bad("No such calendar", 404);
    return method === "DELETE" ? deleteCalendar(env, cal) : patchCalendar(env, cal, await request.json().catch(() => ({})));
  }

  const refresh = path.match(/^\/api\/calendar\/calendars\/([^/]+)\/refresh$/);
  if (refresh && method === "POST") {
    const cal = await getCalendar(env, decodeURIComponent(refresh[1]));
    if (!cal) return bad("No such calendar", 404);
    if (cal.kind !== "subscription") return bad("Only a subscription can be refreshed");
    const done = await refreshCalendar(env, cal);
    return json({ ...done, calendar: await shownCalendar(env, cal.id) });
  }

  const exported = path.match(/^\/api\/calendar\/calendars\/([^/]+)\/export$/);
  if (exported && method === "GET") {
    const cal = await getCalendar(env, decodeURIComponent(exported[1]));
    return cal ? exportOf(env, cal) : bad("No such calendar", 404);
  }

  const imported = path.match(/^\/api\/calendar\/calendars\/([^/]+)\/import$/);
  if (imported && method === "POST") {
    const cal = await getCalendar(env, decodeURIComponent(imported[1]));
    if (!cal) return bad("No such calendar", 404);
    if (cal.kind !== "local") return bad("Import into one of your own calendars");
    if (Number(request.headers.get("content-length")) > LIM.importBytes) return bad("That file is too large", 413);
    const text = await request.text();
    if (text.length > LIM.importBytes) return bad("That file is too large", 413);
    return importInto(env, cal, text);
  }

  if (path === "/api/calendar/events") {
    if (method === "GET") {
      const u = new URL(request.url);
      const from = whole(u.searchParams.get("from"));
      const to = whole(u.searchParams.get("to"));
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return bad("Say which days, with from and to in milliseconds");
      if (to - from > LIM.windowDays * DAY) return bad(`Ask for at most ${LIM.windowDays} days at a time`);
      return json({ from, to, events: await readWindow(env, from, to) });
    }
    if (method === "POST") return createEvent(env, await request.json().catch(() => ({})));
    return null;
  }

  const ev = path.match(/^\/api\/calendar\/events\/([^/]+)$/);
  if (ev) {
    const id = decodeURIComponent(ev[1]);
    if (method === "GET") {
      const row = await getEvent(env, id);
      return row ? json({ event: eventOf(row, await getCalendar(env, row.calendar_id)) }) : bad("No such event", 404);
    }
    if (method === "PATCH") return patchEvent(env, id, await request.json().catch(() => ({})));
    if (method === "DELETE") {
      const u = new URL(request.url);
      return deleteEvent(env, id, u.searchParams.get("scope") === "one" ? "one" : "all", u.searchParams.get("occurrence"));
    }
  }
  return null;
}

export const calendarModule = {
  name: "calendar",
  api,
  cron: async (env) => {
    await refreshDue(env);
    await advanceReminders(env);
  },
  tables: ["calendars", "cal_events"],
};
