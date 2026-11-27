/**
 * What a calendar file can cost to read (src/ics.js parseCalendar), and what a
 * subscription whose refresh never finishes does (src/calendar.js refreshDue).
 *
 * A feed is a file anyone on the web serves, read on the per-minute run that
 * also syncs the mail. One built to be slow used to take that run past its
 * CPU limit every time it was due, with nothing written to say why. Timings
 * here are node's, on this machine; a Worker's CPU time is not the same
 * clock, so the bounds are loose and the work budget is what holds.
 */
import { register } from "node:module";
import { eq, ok } from "./harness.mjs";

register("../scripts/sync-harness/hooks.mjs", import.meta.url);
const { makeD1 } = await import("../scripts/sync-harness/fake.mjs");
const { SCHEMA } = await import("../src/schema.js");
const { handleApi } = await import("../src/api.js");
const { calendarModule, LIM } = await import("../src/calendar.js");
const { expand, occurrences } = await import("../src/rrule.js");
const { parseCalendar, CalendarTooLarge, PARSE } = await import("../src/ics.js");

const MB = 1_000_000;
const timed = (f) => {
  const t = performance.now();
  let out;
  try {
    out = f();
  } catch (e) {
    out = e;
  }
  return { out, ms: performance.now() - t };
};

// ── a calendar people keep reads as it did before the bounds ─

const FEED = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Example//Team//EN", "X-WR-CALNAME:Team\\, and friends",
  "BEGIN:VTIMEZONE", "TZID:Custom/Office",
  "BEGIN:STANDARD", "TZOFFSETTO:+0100", "END:STANDARD", "BEGIN:DAYLIGHT", "TZOFFSETTO:+0200", "END:DAYLIGHT",
  "END:VTIMEZONE",
  "BEGIN:VEVENT", "UID:standup@x", "DTSTART;TZID=Europe/Paris:20260302T091500", "DTEND;TZID=Europe/Paris:20260302T093000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR", "EXDATE;TZID=Europe/Paris:20260304T091500,20260330T091500", "EXDATE;TZID=Europe/Paris:20260403T091500",
  "SUMMARY:Standup", "LOCATION:Room 4\\; second floor", "BEGIN:VALARM", "TRIGGER:-PT10M", "ACTION:DISPLAY", "END:VALARM", "END:VEVENT",
  "BEGIN:VEVENT", "UID:standup@x", "RECURRENCE-ID;TZID=Europe/Paris:20260306T091500", "DTSTART;TZID=Europe/Paris:20260306T100000",
  "DTEND;TZID=Europe/Paris:20260306T101500", "SUMMARY:Standup (late)", "END:VEVENT",
  "BEGIN:VEVENT", "UID:ny@x", "DTSTART;TZID=America/New_York:20261101T013000", "DURATION:PT1H30M",
  "SUMMARY:Night shift across the clock change", "DESCRIPTION:Line one\\nLine two", "URL:https://example.org/shift", "END:VEVENT",
  "BEGIN:VEVENT", "UID:gap@x", "DTSTART;TZID=Europe/Paris:20260329T023000", "DTEND;TZID=Europe/Paris:20260329T033000",
  "SUMMARY:In the hour that does not exist", "END:VEVENT",
  "BEGIN:VEVENT", "UID:outlook@x", "DTSTART;TZID=\"Romance Standard Time\":20260415T140000", "DTEND;TZID=\"Romance Standard Time\":20260415T150000",
  "SUMMARY:Outlook meeting", "URL:javascript:alert(1)", "BEGIN:VALARM", "TRIGGER;VALUE=DATE-TIME:20260415T113000Z", "END:VALARM", "END:VEVENT",
  "BEGIN:VEVENT", "UID:office@x", "DTSTART;TZID=Custom/Office:20260710T080000", "DTEND;TZID=Custom/Office:20260710T090000",
  "SUMMARY:Office zone only the file knows", "END:VEVENT",
  "BEGIN:VEVENT", "UID:float@x", "DTSTART:20260501T190000", "DTEND:20260501T220000", "SUMMARY:Floating dinner", "END:VEVENT",
  "BEGIN:VEVENT", "UID:utc@x", "DTSTART:20260502T120000Z", "DTEND:20260502T123000Z", "SUMMARY:UTC call",
  "BEGIN:VALARM", "TRIGGER:PT5M", "END:VALARM", "BEGIN:VALARM", "TRIGGER:-P1D", "END:VALARM", "END:VEVENT",
  "BEGIN:VEVENT", "UID:holiday@x", "DTSTART;VALUE=DATE:20260714", "DTEND;VALUE=DATE:20260715", "SUMMARY:Bastille Day",
  "RRULE:FREQ=YEARLY", "EXDATE;VALUE=DATE:20270714", "END:VEVENT",
  "BEGIN:VEVENT", "UID:trip@x", "DTSTART;VALUE=DATE:20260801", "SUMMARY:Trip with no end", "END:VEVENT",
  "BEGIN:VEVENT", "UID:gone@x", "DTSTART:20260601T090000Z", "STATUS:CANCELLED", "SUMMARY:Cancelled", "END:VEVENT",
  "BEGIN:VEVENT", "UID:nostart@x", "SUMMARY:No start", "END:VEVENT",
  "BEGIN:VEVENT", "DTSTART;TZID=Europe/Paris:20261025T023000", "DTEND;TZID=Europe/Paris:20261025T030000",
  "SUMMARY:No UID, in the repeated hour, with a long description that is folded onto", "  a second line", "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n") + "\r\n";

