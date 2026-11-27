/**
 * Calendar invitations (iCalendar, RFC 5545, carried as iMIP, RFC 6047).
 *
 * An invitation arrives as a text/calendar part beside the readable text,
 * and every other mail client turns it into a card with Accept and Decline.
 * Here it used to be dropped on the floor by the MIME walker, so an invite
 * read as a block of "When: … Join meeting" text with no way to answer it.
 *
 * Pure string functions, no Workers API, tested by `node test.mjs`.
 */

/** Folded lines joined back up, then split into { name, params, value }. */
function lines(text) {
  return String(text || "")
    .replace(/\r?\n[ \t]/g, "") // unfold
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      // The value starts at the first colon outside a quoted parameter.
      let i = 0;
      let quoted = false;
      for (; i < line.length; i++) {
        const c = line[i];
        if (c === '"') quoted = !quoted;
        else if (c === ":" && !quoted) break;
      }
      const head = line.slice(0, i);
      const value = line.slice(i + 1);
      const [name, ...rest] = head.split(";");
      const params = {};
      for (const p of rest) {
        const eq = p.indexOf("=");
        if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
      }
      return { name: name.toUpperCase(), params, value, raw: line };
    });
}

/** TEXT values: \n, \, and \; are escapes (RFC 5545 §3.3.11). */
const unescapeText = (v) =>
  String(v || "").replace(/\\([nN,;\\])/g, (_m, c) => (c === "n" || c === "N" ? "\n" : c));

/** Windows timezone names (as written by Outlook, Exchange, Teams) -> IANA names for Intl. */
const WINDOWS_TO_IANA = {
  "romance standard time": "Europe/Paris",
  "w. europe standard time": "Europe/Berlin",
  "central europe standard time": "Europe/Prague",
  "central european standard time": "Europe/Warsaw",
  "gmt standard time": "Europe/London",
  "greenwich standard time": "Atlantic/Reykjavik",
  "w. central africa standard time": "Africa/Lagos",
  "south africa standard time": "Africa/Johannesburg",
  "egypt standard time": "Africa/Cairo",
  "morocco standard time": "Africa/Casablanca",
  "fle standard time": "Europe/Helsinki",
  "gtb standard time": "Europe/Bucharest",
  "e. europe standard time": "Europe/Chisinau",
  "jordan standard time": "Asia/Amman",
  "middle east standard time": "Asia/Beirut",
  "syria standard time": "Asia/Damascus",
  "israel standard time": "Asia/Jerusalem",
  "arabic standard time": "Asia/Baghdad",
  "arab standard time": "Asia/Riyadh",
  "iran standard time": "Asia/Tehran",
  "russian standard time": "Europe/Moscow",
  "belarus standard time": "Europe/Minsk",
  "caucasus standard time": "Asia/Yerevan",
  "azerbaijan standard time": "Asia/Baku",
  "georgian standard time": "Asia/Tbilisi",
  "arabian standard time": "Asia/Dubai",
  "afghanistan standard time": "Asia/Kabul",
  "west asia standard time": "Asia/Tashkent",
  "india standard time": "Asia/Kolkata",
  "sri lanka standard time": "Asia/Colombo",
  "nepal standard time": "Asia/Kathmandu",
  "central asia standard time": "Asia/Almaty",
  "bangladesh standard time": "Asia/Dhaka",
  "myanmar standard time": "Asia/Yangon",
  "se asia standard time": "Asia/Bangkok",
  "china standard time": "Asia/Shanghai",
  "taipei standard time": "Asia/Taipei",
  "singapore standard time": "Asia/Singapore",
  "w. australia standard time": "Australia/Perth",
  "north asia standard time": "Asia/Krasnoyarsk",
  "north asia east standard time": "Asia/Irkutsk",
  "tokyo standard time": "Asia/Tokyo",
  "korea standard time": "Asia/Seoul",
  "yakutsk standard time": "Asia/Yakutsk",
  "cen. australia standard time": "Australia/Adelaide",
  "aus central standard time": "Australia/Darwin",
  "aus eastern standard time": "Australia/Sydney",
  "e. australia standard time": "Australia/Brisbane",
  "tasmania standard time": "Australia/Hobart",
  "vladivostok standard time": "Asia/Vladivostok",
  "west pacific standard time": "Pacific/Port_Moresby",
  "magadan standard time": "Asia/Magadan",
  "new zealand standard time": "Pacific/Auckland",
  "fiji standard time": "Pacific/Fiji",
  "tonga standard time": "Pacific/Tongatapu",
  "hawaiian standard time": "Pacific/Honolulu",
  "alaskan standard time": "America/Anchorage",
  "pacific standard time": "America/Los_Angeles",
  "pacific standard time (mexico)": "America/Tijuana",
  "us mountain standard time": "America/Phoenix",
  "mountain standard time": "America/Denver",
  "mountain standard time (mexico)": "America/Mazatlan",
  "central standard time": "America/Chicago",
  "central standard time (mexico)": "America/Mexico_City",
  "canada central standard time": "America/Regina",
  "eastern standard time": "America/New_York",
  "us eastern standard time": "America/Indiana/Indianapolis",
  "atlantic standard time": "America/Halifax",
  "newfoundland standard time": "America/St_Johns",
  "sa pacific standard time": "America/Bogota",
  "sa western standard time": "America/La_Paz",
  "sa eastern standard time": "America/Cayenne",
  "e. south america standard time": "America/Sao_Paulo",
  "argentina standard time": "America/Argentina/Buenos_Aires",
  "utc": "UTC",
};

