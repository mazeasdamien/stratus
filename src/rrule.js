/**
 * Recurrence rules (RFC 5545 §3.3.10), expanded inside a window.
 *
 * Pure functions, no Workers API, tested by test/rrule.test.mjs.
 *
 * An event is one start, one end and a rule. The occurrences are never
 * stored: the calendar asks for the ones inside the window it is drawing, and
 * gets them here. That keeps a "every weekday, forever" meeting one row, and
 * lets editing the series change every future occurrence at once.
 *
 * Every occurrence is worked out in *wall time*: the clock on the wall of the
 * event's own zone, held as a UTC number so plain date arithmetic needs no
 * calendar library. A 9:00 meeting in Europe/Paris is 9:00 on the wall every
 * week, and only turned into an instant at the end, with the zone's offset on
 * that day, so it stays at 9:00 local across a clock change instead of
 * drifting an hour. An all-day event and a "floating" one (an hour with no
 * zone) have no zone to turn back through, and their wall time is their
 * stored number, which is how src/ics.js models them.
 *
 * Nothing here trusts a rule. It can come from any calendar someone
 * subscribes to, so every expansion is bounded three ways: by the window, by
 * a cap on what it returns and by a cap on the periods it will step through.
 */

import { zoneOffset } from "./ics.js";

const DAY = 86_400_000;
const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const WD_NAME = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/**
 * The ceilings. Mutable so a test can see one hit without waiting for it.
 *
 * `out` is the most occurrences one expansion returns, `steps` the most
 * periods (days, weeks, months or years) it steps through, `count` the
 * largest COUNT a rule keeps.
 */
export const LIMITS = { out: 2000, steps: 60_000, count: 5000 };

// ── the rule ───────────────────────────────────────────────

const int = (s) => (/^[+-]?\d+$/.test(s) ? Number(s) : NaN);

/** UNTIL as { ms, date, utc }: a date, a UTC time, or a time with no zone. */
function parseUntil(v) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return { ms, date: m[4] === undefined, utc: !!m[7] };
}

const two = (n) => String(n).padStart(2, "0");
function formatUntil(u) {
  const d = new Date(u.ms);
  const day = `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}`;
  if (u.date) return day;
  return `${day}T${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}${u.utc ? "Z" : ""}`;
}

/**
 * The text of a rule ("FREQ=WEEKLY;BYDAY=MO,WE", with or without RRULE:) as
 * a rule, or null when it is not one this module can expand: a frequency
 * finer than a day, a part it does not implement (BYHOUR, BYYEARDAY…) or a
 * value out of range. Null rather than a guess: a rule read wrongly would
 * put events on days they are not on.
 */
export function parseRule(text) {
  const src = String(text || "").trim().replace(/^RRULE:/i, "");
  if (!src || src.length > 500) return null;
  const rule = { freq: "", interval: 1, count: 0, until: null, byday: [], bymonthday: [], bymonth: [], bysetpos: [], wkst: 1 };
  for (const part of src.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) return null;
    const k = part.slice(0, eq).toUpperCase();
    const v = part.slice(eq + 1).toUpperCase();
    const list = () => v.split(",");
    switch (k) {
      case "FREQ":
        if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(v)) return null;
        rule.freq = v;
        break;
      case "INTERVAL": {
        const n = int(v);
        if (!(n >= 1 && n <= 999)) return null;
        rule.interval = n;
        break;
      }
      case "COUNT": {
        const n = int(v);
        if (!(n >= 1)) return null;
        rule.count = Math.min(n, LIMITS.count);
        break;
      }
      case "UNTIL":
        rule.until = parseUntil(v);
        if (!rule.until) return null;
        break;
      case "BYDAY":
        for (const e of list()) {
          const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(e);
          if (!m) return null;
          const n = m[1] ? int(m[1]) : 0;
          if (Math.abs(n) > 53 || (m[1] && n === 0)) return null;
          rule.byday.push({ n, wd: WD[m[2]] });
        }
        break;
      case "BYMONTHDAY":
        for (const e of list()) {
          const n = int(e);
          if (!(Math.abs(n) >= 1 && Math.abs(n) <= 31)) return null;
          rule.bymonthday.push(n);
        }
        break;
      case "BYMONTH":
        for (const e of list()) {
          const n = int(e);
          if (!(n >= 1 && n <= 12)) return null;
          rule.bymonth.push(n);
        }
        break;
      case "BYSETPOS":
        for (const e of list()) {
          const n = int(e);
          if (!(Math.abs(n) >= 1 && Math.abs(n) <= 366)) return null;
          rule.bysetpos.push(n);
        }
        break;
      case "WKST":
        if (!(v in WD)) return null;
        rule.wkst = WD[v];
        break;
      default:
        return null;
    }
  }
  return rule.freq ? rule : null;
}