// What parseCalendar gave for FEED at 5d1c208, before any of the bounds or the
// formatter reuse: zoned, Windows-named, VTIMEZONE-only, floating, UTC and
// all-day times, both clock changes, an edited occurrence, alarms, a
// cancelled event and one with no start.
const BEFORE = {
  calendarName: "Team, and friends",
  events: [
    {"uid":"standup@x","summary":"Standup","location":"Room 4; second floor","description":"","url":"","startMs":1772439300000,"endMs":1772440200000,"allDay":false,"tzid":"Europe/Paris","rrule":"FREQ=WEEKLY;BYDAY=MO,WE,FR","exdates":[1772612100000,1774854900000,1775200500000],"recurrenceId":null,"reminderMin":10},
    {"uid":"standup@x","summary":"Standup (late)","location":"","description":"","url":"","startMs":1772787600000,"endMs":1772788500000,"allDay":false,"tzid":"Europe/Paris","rrule":"","exdates":[],"recurrenceId":1772784900000,"reminderMin":null},
    {"uid":"ny@x","summary":"Night shift across the clock change","location":"","description":"Line one\nLine two","url":"https://example.org/shift","startMs":1793511000000,"endMs":1793516400000,"allDay":false,"tzid":"America/New_York","rrule":"","exdates":[],"recurrenceId":null,"reminderMin":null},
    {"uid":"gap@x","summary":"In the hour that does not exist","location":"","description":"","url":"","startMs":1774747800000,"endMs":1774747800000,"allDay":false,"tzid":"Europe/Paris","rrule":"","exdates":[],"recurrenceId":null,"reminderMin":null},
    {"uid":"outlook@x","summary":"Outlook meeting","location":"","description":"","url":"","startMs":1776254400000,"endMs":1776258000000,"allDay":false,"tzid":"Europe/Paris","rrule":"","exdates":[],"recurrenceId":null,"reminderMin":30},
    {"uid":"office@x","summary":"Office zone only the file knows","location":"","description":"","url":"","startMs":1783663200000,"endMs":1783666800000,"allDay":false,"tzid":"UTC","rrule":"","exdates":[],"recurrenceId":null,"reminderMin":null},
    {"uid":"float@x","summary":"Floating dinner","location":"","description":"","url":"","startMs":1777662000000,"endMs":1777672800000,"allDay":false,"tzid":"","rrule":"","exdates":[],"recurrenceId":null,"reminderMin":null},
    {"uid":"utc@x","summary":"UTC call","location":"","description":"","url":"","startMs":1777723200000,"endMs":1777725000000,"allDay":false,"tzid":"UTC","rrule":"","exdates":[],"recurrenceId":null,"reminderMin":1440},
    {"uid":"holiday@x","summary":"Bastille Day","location":"","description":"","url":"","startMs":1783987200000,"endMs":1784073600000,"allDay":true,"tzid":"","rrule":"FREQ=YEARLY","exdates":[1815523200000],"recurrenceId":null,"reminderMin":null},
    {"uid":"trip@x","summary":"Trip with no end","location":"","description":"","url":"","startMs":1785542400000,"endMs":1785628800000,"allDay":true,"tzid":"","rrule":"","exdates":[],"recurrenceId":null,"reminderMin":null},
    {"uid":"","summary":"No UID, in the repeated hour, with a long description that is folded onto a second line","location":"","description":"","url":"","startMs":1792891800000,"endMs":1792893600000,"allDay":false,"tzid":"Europe/Paris","rrule":"","exdates":[],"recurrenceId":null,"reminderMin":null},
  ],
  skipped: 2,
};
eq(parseCalendar(FEED), BEFORE, "a realistic feed parses to exactly what it did before the bounds");
eq(parseCalendar(FEED), BEFORE, "and again, with every zone's formatter already made");