/** Resolves an iCalendar TZID (Windows name, prefixed path, or IANA) to an IANA identifier. */
export function resolveTz(tz) {
  if (!tz) return null;
  let clean = String(tz).trim().replace(/^["'\\]+|["'\\]+$/g, "");
  if (clean.startsWith("/")) clean = clean.slice(1);
  const lower = clean.toLowerCase();
  if (WINDOWS_TO_IANA[lower]) return WINDOWS_TO_IANA[lower];
  const stripped = lower.replace(/\(utc[+-]\d{2}:\d{2}\)\s*/i, "").trim();
  if (WINDOWS_TO_IANA[stripped]) return WINDOWS_TO_IANA[stripped];
  return clean;
}

/** The offset (ms) of a named zone at a moment, from Intl — null if the name is not IANA. */
export function zoneOffset(tz, utcMs) {
  const resolved = resolveTz(tz);
  if (!resolved) return null;
  try {
    const f = new Intl.DateTimeFormat("en-US", {
      timeZone: resolved,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return asUtc - utcMs;
  } catch {
    return null;
  }
}

/** "+0200" → ms. */
const offsetMs = (s) => {
  const m = /^([+-])(\d{2})(\d{2})/.exec(String(s || ""));
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : 0;
};

/**
 * A DATE or DATE-TIME property → { ms, allDay }.
 *
 * Z means UTC. A TZID is mapped to IANA and resolved with Intl, which knows
 * the exact DST transition instants for every year. If Intl fails to recognise
 * the name, the VTIMEZONE block in the same file is used, calculating the last
 * Sunday of March and October transitions rather than a blanket month check.
 */
function when(prop, zones) {
  if (!prop) return null;
  const v = prop.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined || prop.params.VALUE === "DATE") {
    return { ms: Date.UTC(+y, +mo - 1, +d), allDay: true };
  }
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0));
  if (z) return { ms: wall, allDay: false };
  const tz = prop.params.TZID;
  if (!tz) return { ms: wall, allDay: false, floating: true };
  const off = zoneOffset(tz, wall);
  if (off !== null) {
    // Once more at the corrected instant, for the hour around a clock change.
    const again = zoneOffset(tz, wall - off);
    return { ms: wall - (again ?? off), allDay: false };
  }
  const zone = zones[tz] || zones[resolveTz(tz)];
  if (zone) {
    const lastSunMarch = 31 - new Date(Date.UTC(+y, 2, 31)).getUTCDay();
    const lastSunOct = 31 - new Date(Date.UTC(+y, 9, 31)).getUTCDay();
    const isSummer =
      (+mo > 3 && +mo < 10) ||
      (+mo === 3 && +d >= lastSunMarch) ||
      (+mo === 10 && +d < lastSunOct);
    const zoff = isSummer ? (zone.daylight ?? zone.standard) : (zone.standard ?? zone.daylight);
    return { ms: wall - zoff, allDay: false };
  }
  return { ms: wall, allDay: false, floating: true };
}

/** VTIMEZONE offsets by TZID, for zones Intl does not know by name. */
function zonesOf(all) {
  const zones = {};
  let tzid = null;
  let part = null;
  for (const l of all) {
    if (l.name === "BEGIN" && l.value === "VTIMEZONE") tzid = "";
    else if (l.name === "END" && l.value === "VTIMEZONE") tzid = null;
    else if (tzid !== null && l.name === "TZID") tzid = l.value, (zones[tzid] = zones[tzid] || {});
    else if (tzid && l.name === "BEGIN") part = l.value;
    else if (tzid && l.name === "TZOFFSETTO" && part) {
      zones[tzid][part === "DAYLIGHT" ? "daylight" : "standard"] = offsetMs(l.value);
    }
  }
  return zones;
}

const mailto = (v) => String(v || "").replace(/^mailto:/i, "").trim().toLowerCase();

/** The address if it is an https one, as the URL parser writes it; else "". */
export function httpsUrl(value) {
  try {
    const u = new URL(String(value || "").trim());
    return u.protocol === "https:" ? u.href : "";
  } catch {
    return "";
  }
}

/**
 * The first VEVENT of a calendar, and what is needed to show and answer it.
 * Null when there is none.
 */
export function parseIcs(text) {
  const all = lines(text);
  if (!all.length) return null;
  const method = (all.find((l) => l.name === "METHOD")?.value || "").toUpperCase();

  const zones = zonesOf(all);

  const start = all.findIndex((l) => l.name === "BEGIN" && l.value === "VEVENT");
  if (start < 0) return null;
  const end = all.findIndex((l, i) => i > start && l.name === "END" && l.value === "VEVENT");
  const ev = all.slice(start + 1, end < 0 ? undefined : end);
  const one = (n) => ev.find((l) => l.name === n);

  const dtstart = when(one("DTSTART"), zones);
  let dtend = when(one("DTEND"), zones);
  if (!dtend && dtstart) {
    const dur = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(one("DURATION")?.value || "");
    if (dur) dtend = { ...dtstart, ms: dtstart.ms + (((+dur[1] || 0) * 24 + (+dur[2] || 0)) * 60 + (+dur[3] || 0)) * 60_000 };
  }
  const org = one("ORGANIZER");
  const summary = unescapeText(one("SUMMARY")?.value);
  const location = unescapeText(one("LOCATION")?.value);
  const description = unescapeText(one("DESCRIPTION")?.value).slice(0, 2000);
  const rawUrl = one("URL")?.value || "";
  const videoMatch = `${rawUrl}\n${location}\n${description}`.match(
    /https:\/\/(?:[a-zA-Z0-9-]+\.)?(?:teams\.microsoft\.com|meet\.google\.com|zoom\.us|webex\.com)\/[^\s<>"')]+/i
  );
  // The URL property is whatever the sender wrote, and it ends up behind a
  // link in the app: `javascript:` or `data:` there is a script waiting for
  // a click. Only https comes out; anything else falls back to the meeting
  // link, or to nothing.
  const url = httpsUrl(rawUrl) || (videoMatch ? videoMatch[0] : "");

  return {
    method,
    uid: one("UID")?.value || "",
    sequence: Number(one("SEQUENCE")?.value || 0),
    summary,
    location,
    description,
    url,
    status: (one("STATUS")?.value || "").toUpperCase(),
    start: dtstart,
    end: dtend,
    organizer: org ? { email: mailto(org.value), name: org.params.CN || "" } : null,
    attendees: ev
      .filter((l) => l.name === "ATTENDEE")
      .map((l) => ({ email: mailto(l.value), name: l.params.CN || "", partstat: (l.params.PARTSTAT || "").toUpperCase() })),
    // Copied verbatim into a reply: the organiser's server matches on them.
    rawStart: one("DTSTART")?.raw || "",
    rawOrganizer: org?.raw || "",
    rawRecurrence: one("RECURRENCE-ID")?.raw || "",
  };
}

const PARTSTAT = { accepted: "ACCEPTED", tentative: "TENTATIVE", declined: "DECLINED" };

/** UTC "now" in iCalendar form. */
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** Folds an iCalendar content line at 75 octets (approximately: characters). */
const foldLine = (l) => (l.length <= 75 ? l : l.match(/.{1,74}/g).join("\r\n "));

/**
 * The METHOD:REPLY that answers an invitation (RFC 5546 §3.2.3): the same
 * UID, SEQUENCE, DTSTART and ORGANIZER, and one ATTENDEE — you — with your
 * answer. Returns null for anything that is not an invitation to answer.
 */
export function icsReply(invite, { email, name = "", status, now = new Date() }) {
  const partstat = PARTSTAT[status];
  if (!invite || !invite.uid || !partstat || !invite.rawOrganizer) return null;
  const cn = String(name || "").replace(/[";:,\r\n]/g, "").trim();
  const out = [
    "BEGIN:VCALENDAR",
    "PRODID:-//dmzs-mail//EN",
    "VERSION:2.0",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    `UID:${invite.uid}`,
    `SEQUENCE:${invite.sequence || 0}`,
    `DTSTAMP:${stamp(now)}`,
    invite.rawStart,
    invite.rawRecurrence,
    invite.rawOrganizer,
    `ATTENDEE;PARTSTAT=${partstat}${cn ? `;CN="${cn}"` : ""}:mailto:${email}`,
    invite.summary ? `SUMMARY:${invite.summary.replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n")}` : "",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);
  return out.map(foldLine).join("\r\n") + "\r\n";
}

/**
 * Indexes or removes an invitation in the events table for the timeline.
 */
export async function indexEvent(env, messageId, accountId, calendarText, fallbackSubject = "") {
  if (!env?.DB || !messageId) return null;
  if (!calendarText) {
    await env.DB.prepare("DELETE FROM events WHERE id=?").bind(messageId).run().catch(() => {});
    return null;
  }
  const inv = parseIcs(calendarText);
  if (!inv || !inv.start) {
    await env.DB.prepare("DELETE FROM events WHERE id=?").bind(messageId).run().catch(() => {});
    return null;
  }
  const org = inv.organizer ? (inv.organizer.name ? `${inv.organizer.name} <${inv.organizer.email}>` : inv.organizer.email) : "";
  const endMs = inv.end ? inv.end.ms : (inv.start.ms + 3600_000);
  const status = inv.method === "CANCEL" || inv.status === "CANCELLED" ? "CANCELLED" : (inv.status || "CONFIRMED");
  await env.DB.prepare(
    `INSERT INTO events (id, account_id, uid, summary, location, description, url, start_ms, end_ms, all_day, floating, status, organizer, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       summary=excluded.summary,
       location=excluded.location,
       description=excluded.description,
       url=excluded.url,
       start_ms=excluded.start_ms,
       end_ms=excluded.end_ms,
       all_day=excluded.all_day,
       floating=excluded.floating,
       status=excluded.status,
       organizer=excluded.organizer`
  ).bind(
    messageId,
    accountId,
    inv.uid || messageId,
    (inv.summary || fallbackSubject || "Meeting").slice(0, 300),
    (inv.location || "").slice(0, 300),
    (inv.description || "").slice(0, 1000),
    (inv.url || "").slice(0, 500),
    inv.start.ms,
    endMs,
    inv.start.allDay ? 1 : 0,
    // A time with no zone means that hour wherever it is read. Kept, or the
    // timeline moves it by the reader's own offset, as the reader's card
    // once did.
    inv.start.floating ? 1 : 0,
    status,
    org.slice(0, 200),
    Date.now()
  ).run().catch(() => {});
  return inv;
}

// ── whole calendars ────────────────────────────────────────
//
// The calendar view reads and writes a file full of events, not one invitation:
// a subscription is a feed of them and an import or an export is a file of
// them. They go through the same line reader and the same time rules as an
// invitation above.

const DAY = 86_400_000;

/** An ISO 8601 duration ("-PT15M", "P1DT2H", "PT0S", "P1W") in ms, or null. */
function duration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v || "").trim());
  if (!m) return null;
  const ms = (((+m[2] || 0) * 7 + (+m[3] || 0)) * 24 + (+m[4] || 0)) * 3600_000 + (+m[5] || 0) * 60_000 + (+m[6] || 0) * 1000;
  return m[1] === "-" ? -ms : ms;
}

/**
 * Minutes before the start an alarm rings, from its TRIGGER, or null when it
 * rings after the start or is not one a reminder can say. An absolute trigger
 * is counted back from the start.
 */
function alarmMinutes(alarm, startMs, zones) {
  const t = alarm.find((l) => l.name === "TRIGGER");
  if (!t) return null;
  let ms;
  if (t.params.VALUE === "DATE-TIME") {
    const at = when(t, zones);
    ms = at ? at.ms - startMs : null;
  } else {
    ms = duration(t.value);
  }
  if (ms === null || ms > 0) return null;
  const min = Math.round(-ms / 60_000);
  return min <= 40_320 ? min : null;
}

/** The IANA zone an event's start is written in: "" for none (a date, or an hour with no zone). */
function zoneOf(prop, start) {
  if (!start || start.allDay || start.floating) return "";
  if (/Z$/i.test(prop.value.trim())) return "UTC";
  const tz = resolveTz(prop.params.TZID);
  // A zone only the file's VTIMEZONE knows still has its instants right here;
  // its recurrences are expanded in UTC.
  return tz && zoneOffset(tz, start.ms) !== null ? tz : "UTC";
}

/**
 * Every VEVENT of a calendar, as the fields the calendar stores.
 *
 *   { calendarName, events, skipped }
 *
 * Each event is { uid, summary, location, description, url, startMs, endMs,
 * allDay, tzid, rrule, exdates, recurrenceId, reminderMin }. Times follow the
 * rule used everywhere else: an instant, except that an all-day date or an
 * hour with no zone is its wall time written as UTC (and `tzid` is "").
 * `rrule` is the rule's text, unchecked. An event with no start, a cancelled
 * one, or one past `max` is counted in `skipped` and left out.
 */
export function parseCalendar(text, { max = 2000 } = {}) {
  const all = lines(text);
  const zones = zonesOf(all);
  const calendarName = unescapeText(all.find((l) => l.name === "X-WR-CALNAME")?.value || "").slice(0, 120);
  const events = [];
  let skipped = 0;
  for (let i = 0; i < all.length; i++) {
    if (!(all[i].name === "BEGIN" && all[i].value === "VEVENT")) continue;
    const ev = [];
    const alarms = [];
    let alarm = null;
    for (i++; i < all.length && !(all[i].name === "END" && all[i].value === "VEVENT"); i++) {
      const l = all[i];
      if (l.name === "BEGIN" && l.value === "VALARM") alarm = [];
      else if (l.name === "END" && l.value === "VALARM") alarm && alarms.push(alarm), (alarm = null);
      else if (alarm) alarm.push(l);
      else ev.push(l);
    }
    const one = (n) => ev.find((l) => l.name === n);
    const dtstart = one("DTSTART");
    const start = when(dtstart, zones);
    if (!start || (one("STATUS")?.value || "").toUpperCase() === "CANCELLED" || events.length >= max) {
      skipped++;
      continue;
    }
    let end = when(one("DTEND"), zones);
    if (!end) {
      const d = duration(one("DURATION")?.value);
      end = { ms: start.ms + (d !== null && d >= 0 ? d : start.allDay ? DAY : 0) };
    }
    // An all-day end is the day after the last one, so it is never at or before the start.
    const endMs = start.allDay ? Math.max(end.ms, start.ms + DAY) : Math.max(end.ms, start.ms);
    const recurrence = when(one("RECURRENCE-ID"), zones);
    const exdates = ev
      .filter((l) => l.name === "EXDATE")
      .flatMap((l) => l.value.split(",").map((v) => when({ value: v, params: l.params }, zones)))
      .filter(Boolean)
      .map((x) => x.ms);
    const rawUrl = one("URL")?.value || "";
    const minutes = alarms.map((a) => alarmMinutes(a, start.ms, zones)).find((m) => m !== null);
    events.push({
      uid: one("UID")?.value?.trim() || "",
      summary: unescapeText(one("SUMMARY")?.value).slice(0, 300),
      location: unescapeText(one("LOCATION")?.value).slice(0, 300),
      description: unescapeText(one("DESCRIPTION")?.value).slice(0, 4000),
      url: httpsUrl(rawUrl),
      startMs: start.ms,
      endMs,
      allDay: !!start.allDay,
      tzid: zoneOf(dtstart, start),
      rrule: (one("RRULE")?.value || "").trim(),
      exdates,
      recurrenceId: recurrence ? recurrence.ms : null,
      reminderMin: minutes === undefined ? null : minutes,
    });
  }
  return { calendarName, events, skipped };
}

const pad = (n, w = 2) => String(n).padStart(w, "0");
const icsDay = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const icsHour = (d) => `${icsDay(d)}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;

/** A stored time as an iCalendar property's parameters and value, by the event's kind. */
function icsTime(ms, e) {
  if (e.all_day) return [";VALUE=DATE", icsDay(new Date(ms))];
  if (!e.tzid) return ["", icsHour(new Date(ms))];
  if (e.tzid === "UTC") return ["", icsHour(new Date(ms)) + "Z"];
  const wall = ms + (zoneOffset(e.tzid, ms) ?? 0);
  return [`;TZID=${e.tzid}`, icsHour(new Date(wall))];
}

const escapeText = (v) =>
  String(v || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Folds a line at 75 octets without cutting a character in two. */
function foldOctets(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts = [];
  let cur = "";
  let bytes = 0;
  let room = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > room) {
      parts.push(cur);
      cur = "";
      bytes = 0;
      room = 74; // the continuation's leading space takes one
    }
    cur += ch;
    bytes += n;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

/**
 * A calendar as an .ics file.
 *
 * `rows` are cal_events rows. A timed event is written in its own zone by
 * TZID and no VTIMEZONE block; Apple, Google and Fastmail read the zone's
 * name, a client that wants the block spelled out would not.
 */
export function writeCalendar(name, rows, now = new Date()) {
  const out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Stratus//Calendar//EN", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${escapeText(name)}`];
  for (const e of rows) {
    const [sp, sv] = icsTime(e.start_ms, e);
    const [ep, evv] = icsTime(e.end_ms, e);
    out.push("BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${stamp(now)}`, `DTSTART${sp}:${sv}`, `DTEND${ep}:${evv}`);
    if (e.recurrence_id !== null && e.recurrence_id !== undefined) {
      const [rp, rv] = icsTime(e.recurrence_id, e);
      out.push(`RECURRENCE-ID${rp}:${rv}`);
    }
    if (e.rrule) out.push(`RRULE:${e.rrule}`);
    const ex = String(e.exdates || "").split(",").filter(Boolean).map(Number);
    if (ex.length) out.push(`EXDATE${icsTime(ex[0], e)[0]}:${ex.map((x) => icsTime(x, e)[1]).join(",")}`);
    out.push(`SUMMARY:${escapeText(e.summary)}`);
    if (e.location) out.push(`LOCATION:${escapeText(e.location)}`);
    if (e.description) out.push(`DESCRIPTION:${escapeText(e.description)}`);
    if (e.url) out.push(`URL:${e.url}`);
    if (e.reminder_min !== null && e.reminder_min !== undefined) {
      out.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeText(e.summary || "Reminder")}`, `TRIGGER:-PT${Math.round(e.reminder_min)}M`, "END:VALARM");
    }
    out.push("END:VEVENT");
  }
  out.push("END:VCALENDAR");
  return out.map(foldOctets).join("\r\n") + "\r\n";
}