/** A rule back to text, in one fixed order, for storing and for .ics. */
export function formatRule(rule) {
  const p = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) p.push(`INTERVAL=${rule.interval}`);
  if (rule.count) p.push(`COUNT=${rule.count}`);
  if (rule.until) p.push(`UNTIL=${formatUntil(rule.until)}`);
  if (rule.byday.length) p.push(`BYDAY=${rule.byday.map((e) => (e.n || "") + WD_NAME[e.wd]).join(",")}`);
  if (rule.bymonthday.length) p.push(`BYMONTHDAY=${rule.bymonthday.join(",")}`);
  if (rule.bymonth.length) p.push(`BYMONTH=${rule.bymonth.join(",")}`);
  if (rule.bysetpos.length) p.push(`BYSETPOS=${rule.bysetpos.join(",")}`);
  if (rule.wkst !== 1) p.push(`WKST=${WD_NAME[rule.wkst]}`);
  return p.join(";");
}

// ── wall time ──────────────────────────────────────────────

/** Whether this event's clock is a zone's, as opposed to a bare date or hour. */
const zoned = (e) => !e.allDay && !!e.tzid && zoneOffset(e.tzid, 0) !== null;

/**
 * The stored time as the wall clock reads it. For a zoned event that is the
 * instant plus the zone's offset then; for the rest it is the number itself.
 */
export function wallOf(e, ms) {
  return zoned(e) ? ms + zoneOffset(e.tzid, ms) : ms;
}

/**
 * A wall time as a stored time. The offset is asked twice, the second time at
 * the instant the first answer gives, which lands right on both sides of a
 * clock change: 02:30 on the night the clocks go forward does not exist and
 * comes out an hour later, and the repeated hour of autumn comes out once.
 */
export function instantOf(e, wall) {
  if (!zoned(e)) return wall;
  const first = zoneOffset(e.tzid, wall);
  return wall - zoneOffset(e.tzid, wall - first);
}

// ── candidate days ─────────────────────────────────────────

const dim = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const weekday = (y, m, d) => new Date(Date.UTC(y, m, d)).getUTCDay();

/** True when day `d` of the month is one the BYDAY list names, ordinals counted in the month. */
function inMonthByday(list, y, m, d, n) {
  const wd = weekday(y, m, d);
  return list.some((e) => e.wd === wd && (!e.n || (e.n > 0 ? Math.ceil(d / 7) === e.n : Math.ceil((n - d + 1) / 7) === -e.n)));
}

/** The days of one month the rule picks, as day numbers. */
function monthDays(rule, y, m, baseDay) {
  const n = dim(y, m);
  let days = [];
  if (rule.bymonthday.length) {
    days = rule.bymonthday.map((d) => (d > 0 ? d : n + 1 + d)).filter((d) => d >= 1 && d <= n);
    if (rule.byday.length) days = days.filter((d) => inMonthByday(rule.byday, y, m, d, n));
  } else if (rule.byday.length) {
    for (let d = 1; d <= n; d++) if (inMonthByday(rule.byday, y, m, d, n)) days.push(d);
  } else if (baseDay <= n) {
    // The 31st in a month with 30 days has no occurrence, and is skipped, not moved.
    days.push(baseDay);
  }
  return [...new Set(days)].sort((a, b) => a - b);
}