// ── files built to be slow end quickly ──────────────────────

{
  // The reviewer's feed: one event, a third of a million zoned EXDATE values.
  const one = "20240101T090000,";
  const n = Math.floor((5 * MB - 200) / one.length);
  const s = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART;TZID=Europe/Paris:20240101T090000\r\nRRULE:FREQ=DAILY\r\nEXDATE;TZID=Europe/Paris:" +
    one.repeat(n) + "20240101T090000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const { out, ms } = timed(() => parseCalendar(s));
  eq([out.events?.length, out.events?.[0].exdates.length], [1, PARSE.values], `5 MB of EXDATE on one event keeps its first ${PARSE.values} values`);
  ok(ms < 1000, `and reads in well under a second (${Math.round(ms)} ms; it took 29 s)`);
}
{
  // As many zoned times as a file can hold where each is read: a thousand
  // EXDATE values on each of many events.
  const ev = (i) => `BEGIN:VEVENT\r\nUID:e${i}\r\nDTSTART;TZID=Europe/Paris:20240101T090000\r\nRRULE:FREQ=DAILY\r\nEXDATE;TZID=Europe/Paris:` +
    Array.from({ length: 1000 }, (_, k) => `2024${String(1 + (k % 12)).padStart(2, "0")}${String(1 + (k % 28)).padStart(2, "0")}T0900${String(k % 60).padStart(2, "0")}`).join(",") + "\r\nEND:VEVENT\r\n";
  const s = "BEGIN:VCALENDAR\r\n" + Array.from({ length: 300 }, (_, i) => ev(i)).join("") + "END:VCALENDAR\r\n";
  const { out, ms } = timed(() => parseCalendar(s));
  ok(out instanceof CalendarTooLarge, `${(s.length / MB).toFixed(1)} MB of zoned times is refused as too large to read`);
  eq(out.message, "This calendar is too large to read", "saying so");
  ok(ms < 1000, `in well under a second (${Math.round(ms)} ms)`);
}
{
  const s = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20240101T090000Z\r\n" + "X:\r\n".repeat((5 * MB) / 4) + "END:VEVENT\r\nEND:VCALENDAR\r\n";
  const { out, ms } = timed(() => parseCalendar(s));
  ok(out instanceof CalendarTooLarge, "a million one-letter lines is refused");
  ok(ms < 1000, `in well under a second (${Math.round(ms)} ms)`);
}
{
  const s = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20240101T090000Z\r\nX" + ";a=b".repeat((5 * MB) / 4) + ":x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  ok(timed(() => parseCalendar(s)).out instanceof CalendarTooLarge, "and so is a line with a million parameters");
}
{
  // Seventy thousand zoned events: only the first `max` are read, the rest only counted.
  const s = "BEGIN:VCALENDAR\r\n" + "BEGIN:VEVENT\r\nDTSTART;TZID=Europe/Paris:20240101T090000\r\nEND:VEVENT\r\n".repeat(70_000) + "END:VCALENDAR\r\n";
  const { out, ms } = timed(() => parseCalendar(s, { max: 2000 }));
  eq([out.events?.length, out.skipped], [2000, 68_000], "events past the most a calendar keeps are counted, not read");
  ok(ms < 1000, `so 70,000 zoned events read in well under a second (${Math.round(ms)} ms; they took 9 s)`);
}

// ── through the routes and the cron ─────────────────────────

const DB = makeD1([]);
for (const s of SCHEMA) DB.raw.exec(s);
const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const env = { DB, ENC_KEY: key, APP_URL: "http://x" };
const DAY = 86_400_000;
const MIN = 60_000;
const realNow = Date.now;
const realFetch = globalThis.fetch;
let clock = Date.UTC(2026, 3, 20, 10);
Date.now = () => clock;
let web = async () => new Response("", { status: 404 });
const fetched = [];
globalThis.fetch = async (url, init) => (fetched.push(String(url)), web(String(url), init));
const call = async (method, path, body, raw) => {
  const res = await handleApi(
    new Request("http://x" + path, { method, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }),
    env, path.split("?")[0], undefined, undefined
  );
  return { status: res.status, body: await res.json() };
};
const calRow = (id) => DB.raw.prepare("SELECT * FROM calendars WHERE id=?").get(id);
const small = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20260421T090000Z\r\nDTEND:20260421T100000Z\r\nSUMMARY:Match\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
// Under the import limit of 2 MB, and still too much to read.
const heavy = "BEGIN:VCALENDAR\r\n" + Array.from({ length: 110 }, (_, i) =>
  `BEGIN:VEVENT\r\nUID:h${i}\r\nDTSTART;TZID=Europe/Paris:20240101T090000\r\nRRULE:FREQ=DAILY\r\nEXDATE;TZID=Europe/Paris:` +
  Array(1000).fill("20240101T090000").join(",") + "\r\nEND:VEVENT\r\n").join("") + "END:VCALENDAR\r\n";