/** BYDAY with an ordinal and no month named counts in the year: "20MO", "-1FR". */
function yearDays(rule, y) {
  const first = Date.UTC(y, 0, 1);
  const total = (Date.UTC(y + 1, 0, 1) - first) / DAY;
  const out = [];
  for (let i = 0; i < total; i++) {
    const wd = new Date(first + i * DAY).getUTCDay();
    const doy = i + 1;
    if (rule.byday.some((e) => e.wd === wd && (!e.n || (e.n > 0 ? Math.ceil(doy / 7) === e.n : Math.ceil((total - doy + 1) / 7) === -e.n)))) out.push(first + i * DAY);
  }
  return out;
}

/** A day picked only by the weeks (and days) rules: month, day-of-month and weekday limits. */
function limited(rule, ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  if (rule.bymonth.length && !rule.bymonth.includes(m + 1)) return false;
  if (rule.bymonthday.length) {
    const n = dim(y, m);
    if (!rule.bymonthday.some((x) => (x > 0 ? x : n + 1 + x) === day)) return false;
  }
  if (rule.byday.length && !rule.byday.some((e) => e.wd === d.getUTCDay())) return false;
  return true;
}

/** BYSETPOS: of the days one period produced, the ones at these positions. */
function setPos(days, positions) {
  if (!positions.length) return days;
  const picked = positions.map((p) => (p > 0 ? days[p - 1] : days[days.length + p])).filter((x) => x !== undefined);
  return [...new Set(picked)].sort((a, b) => a - b);
}

/** Where period `k` starts, in wall ms: how far to step before a period is past the window. */
function periodStart(rule, base, k) {
  const i = k * rule.interval;
  switch (rule.freq) {
    case "DAILY": return base.dayMs + i * DAY;
    case "WEEKLY": return base.weekStart + i * 7 * DAY;
    case "MONTHLY": return Date.UTC(base.y, base.m + i, 1);
    default: return Date.UTC(base.y + i, 0, 1);
  }
}

/** The days (UTC midnights of wall dates) of period `k`, ascending. */
function periodDays(rule, base, k) {
  const i = k * rule.interval;
  switch (rule.freq) {
    case "DAILY": {
      const ms = base.dayMs + i * DAY;
      return limited(rule, ms) ? [ms] : [];
    }
    case "WEEKLY": {
      const wk = base.weekStart + i * 7 * DAY;
      const wds = rule.byday.length ? [...new Set(rule.byday.map((e) => e.wd))] : [base.wd];
      const days = wds.map((wd) => wk + ((wd - rule.wkst + 7) % 7) * DAY).sort((a, b) => a - b);
      return setPos(days.filter((ms) => limited({ ...rule, byday: [] }, ms)), rule.bysetpos);
    }
    case "MONTHLY": {
      const first = new Date(Date.UTC(base.y, base.m + i, 1));
      const y = first.getUTCFullYear(), m = first.getUTCMonth();
      if (rule.bymonth.length && !rule.bymonth.includes(m + 1)) return [];
      return setPos(monthDays(rule, y, m, base.d).map((d) => Date.UTC(y, m, d)), rule.bysetpos);
    }
    default: {
      const y = base.y + i;
      if (rule.byday.some((e) => e.n) && !rule.bymonth.length && !rule.bymonthday.length) return setPos(yearDays(rule, y), rule.bysetpos);
      // Naming days with no month means every month, as the RFC has it.
      const every = rule.bymonthday.length || rule.byday.length ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] : [base.m];
      const months = (rule.bymonth.length ? rule.bymonth.map((x) => x - 1) : every).sort((a, b) => a - b);
      const days = months.flatMap((m) => monthDays(rule, y, m, base.d).map((d) => Date.UTC(y, m, d)));
      return setPos(days, rule.bysetpos);
    }
  }
}

/** The first period worth stepping to for a window starting at wall time `lo`. Never past it. */
function firstPeriod(rule, base, lo) {
  let k;
  switch (rule.freq) {
    case "DAILY": k = Math.floor((lo - base.dayMs) / (DAY * rule.interval)); break;
    case "WEEKLY": k = Math.floor((lo - base.weekStart) / (7 * DAY * rule.interval)); break;
    case "MONTHLY": {
      const d = new Date(lo);
      k = Math.floor(((d.getUTCFullYear() - base.y) * 12 + d.getUTCMonth() - base.m) / rule.interval);
      break;
    }
    default: k = Math.floor((new Date(lo).getUTCFullYear() - base.y) / rule.interval);
  }
  return Math.max(0, k - 1);
}