try {
  // A feed too large to read says so beside the calendar, and the refresh counts as finished.
  web = async () => new Response(heavy, { status: 200 });
  const sub = await call("POST", "/api/calendar/calendars", { name: "Heavy", color: "#e0892b", url: "https://example.com/heavy.ics", refreshMin: 60 });
  eq([sub.status, sub.body.calendar.lastError, sub.body.calendar.events], [201, "This calendar is too large to read", 0], "a feed too large to read is a calendar with that error");
  eq([calRow(sub.body.calendar.id).refresh_started, calRow(sub.body.calendar.id).stalled], [null, 0], "and a refresh that finished");
  await call("DELETE", `/api/calendar/calendars/${sub.body.calendar.id}`);

  // The import route reads with the same bounds.
  const local = (await call("GET", "/api/calendar/calendars")).body.calendars.find((c) => c.kind === "local").id;
  const imp = await call("POST", `/api/calendar/calendars/${local}/import`, undefined, heavy);
  eq([imp.status, imp.body.error], [413, "This calendar is too large to read"], `an import of ${(heavy.length / MB).toFixed(1)} MB too costly to read is refused`);
  eq(DB.raw.prepare("SELECT COUNT(*) AS n FROM cal_events").get().n, 0, "and nothing of it is kept");

  // A refresh that never finishes: the fetch hangs, as a run killed mid-way would leave it.
  web = async () => new Response(small, { status: 200 });
  const team = (await call("POST", "/api/calendar/calendars", { name: "Team", color: "#e0892b", url: "https://example.com/team.ics", refreshMin: 60 })).body.calendar;
  eq(team.events, 1, "a subscription is read");
  clock += 60 * MIN;
  web = () => new Promise(() => {});
  fetched.length = 0;
  calendarModule.cron(env); // never settles, like the run that was killed
  await new Promise((r) => setTimeout(r, 20));
  eq(fetched.length, 1, "it is fetched when due");
  ok(calRow(team.id).refresh_started > 0, "and the refresh is marked as begun");

  web = async () => new Response(small, { status: 200 });
  fetched.length = 0;
  clock += 60 * MIN;
  await calendarModule.cron(env);
  const stalled = (await call("GET", "/api/calendar/calendars")).body.calendars.find((c) => c.id === team.id);
  ok(/never finished/.test(stalled.lastError), "a refresh that never finished is the calendar's error the next time it is due");
  eq([fetched.length, calRow(team.id).stalled, calRow(team.id).refresh_started], [0, 1, null], "and it is not fetched again then");
  clock += 60 * MIN;
  await calendarModule.cron(env);
  eq(fetched.length, 0, "an hour later it still waits: the wait has doubled");
  clock += 60 * MIN;
  await calendarModule.cron(env);
  eq(fetched.length, 1, "two hours later it is fetched");
  eq([calRow(team.id).last_error, calRow(team.id).stalled, calRow(team.id).refresh_started], ["", 0, null], "and one that finishes clears the error and the wait");

  // ── rules that step for ever and yield nothing ────────────

  // DTSTART in year 1 (1901, as Date.UTC reads it) and a COUNT that is never
  // reached: every read stepped from the start to the step cap, about 9 ms a series.
  const never = "FREQ=DAILY;COUNT=5;BYMONTH=2;BYMONTHDAY=30";
  const neverFile = (n) => ["BEGIN:VCALENDAR", ...Array.from({ length: n }, (_, i) => [
    "BEGIN:VEVENT", `UID:n${i}`, "DTSTART:00010101T090000Z", "DTEND:00010101T100000Z", `RRULE:${never}`, `SUMMARY:Never ${i}`, "END:VEVENT",
  ]).flat(), "END:VCALENDAR"].join("\r\n") + "\r\n";
  web = async () => new Response(neverFile(2000), { status: 200 });
  const nev = (await call("POST", "/api/calendar/calendars", { name: "Never", color: "#e0892b", url: "https://example.com/never.ics" })).body.calendar;
  let t = performance.now();
  const refreshed = await call("POST", `/api/calendar/calendars/${nev.id}/refresh`);
  const storeMs = performance.now() - t;
  eq([refreshed.body.events, refreshed.body.droppedRules], [2000, 2000], "a feed of 2000 rules that never yield keeps 2000 events, every rule dropped and counted");
  eq(DB.raw.prepare("SELECT COUNT(*) AS n FROM cal_events WHERE calendar_id=? AND rrule<>''").get(nev.id).n, 0, "so each is stored as its one start");
  ok(storeMs < 2000, `checking them when stored is bounded (${Math.round(storeMs)} ms for the whole refresh)`);
  const imp2 = await call("POST", `/api/calendar/calendars/${local}/import`, undefined, neverFile(50));
  eq([imp2.status, imp2.body.imported, imp2.body.droppedRules], [200, 50, 50], "an import drops and counts them the same way");
  DB.raw.prepare("DELETE FROM cal_events WHERE calendar_id=?").run(local);

  // Rows stored before that check still hold such rules: one budget covers the whole read.
  const ins = DB.raw.prepare("INSERT INTO cal_events (id, calendar_id, uid, summary, start_ms, end_ms, all_day, tzid, rrule, exdates, created_at, updated_at) VALUES (?,?,?,?,?,?,0,'UTC',?,'',0,0)");
  for (let i = 0; i < 2000; i++) ins.run(`old${i}`, local, `old${i}`, "Old", Date.UTC(1, 0, 1, 9), Date.UTC(1, 0, 1, 10), never);
  const from = Date.UTC(2026, 3, 1);
  const to = from + LIM.windowDays * DAY;
  t = performance.now();
  const view = await call("GET", `/api/calendar/events?from=${from}&to=${to}`);
  const readMs = performance.now() - t;
  eq([view.status, view.body.incomplete], [200, true], "a window that spends its budget says it is incomplete");
  ok(readMs < 1500, `2000 such series cost a bounded time per request (${Math.round(readMs)} ms; 17 s before)`);
  DB.raw.prepare("DELETE FROM cal_events WHERE calendar_id=?").run(local);

  // A calendar people keep is read whole, and as it was.
  const paris = { startMs: Date.UTC(2026, 0, 5, 8), endMs: Date.UTC(2026, 0, 5, 9), allDay: false, tzid: "Europe/Paris" };
  const normal = [
    { ...paris, rule: "FREQ=DAILY" },
    { ...paris, rule: "FREQ=WEEKLY;BYDAY=MO,WE,FR", exdates: [Date.UTC(2026, 3, 1, 7)] },
    { ...paris, rule: "FREQ=MONTHLY;BYDAY=-1FR" },
    { ...paris, rule: "FREQ=WEEKLY;INTERVAL=2;COUNT=40" },
    { startMs: Date.UTC(2026, 6, 14), endMs: Date.UTC(2026, 6, 15), allDay: true, tzid: "", rule: "FREQ=YEARLY" },
    { startMs: Date.UTC(2026, 0, 1, 19), endMs: Date.UTC(2026, 0, 1, 20), allDay: false, tzid: "", rule: "FREQ=MONTHLY;BYMONTHDAY=1,15;COUNT=30" },
  ];
  // The window the route reads each in: a date or an hour with no zone is widened by a day and a half.
  const span = (sr) => (sr.allDay || !sr.tzid ? [from - 1.5 * DAY, to + 1.5 * DAY] : [from, to]);
  const budget = { left: LIM.windowWork };
  const shared = normal.map((sr) => expand(sr, ...span(sr), { budget }));
  eq(shared, normal.map((sr) => expand(sr, ...span(sr))), "a normal calendar's occurrences are the same read out of the budget");
  ok(!budget.hit && shared.flat().length > 500, `and it does not come near spending it (${LIM.windowWork - budget.left} of ${LIM.windowWork})`);
  for (const [i, sr] of normal.entries()) {
    ins.run(`ok${i}`, local, `ok${i}`, "Kept", sr.startMs, sr.endMs, sr.rule);
    DB.raw.prepare("UPDATE cal_events SET all_day=?, tzid=?, exdates=? WHERE id=?").run(sr.allDay ? 1 : 0, sr.tzid, (sr.exdates || []).join(","), `ok${i}`);
  }
  const kept = await call("GET", `/api/calendar/events?from=${from}&to=${to}`);
  eq([kept.body.incomplete, kept.body.events.filter((o) => o.calendarId === local).length], [undefined, shared.flat().length], "and through the route nothing is flagged and nothing is missing");
  const zs = { ...paris, rule: "FREQ=DAILY" };
  t = performance.now();
  for (let i = 0; i < 20; i++) occurrences(zs, [], from, to);
  console.log(`  a zoned daily series over ${LIM.windowDays} days: ${((performance.now() - t) / 20).toFixed(1)} ms (it was 50 ms)`);
} finally {
  Date.now = realNow;
  globalThis.fetch = realFetch;
}