// ── expansion ──────────────────────────────────────────────

/**
 * The occurrences of one series that overlap [from, to), as { startMs, endMs }
 * in the same convention as the series' own start and end (an instant, or the
 * wall time as UTC for an all-day or floating event), in order.
 *
 *   series  { startMs, endMs, allDay, tzid, rule, exdates }
 *           `rule` is rule text or a parsed rule; none means one occurrence.
 *           `exdates` are start times (ms) that are not held.
 *   opts    { limit }  stop after this many
 *
 * An occurrence keeps the series' length in elapsed time; for all-day events
 * that is a whole number of days. The rule's own COUNT counts before
 * exclusions, as the RFC has it, so an EXDATE does not give an extra
 * occurrence at the end.
 */
export function expand(series, from, to, opts = {}) {
  const dur = Math.max(0, series.endMs - series.startMs);
  const skip = new Set(series.exdates || []);
  const max = Math.min(opts.limit ?? Infinity, LIMITS.out);
  const out = [];
  const overlaps = (s) => s < to && (s + dur > from || s >= from);
  const take = (s) => {
    if (overlaps(s) && !skip.has(s)) out.push({ startMs: s, endMs: s + dur });
    return out.length >= max;
  };

  const rule = typeof series.rule === "string" ? parseRule(series.rule) : series.rule;
  if (!rule) {
    take(series.startMs);
    return out;
  }

  const startWall = wallOf(series, series.startMs);
  const sd = new Date(startWall);
  const y = sd.getUTCFullYear(), m = sd.getUTCMonth(), d = sd.getUTCDate(), wd = sd.getUTCDay();
  const dayMs = Date.UTC(y, m, d);
  const base = { y, m, d, wd, dayMs, tod: startWall - dayMs, weekStart: dayMs - ((wd - rule.wkst + 7) % 7) * DAY };

  // The window in wall time, with a day each way for the zone's offset.
  const hi = wallOf(series, to) + DAY;
  const lo = wallOf(series, from - dur) - DAY;
  let until = null;
  if (rule.until) {
    until = rule.until.date ? rule.until.ms + DAY - 1 : rule.until.utc ? wallOf(series, rule.until.ms) : rule.until.ms;
  }

  // COUNT has to be counted from the first occurrence; without it a long-running
  // series jumps straight to the window.
  let k = rule.count ? 0 : firstPeriod(rule, base, lo);
  let counted = 0;
  for (let step = 0; step < LIMITS.steps; step++, k++) {
    if (periodStart(rule, base, k) > hi) break;
    for (const day of periodDays(rule, base, k)) {
      const wall = day + base.tod;
      if (wall < startWall) continue;
      if (until !== null && wall > until) return out;
      if (rule.count && ++counted > rule.count) return out;
      if (wall > hi) return out;
      if (wall < lo) continue;
      if (take(instantOf(series, wall))) return out;
    }
  }
  return out;
}

/**
 * The occurrences of a series with its edited single occurrences.
 *
 *   overrides  [{ recurrenceId, startMs, endMs, … }]  one per occurrence that
 *              was edited; `recurrenceId` is the start it had in the rule.
 *
 * Returns { startMs, endMs, recurrenceId, override } in order, where
 * `override` is the edited row or null. An edited occurrence replaces the one
 * the rule would have put there, wherever it was moved to, so one moved out
 * of the window is gone from it and one moved into it appears.
 */
export function occurrences(master, overrides, from, to, opts = {}) {
  const edited = new Map(overrides.map((o) => [o.recurrenceId, o]));
  const out = [];
  for (const o of expand(master, from, to, opts)) {
    if (!edited.has(o.startMs)) out.push({ ...o, recurrenceId: o.startMs, override: null });
  }
  for (const o of overrides) {
    if (o.startMs < to && (o.endMs > from || o.startMs >= from)) {
      out.push({ startMs: o.startMs, endMs: o.endMs, recurrenceId: o.recurrenceId, override: o });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}
