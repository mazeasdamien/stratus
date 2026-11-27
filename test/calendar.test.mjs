/**
 * The calendar module (src/calendar.js) against a real SQLite, through what
 * the page and the cron can reach: the routes under /api/calendar, the
 * module's per-minute cron, and the reminders table the module writes to.
 * A fake fetch stands in for the web, and a clock the test moves for time.
 */
import { register } from "node:module";
import { eq, ok } from "./harness.mjs";

register("../scripts/sync-harness/hooks.mjs", import.meta.url);
const { makeD1 } = await import("../scripts/sync-harness/fake.mjs");
const { SCHEMA } = await import("../src/schema.js");
const { handleApi } = await import("../src/api.js");
const { calendarModule, LIM, feedUrl } = await import("../src/calendar.js");
const { remindersModule } = await import("../src/reminders.js");
const { parseCalendar } = await import("../src/ics.js");
const { open } = await import("../src/crypto.js");

const sql = [];
const DB = makeD1(sql);
for (const s of SCHEMA) DB.raw.exec(s);
const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const env = { DB, ENC_KEY: key, APP_URL: "http://x" };

const DAY = 86_400_000;
const MIN = 60_000;
const utc = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi);
const iso = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

// A clock the test moves, and a fetch that is whatever the test says the web is.
const realNow = Date.now;
const realFetch = globalThis.fetch;
const saved = { ...LIM };
let clock = utc(2026, 3, 20, 10);
Date.now = () => clock;
let web = async () => new Response("", { status: 404 });
const fetched = [];
globalThis.fetch = async (url, init) => (fetched.push(String(url)), web(String(url), init));

const call = async (method, path, body, raw) => {
  const res = await handleApi(
    new Request("http://x" + path, { method, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }),
    env, path.split("?")[0], undefined, undefined
  );
  const type = res.headers.get("content-type") || "";
  return { status: res.status, res, body: type.includes("json") ? await res.json() : await res.text() };
};
const window = async (from, to) => (await call("GET", `/api/calendar/events?from=${from}&to=${to}`)).body.events;
const starts = (list) => list.map((o) => iso(o.start));
const row = (id) => DB.raw.prepare("SELECT * FROM cal_events WHERE id=?").get(id);
const rem = (ref) => DB.raw.prepare("SELECT * FROM reminders WHERE kind='event' AND ref=?").get(ref);
const cron = async () => {
  await remindersModule.cron(env);
  await calendarModule.cron(env);
};

// AbortSignal.timeout does not keep the process alive, and the one test that waits on it has nothing else to.
const keepAlive = setInterval(() => {}, 1000);
try {
  // ── calendars ────────────────────────────────────────────

  const first = await call("GET", "/api/calendar/calendars");
  eq(first.body.calendars.map((c) => [c.kind, c.name]), [["local", "Calendar"], ["invitations", "Invitations"]], "one local calendar from the start, and the Invitations one that is not a row");
  eq(first.body.calendars[1].readOnly, true, "Invitations is read-only");
  const main = first.body.calendars[0].id;
  eq((await call("GET", "/api/calendar/calendars")).body.calendars.filter((c) => c.kind === "local").length, 1, "reading again does not make another");

  const made = await call("POST", "/api/calendar/calendars", { name: "  Work ", color: "#2E9E5B" });
  eq([made.status, made.body.calendar.name, made.body.calendar.color, made.body.calendar.kind], [201, "Work", "#2e9e5b", "local"], "a calendar is made with a name and colour");
  const work = made.body.calendar.id;
  eq((await call("POST", "/api/calendar/calendars", { name: "", color: "#2e9e5b" })).status, 400, "a calendar needs a name");
  eq((await call("POST", "/api/calendar/calendars", { name: "x", color: "red" })).status, 400, "and a colour that is one");
  eq((await call("PATCH", `/api/calendar/calendars/${work}`, { name: "Job", color: "#d9534f" })).body.calendar.name, "Job", "a calendar can be renamed");
  eq((await call("PATCH", "/api/calendar/calendars/nope", { name: "x" })).status, 404, "an unknown one is a 404");
  eq((await call("DELETE", `/api/calendar/calendars/${main}`)).status, 200, "a local calendar can go while another remains");
  eq((await call("DELETE", `/api/calendar/calendars/${work}`)).status, 400, "but not the last one");
  const again = await call("POST", "/api/calendar/calendars", { name: "Calendar", color: "#1f6fd0" });
  const home = again.body.calendar.id;
  eq((await call("DELETE", `/api/calendar/calendars/${work}`)).status, 200, "and with two, either");
  const cal = home;

  // ── one event: create, read, change, delete ──────────────

  const parisWinter = (d, h, mi = 0) => utc(2026, 3, d, h, mi) - 60 * MIN; // CET, until 29 March
  const created = await call("POST", "/api/calendar/events", {
    calendarId: cal, summary: "Dentist", location: "Rue Neuve", start: parisWinter(25, 14), end: parisWinter(25, 15), tzid: "Europe/Paris",
  });
  eq(created.status, 201, "an event is created");
  const dentist = created.body.event.id;
  eq(
    [created.body.event.summary, created.body.event.start, created.body.event.tzid, created.body.event.recurring, created.body.event.readOnly],
    ["Dentist", parisWinter(25, 14), "Europe/Paris", false, false],
    "and comes back as it was given"
  );
  eq((await call("GET", `/api/calendar/events/${dentist}`)).body.event.location, "Rue Neuve", "it can be read by id");
  eq((await call("POST", "/api/calendar/events", { calendarId: cal, summary: "x", start: 10, end: 5, tzid: "UTC" })).status, 400, "an event cannot end before it starts");
  eq((await call("POST", "/api/calendar/events", { calendarId: cal, summary: "x", start: 1, end: 2, rrule: "FREQ=SECONDLY" })).status, 400, "nor repeat in a way the calendar cannot keep");
  eq((await call("POST", "/api/calendar/events", { calendarId: "nope", summary: "x", start: 1, end: 2 })).status, 404, "nor go in a calendar that is not there");

  const win = [utc(2026, 3, 22), utc(2026, 4, 13)];
  let occ = await window(...win);
  eq(occ.map((o) => o.summary), ["Dentist"], "an event is read back across a window");
  eq(
    [occ[0].eventId, occ[0].calendarId, occ[0].start, occ[0].end, occ[0].allDay, occ[0].recurring, occ[0].readOnly],
    [dentist, cal, parisWinter(25, 14), parisWinter(25, 15), false, false, false],
    "with the shape the views draw"
  );
  eq((await window(utc(2026, 3, 26), utc(2026, 4, 1))).length, 0, "and not across one that misses it");
  eq((await call("GET", `/api/calendar/events?from=1&to=${1 + 500 * DAY}`)).status, 400, "a window is limited");
  eq((await call("GET", "/api/calendar/events?from=x&to=y")).status, 400, "and has to be numbers");

  const moved = await call("PATCH", `/api/calendar/events/${dentist}`, { summary: "Dentist (moved)", start: parisWinter(26, 9), end: parisWinter(26, 10) });
  eq([moved.body.event.summary, moved.body.event.start], ["Dentist (moved)", parisWinter(26, 9)], "an event is changed and moved");
  eq(starts(await window(...win)), ["2026-03-26 08:00"], "and the window follows");
  eq((await call("DELETE", `/api/calendar/events/${dentist}`)).status, 200, "an event is deleted");
  eq((await window(...win)).length, 0, "and is gone");
  eq((await call("DELETE", `/api/calendar/events/${dentist}`)).status, 200, "deleting it again is no complaint");

  // An all-day event is a date: stored at midnight UTC and read back as one.
  const trip = await call("POST", "/api/calendar/events", { calendarId: cal, summary: "Trip", allDay: true, start: utc(2026, 3, 25, 17), end: utc(2026, 3, 25, 17), tzid: "Europe/Paris" });
  const tr = (await window(...win))[0];
  eq([tr.allDay, tr.start, tr.end, tr.floating], [true, utc(2026, 3, 25), utc(2026, 3, 26), false], "an all-day event is a whole date, ending the day after");
  await call("DELETE", `/api/calendar/events/${trip.body.event.id}`);

  // ── a series: expansion, one occurrence, the whole series ─

  const standup = (await call("POST", "/api/calendar/events", {
    calendarId: cal, summary: "Standup", start: parisWinter(23, 9), end: parisWinter(23, 9, 30), tzid: "Europe/Paris", rrule: "FREQ=WEEKLY;BYDAY=MO",
  })).body.event;
  occ = await window(...win);
  eq(starts(occ), ["2026-03-23 08:00", "2026-03-30 07:00", "2026-04-06 07:00"], "a weekly 9:00 in Paris stays 9:00 across the clock change");
  eq(occ.every((o) => o.recurring && o.eventId === standup.id), true, "each occurrence knows its series");
  eq(occ[1].id, `${standup.id}@${occ[1].start}`, "and has an id of its own");
  eq(occ.map((o) => o.occurrence), occ.map((o) => o.start), "naming the start it has in the rule");

  // One occurrence moved and renamed.
  const mar30 = occ[1].start;
  const one = await call("PATCH", `/api/calendar/events/${standup.id}`, {
    scope: "one", occurrence: mar30, summary: "Standup (late)", start: mar30 + 3600_000, end: mar30 + 5400_000,
  });
  eq(one.status, 200, "one occurrence is edited alone");
  occ = await window(...win);
  eq(starts(occ), ["2026-03-23 08:00", "2026-03-30 08:00", "2026-04-06 07:00"], "it stands where it was moved to");
  eq(occ.map((o) => o.summary), ["Standup", "Standup (late)", "Standup"], "with its own name, and the others unchanged");
  eq(occ[1].occurrence, mar30, "still part of the series, at the slot it had");
  eq((await call("PATCH", `/api/calendar/events/${standup.id}`, { scope: "one", occurrence: mar30 + 5 * MIN, summary: "x" })).status, 400, "an occurrence the rule does not have is refused");
  eq((await call("PATCH", `/api/calendar/events/${standup.id}`, { scope: "one", summary: "x" })).status, 400, "and so is one with none named");
  // Edited again, through its own id.
  const overrideId = occ[1].eventId;
  eq(overrideId === standup.id, false, "an edited occurrence is a row of its own");
  await call("PATCH", `/api/calendar/events/${overrideId}`, { scope: "one", location: "Room 4" });
  eq((await window(...win))[1].location, "Room 4", "and takes a second edit");

  // The whole series moved by dragging one occurrence an hour later.
  const apr6 = occ[2].start;
  const all = await call("PATCH", `/api/calendar/events/${standup.id}`, {
    scope: "all", from: apr6, start: apr6 + 3600_000, end: apr6 + 5400_000, summary: "Standup",
  });
  eq(all.status, 200, "the whole series is changed");
  eq(starts(await window(...win)), ["2026-03-23 09:00", "2026-03-30 08:00", "2026-04-06 08:00"], "every occurrence moves, and stays at the new wall time across the change");
  eq(DB.raw.prepare("SELECT COUNT(*) AS n FROM cal_events WHERE recurrence_id IS NOT NULL").get().n, 0, "the one-off edits of the old timing are dropped");
  const titled = await call("PATCH", `/api/calendar/events/${standup.id}`, { scope: "all", summary: "Daily sync", start: apr6 + 3600_000, from: apr6 + 3600_000, end: apr6 + 5400_000 });
  eq(titled.body.event.start, parisWinter(23, 10), "changing only the words leaves the time alone");
  eq((await window(...win)).map((o) => o.summary), ["Daily sync", "Daily sync", "Daily sync"], "and applies to every occurrence");

  // One occurrence removed, then the series.
  const m30 = (await window(...win))[1].start;
  eq((await call("DELETE", `/api/calendar/events/${standup.id}?scope=one&occurrence=${m30}`)).status, 200, "one occurrence is removed");
  eq(starts(await window(...win)), ["2026-03-23 09:00", "2026-04-06 08:00"], "and the rest stay");
  eq(row(standup.id).exdates, String(m30), "as an exclusion on the series");
  eq((await call("DELETE", `/api/calendar/events/${standup.id}?scope=one`)).status, 400, "which has to say which");
  eq((await call("DELETE", `/api/calendar/events/${standup.id}`)).status, 200, "a series is deleted whole");
  eq([(await window(...win)).length, DB.raw.prepare("SELECT COUNT(*) AS n FROM cal_events").get().n], [0, 0], "with its edits");

  // A plain event that starts repeating, and a rule that starts after the day it was given.
  const plain = (await call("POST", "/api/calendar/events", { calendarId: cal, summary: "Gym", start: utc(2026, 3, 23, 7), end: utc(2026, 3, 23, 8), tzid: "UTC" })).body.event;
  const gym = await call("PATCH", `/api/calendar/events/${plain.id}`, { rrule: "FREQ=WEEKLY;BYDAY=TU,TH;COUNT=3" });
  eq(gym.body.event.start, utc(2026, 3, 24, 7), "a rule that does not include the start day puts the event on its first day");
  eq(starts(await window(...win)), ["2026-03-24 07:00", "2026-03-26 07:00", "2026-03-31 07:00"], "and expands from there");
  await call("DELETE", `/api/calendar/events/${plain.id}`);

  // ── invitations from mail ────────────────────────────────

  DB.raw.prepare("INSERT INTO messages (id, account_id, pid, folder, subject, created_at) VALUES (?,?,?,?,?,0)").run("aaaaaaaaaaaaaaaa", "a1", "p1", "inbox", "Design review");
  DB.raw.prepare("INSERT INTO messages (id, account_id, pid, folder, subject, created_at) VALUES (?,?,?,?,?,0)").run("bbbbbbbbbbbbbbbb", "a1", "p2", "trash", "Old");
  for (const [id, at] of [["aaaaaaaaaaaaaaaa", utc(2026, 3, 24, 13)], ["bbbbbbbbbbbbbbbb", utc(2026, 3, 24, 15)]]) {
    DB.raw.prepare("INSERT INTO events (id, account_id, summary, start_ms, end_ms, created_at) VALUES (?,?,?,?,?,0)").run(id, "a1", "Design review", at, at + 3600_000);
  }
  DB.raw.prepare("INSERT INTO settings (key, value) VALUES ('rsvp_aaaaaaaaaaaaaaaa', 'accepted')").run();
  await call("POST", "/api/calendar/events", { calendarId: cal, summary: "Mine", start: utc(2026, 3, 24, 9), end: utc(2026, 3, 24, 10), tzid: "UTC" });
  occ = await window(...win);
  eq(occ.map((o) => o.summary), ["Mine", "Design review"], "invitations are merged in with your own events, in order");
  eq(
    [occ[1].calendarId, occ[1].readOnly, occ[1].rsvp, occ[1].messageId, occ[1].id],
    ["invitations", true, "accepted", "aaaaaaaaaaaaaaaa", "inv:aaaaaaaaaaaaaaaa"],
    "read-only, in the Invitations calendar, with the answer given and the message to open"
  );
  eq(occ.some((o) => o.eventId === "bbbbbbbbbbbbbbbb"), false, "one in the trash is not shown");
  eq(DB.raw.prepare("SELECT COUNT(*) AS n FROM cal_events").get().n, 1, "and nothing was copied into the calendar's own table");
  eq((await call("PATCH", "/api/calendar/events/aaaaaaaaaaaaaaaa", { summary: "x" })).status, 404, "an invitation cannot be edited here");
  await call("DELETE", `/api/calendar/events/${(await window(...win))[0].eventId}`);

  // ── import and export ────────────────────────────────────

  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-CALNAME:Imported",
    "BEGIN:VEVENT", "UID:a1@test", "DTSTART;TZID=Europe/Paris:20260323T090000", "DTEND;TZID=Europe/Paris:20260323T093000",
    "RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE;TZID=Europe/Paris:20260406T090000", "SUMMARY:Weekly\\, sync", "LOCATION:Room 4",
    "DESCRIPTION:Line one\\nLine two", "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M", "END:VALARM", "END:VEVENT",
    "BEGIN:VEVENT", "UID:a1@test", "RECURRENCE-ID;TZID=Europe/Paris:20260330T090000", "DTSTART;TZID=Europe/Paris:20260330T100000",
    "DTEND;TZID=Europe/Paris:20260330T103000", "SUMMARY:Weekly\\, sync (moved)", "END:VEVENT",
    "BEGIN:VEVENT", "UID:a2@test", "DTSTART;VALUE=DATE:20260401", "DTEND;VALUE=DATE:20260403", "SUMMARY:Offsite", "END:VEVENT",
    "BEGIN:VEVENT", "UID:a3@test", "DTSTART:20260410T090000", "DTEND:20260410T100000", "SUMMARY:Floating", "END:VEVENT",
    "BEGIN:VEVENT", "UID:a4@test", "DTSTART:20260411T090000Z", "DTEND:20260411T100000Z", "SUMMARY:UTC one", "URL:https://example.com/x", "END:VEVENT",
    "BEGIN:VEVENT", "UID:a5@test", "DTSTART:20260412T090000Z", "STATUS:CANCELLED", "SUMMARY:Cancelled", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const target = (await call("POST", "/api/calendar/calendars", { name: "Imported", color: "#8a5cc7" })).body.calendar.id;
  const imp = await call("POST", `/api/calendar/calendars/${target}/import`, undefined, ics);
  eq([imp.status, imp.body.imported, imp.body.skipped], [200, 5, 1], "a file is imported, a cancelled event left out");
  eq(rem(row(DB.raw.prepare("SELECT id FROM cal_events WHERE uid='a1@test' AND recurrence_id IS NULL").get().id).id)?.at, utc(2026, 3, 23, 8) - 15 * MIN, "and its alarm becomes a reminder for the next occurrence");
  occ = (await window(utc(2026, 3, 22), utc(2026, 4, 13))).filter((o) => o.calendarId === target);
  eq(occ.map((o) => `${iso(o.start)} ${o.summary}`), [
    "2026-03-23 08:00 Weekly, sync", "2026-03-30 08:00 Weekly, sync (moved)", "2026-04-01 00:00 Offsite", "2026-04-10 09:00 Floating", "2026-04-11 09:00 UTC one",
  ], "its events read back: the series with an exclusion and an edit, an all-day, a floating hour and one in UTC");
  eq(occ.find((o) => o.summary === "Floating").floating, true, "an hour with no zone stays floating");
  eq(DB.raw.prepare("SELECT description FROM cal_events WHERE uid='a1@test' AND recurrence_id IS NULL").get().description, "Line one\nLine two", "text escapes are undone");

  const out = await call("GET", `/api/calendar/calendars/${target}/export`);
  eq(out.status, 200, "a calendar is exported");
  eq(out.res.headers.get("content-type").startsWith("text/calendar"), true, "as text/calendar");
  eq(out.res.headers.get("content-disposition"), 'attachment; filename="Imported.ics"', "to be saved as a file");
  for (const line of ["RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE;TZID=Europe/Paris:20260406T090000", "RECURRENCE-ID;TZID=Europe/Paris:20260330T090000", "TRIGGER:-PT15M", "DTSTART;VALUE=DATE:20260401", "DTSTART:20260410T090000", "DTSTART:20260411T090000Z"]) {
    ok(out.body.includes(line), `the file says ${line}`);
  }
  ok(out.body.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75), "no line is longer than 75 octets");
  const norm = (text) => parseCalendar(text).events.map((e) => ({ ...e })).sort((a, b) => (a.uid + a.recurrenceId).localeCompare(b.uid + b.recurrenceId));
  const kept = norm(ics).filter((e) => e.uid !== "a5@test");
  eq(norm(out.body), kept, "what is exported reads back as the events that went in");

  const copy = (await call("POST", "/api/calendar/calendars", { name: "Copy", color: "#8a5cc7" })).body.calendar.id;
  await call("POST", `/api/calendar/calendars/${copy}/import`, undefined, out.body);
  const cols = "uid, summary, location, description, url, start_ms, end_ms, all_day, tzid, rrule, exdates, reminder_min, recurrence_id";
  const dump = (c) => DB.raw.prepare(`SELECT ${cols} FROM cal_events WHERE calendar_id=? ORDER BY uid, recurrence_id`).all(c).map((r) => ({ ...r }));
  eq(dump(copy), dump(target), "import then export then import gives the same events");
  await call("POST", `/api/calendar/calendars/${target}/import`, undefined, ics);
  eq(DB.raw.prepare("SELECT COUNT(*) AS n FROM cal_events WHERE calendar_id=?").get(target).n, 5, "importing the same file again replaces rather than doubles");
  eq((await call("POST", `/api/calendar/calendars/${target}/import`, undefined, "hello")).status, 400, "a file that is not a calendar is refused");
  LIM.importBytes = 100;
  eq((await call("POST", `/api/calendar/calendars/${target}/import`, undefined, ics)).status, 413, "so is one that is too large");
  LIM.importBytes = saved.importBytes;
  eq((await call("GET", "/api/calendar/calendars/nope/export")).status, 404, "an unknown calendar has no export");

  // ── subscriptions ────────────────────────────────────────

  const feed = (events, stamp = "20260101T000000Z") =>
    ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.flatMap((e) => [
      "BEGIN:VEVENT", ...(e.uid ? [`UID:${e.uid}`] : []), `DTSTAMP:${stamp}`, `DTSTART:${e.start}`, `DTEND:${e.end}`, `SUMMARY:${e.summary}`,
      ...(e.alarm ? ["BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT10M", "END:VALARM"] : []), "END:VEVENT",
    ]), "END:VCALENDAR"].join("\r\n");
  const A = { uid: "f1", start: "20260401T090000Z", end: "20260401T100000Z", summary: "Match day", alarm: true };
  const B = { uid: "f2", start: "20260402T090000Z", end: "20260402T100000Z", summary: "Training" };
  web = async () => new Response(feed([A, B]), { status: 200 });

  for (const bad of ["http://example.com/f.ics", "https://127.0.0.1/f.ics", "https://localhost/f.ics", "https://[::1]/f.ics", "https://10.0.0.5/f.ics", "https://2130706433/f.ics", "https://intranet/f.ics", "https://u:p@example.com/f.ics", "https://printer.local/f.ics", "https://example.com:8443/f.ics", "ftp://example.com/x", "not a url", ""]) {
    const r = await call("POST", "/api/calendar/calendars", { name: "Bad", color: "#1f6fd0", url: bad });
    eq(r.status, 400, `an address that is refused: ${JSON.stringify(bad)}`);
  }
  eq(fetched.length, 0, "and none of them was fetched");
  eq(feedUrl("webcal://example.com/f.ics").url, "https://example.com/f.ics", "webcal means https");

  const sub = await call("POST", "/api/calendar/calendars", { name: "Team", color: "#e0892b", url: "webcal://example.com/team.ics", refreshMin: 60 });
  eq([sub.status, sub.body.calendar.kind, sub.body.calendar.readOnly, sub.body.calendar.events, sub.body.calendar.lastError], [201, "subscription", true, 2, ""], "a subscription is made and read at once");
  eq(fetched, ["https://example.com/team.ics"], "from the https address");
  const subId = sub.body.calendar.id;
  const everything = JSON.stringify([(await call("GET", "/api/calendar/calendars")).body, sub.body]);
  ok(!everything.includes("example.com") && !/url/i.test(everything.replace(/events/g, "")), "its address is never sent back to the page");
  const stored = DB.raw.prepare("SELECT url_sealed FROM calendars WHERE id=?").get(subId).url_sealed;
  ok(!stored.includes("example.com") && (await open(key, stored)).url === "https://example.com/team.ics", "and is sealed at rest");
  eq(DB.raw.prepare("SELECT COUNT(*) AS n FROM reminders r JOIN cal_events e ON e.id = r.ref WHERE e.calendar_id=?").get(subId).n, 0, "a feed's alarms make no reminder");
  eq((await window(utc(2026, 3, 30), utc(2026, 4, 5))).filter((o) => o.calendarId === subId).map((o) => [o.summary, o.readOnly]), [["Match day", true], ["Training", true]], "its events are in the calendar, read-only");
  const matchRow = DB.raw.prepare("SELECT id FROM cal_events WHERE calendar_id=? AND uid='f1'").get(subId).id;
  eq((await call("PATCH", `/api/calendar/events/${matchRow}`, { summary: "x" })).status, 403, "an event of a subscription cannot be changed");
  eq((await call("DELETE", `/api/calendar/events/${matchRow}`)).status, 403, "or deleted");
  eq((await call("POST", "/api/calendar/events", { calendarId: subId, summary: "x", start: 1, end: 2 })).status, 400, "or added to");
  eq((await call("POST", `/api/calendar/calendars/${subId}/import`, undefined, ics)).status, 400, "or imported into");
  eq((await call("GET", `/api/calendar/events/${matchRow}`)).body.event.readOnly, true, "and is marked read-only when read");

  // Unchanged: only a timestamp in the feed differs, so nothing is written.
  const wrote = () => sql.filter((s) => /^(DELETE FROM cal_events|INSERT OR REPLACE INTO cal_events)/.test(s)).length;
  web = async () => new Response(feed([A, B], "20260315T120000Z"), { status: 200 });
  let w0 = wrote();
  clock += 10 * MIN;
  const same = await call("POST", `/api/calendar/calendars/${subId}/refresh`);
  eq([same.body.ok, same.body.changed, wrote() - w0], [true, false, 0], "a refresh of a feed that has not changed writes nothing");
  eq(DB.raw.prepare("SELECT fetched_at FROM calendars WHERE id=?").get(subId).fetched_at, clock, "but notes when it looked");

  // Changed: replaced as a whole.
  const C = { uid: "f3", start: "20260403T090000Z", end: "20260403T100000Z", summary: "Final" };
  web = async () => new Response(feed([B, C]), { status: 200 });
  const ch = await call("POST", `/api/calendar/calendars/${subId}/refresh`);
  eq([ch.body.ok, ch.body.changed], [true, true], "a feed that changed is taken");
  eq((await window(utc(2026, 3, 30), utc(2026, 4, 5))).filter((o) => o.calendarId === subId).map((o) => o.summary), ["Training", "Final"], "replaced as a whole, so an event it dropped is gone");

  // Failing: said on the calendar, events kept, nothing thrown.
  const fails = [
    ["a server error", async () => new Response("no", { status: 500 }), "The server answered 500"],
    ["a refusal to connect", async () => { throw new TypeError("fetch failed"); }, "Could not reach the server"],
    ["something that is not a calendar", async () => new Response("<html>hello</html>", { status: 200 }), "That address did not return a calendar"],
    ["a redirect to plain http", async () => new Response(null, { status: 302, headers: { location: "http://example.com/x" } }), "Only https"],
    ["a redirect to an IP address", async () => new Response(null, { status: 301, headers: { location: "https://192.168.0.1/x" } }), "IP address"],
  ];
  for (const [what, handler, says] of fails) {
    web = handler;
    clock += MIN;
    const r = await call("POST", `/api/calendar/calendars/${subId}/refresh`);
    const shown = (await call("GET", "/api/calendar/calendars")).body.calendars.find((c) => c.id === subId);
    ok(!r.body.ok && shown.lastError.includes(says), `${what} is written on the calendar: ${shown.lastError}`);
    eq(shown.events, 2, `and its events stay (${what})`);
  }
  let hops = 0;
  web = async (url) => (++hops <= 2 ? new Response(null, { status: 302, headers: { location: "https://cdn.example.org/team.ics" } }) : new Response(feed([B, C]), { status: 200 }));
  eq((await call("POST", `/api/calendar/calendars/${subId}/refresh`)).body.ok, true, "a redirect to another https address is followed");
  hops = -100;
  web = async () => new Response(null, { status: 302, headers: { location: "https://cdn.example.org/again.ics" } });
  ok(!(await call("POST", `/api/calendar/calendars/${subId}/refresh`)).body.ok, "a chain of redirects is cut off");

  LIM.feedBytes = 1000;
  const bigBody = feed([B]) + "\r\n" + "X-FILL:" + "x".repeat(5000);
  web = async () => new Response(bigBody, { status: 200, headers: { "content-length": String(bigBody.length) } });
  ok((await call("POST", `/api/calendar/calendars/${subId}/refresh`)).body.error.includes("too large"), "a feed that says it is too large is refused unread");
  let pulled = 0;
  web = async () => new Response(new ReadableStream({ pull(c) { pulled++; c.enqueue(new TextEncoder().encode("x".repeat(400))); } }), { status: 200 });
  ok((await call("POST", `/api/calendar/calendars/${subId}/refresh`)).body.error.includes("too large"), "and one that does not say is cut off as it arrives");
  ok(pulled < 10, `after a few chunks, not the whole of an endless one (${pulled})`);
  LIM.feedBytes = saved.feedBytes;

  LIM.feedTimeoutMs = 40;
  web = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  const slow = await call("POST", `/api/calendar/calendars/${subId}/refresh`);
  ok(slow.body.error.includes("too long"), "a server that never answers is given up on");
  LIM.feedTimeoutMs = saved.feedTimeoutMs;

  LIM.feedEvents = 3;
  web = async () => new Response(feed([A, B, C, { uid: "f4", start: "20260404T090000Z", end: "20260404T100000Z", summary: "Fourth" }]), { status: 200 });
  const capped = await call("POST", `/api/calendar/calendars/${subId}/refresh`);
  eq([capped.body.calendar.events, capped.body.calendar.lastError], [3, "Showing the first 3 events"], "a feed with too many events keeps the first and says so");
  LIM.feedEvents = saved.feedEvents;

  // An event with no UID keeps its row from one refresh to the next.
  const N1 = { start: "20260405T090000Z", end: "20260405T100000Z", summary: "Anonymous one" };
  const N2 = { start: "20260406T090000Z", end: "20260406T100000Z", summary: "Anonymous two" };
  const N3 = { start: "20260407T090000Z", end: "20260407T100000Z", summary: "Anonymous three" };
  web = async () => new Response(feed([N1, N2]), { status: 200 });
  await call("POST", `/api/calendar/calendars/${subId}/refresh`);
  const ids = () => DB.raw.prepare("SELECT id, summary FROM cal_events WHERE calendar_id=? ORDER BY summary").all(subId).map((r) => `${r.summary}:${r.id}`);
  const before = ids();
  web = async () => new Response(feed([N1, N2, N3], "20260320T000000Z"), { status: 200 });
  await call("POST", `/api/calendar/calendars/${subId}/refresh`);
  const after = ids();
  eq(before.length, 2, "events with no UID are kept");
  eq(before.every((x) => after.includes(x)), true, "and keep the same row when the feed is read again with something else added");
  eq(after.length, 3, "while the new one is added");
  ok(DB.raw.prepare("SELECT uid FROM cal_events WHERE calendar_id=? AND summary='Anonymous one'").get(subId).uid.startsWith("nouid-"), "under an id made from what the event says");

  // The cron fetches a subscription when it is due, and not before.
  web = async () => new Response(feed([B, C]), { status: 200 });
  fetched.length = 0;
  clock += 5 * MIN;
  await calendarModule.cron(env);
  eq(fetched.length, 0, "the cron leaves a subscription alone until its time");
  clock += 61 * MIN;
  await calendarModule.cron(env);
  eq(fetched.length, 1, "and fetches it when its hour is up");
  await calendarModule.cron(env);
  eq(fetched.length, 1, "once");
  eq((await call("PATCH", `/api/calendar/calendars/${subId}`, { name: "Team", color: "#e0892b", refreshMin: 5 })).body.calendar.refreshMin, 15, "a refresh time is held to between 15 minutes and a day");
  eq((await call("PATCH", `/api/calendar/calendars/${subId}`, { name: "Team", color: "#e0892b", refreshMin: 99999 })).body.calendar.refreshMin, 1440, "and a day");
  const renamed = await call("PATCH", `/api/calendar/calendars/${subId}`, { name: "Team", color: "#e0892b", url: "https://other.example.net/x.ics" });
  eq([renamed.status, fetched.at(-1)], [200, "https://other.example.net/x.ics"], "a new address is fetched at once");
  eq((await call("DELETE", `/api/calendar/calendars/${subId}`)).status, 200, "a subscription is deleted");
  eq(DB.raw.prepare("SELECT COUNT(*) AS n FROM cal_events WHERE calendar_id=?").get(subId).n, 0, "with its events");

  // ── reminders ────────────────────────────────────────────

  DB.raw.exec("DELETE FROM reminders");
  clock = utc(2026, 3, 20, 10);
  const soon = (await call("POST", "/api/calendar/events", {
    calendarId: cal, summary: "Review", location: "Room 4", start: clock + 2 * 3600_000, end: clock + 3 * 3600_000, tzid: "UTC", reminderMin: 30,
  })).body.event;
  eq(
    [rem(soon.id).at, rem(soon.id).title, rem(soon.id).body],
    [clock + 90 * MIN, "Review", "In 30 minutes · Room 4"],
    "saving an event with a reminder sets one, a lead before it starts"
  );
  await call("PATCH", `/api/calendar/events/${soon.id}`, { start: clock + 3 * 3600_000, end: clock + 4 * 3600_000 });
  eq(rem(soon.id).at, clock + 150 * MIN, "moving the event moves its reminder");
  await call("PATCH", `/api/calendar/events/${soon.id}`, { summary: "Review!" });
  eq([rem(soon.id).at, rem(soon.id).title], [clock + 150 * MIN, "Review!"], "renaming it changes the words and not the time");
  await call("PATCH", `/api/calendar/events/${soon.id}`, { reminderMin: null });
  eq(rem(soon.id), undefined, "taking the reminder off removes it");
  await call("PATCH", `/api/calendar/events/${soon.id}`, { reminderMin: 10 });
  eq(rem(soon.id).at, clock + 170 * MIN, "and putting one back sets it again");
  await call("DELETE", `/api/calendar/events/${soon.id}`);
  eq(rem(soon.id), undefined, "deleting the event clears it");
  const tight = (await call("POST", "/api/calendar/events", { calendarId: cal, summary: "Tight", start: clock + 5 * MIN, end: clock + 65 * MIN, tzid: "UTC", reminderMin: 10 })).body.event;
  eq(rem(tight.id), undefined, "an event whose reminder time is already past gets none, rather than ringing at once");

  // A daily series: the reminder follows it, one occurrence at a time.
  const daily = (await call("POST", "/api/calendar/events", {
    calendarId: cal, summary: "Daily", start: utc(2026, 3, 20, 9), end: utc(2026, 3, 20, 10), tzid: "UTC", rrule: "FREQ=DAILY", reminderMin: 10,
  })).body.event;
  eq(iso(rem(daily.id).at), "2026-03-21 08:50", "a series' reminder is for its next occurrence still ahead");
  clock = utc(2026, 3, 21, 8, 51);
  await cron();
  eq(rem(daily.id).fired_at, clock, "it rings when due");
  await cron();
  eq(iso(rem(daily.id).at), "2026-03-21 08:50", "and stays on the list, undisturbed, until it is dealt with");
  const id = rem(daily.id).id;
  await call("POST", `/api/reminders/${id}/dismiss`);
  await cron();
  eq([iso(rem(daily.id).at), rem(daily.id).fired_at], ["2026-03-22 08:50", null], "dismissed, it moves to the following occurrence");
  clock = utc(2026, 3, 22, 8, 51);
  await cron();
  eq(rem(daily.id).fired_at, clock, "which rings in its turn");
  clock = utc(2026, 3, 22, 10, 30);
  await cron();
  eq([iso(rem(daily.id).at), rem(daily.id).fired_at], ["2026-03-23 08:50", null], "and one left alone moves on once its occurrence is over");

  // One occurrence moved earlier: the reminder follows it.
  const t23 = utc(2026, 3, 23, 9);
  await call("PATCH", `/api/calendar/events/${daily.id}`, { scope: "one", occurrence: t23, start: t23 - 2 * 3600_000, end: t23 - 3600_000 });
  eq(iso(rem(daily.id).at), "2026-03-23 06:50", "an occurrence moved earlier brings its reminder earlier");
  await call("DELETE", `/api/calendar/events/${daily.id}?scope=one&occurrence=${t23}`);
  eq(iso(rem(daily.id).at), "2026-03-24 08:50", "and one removed passes it on");
  await call("DELETE", `/api/calendar/events/${daily.id}`);
  eq(rem(daily.id), undefined, "deleting the series clears it");

  // A series that ends: the last occurrence's reminder is the last.
  const twice = (await call("POST", "/api/calendar/events", {
    calendarId: cal, summary: "Twice", start: utc(2026, 3, 23, 9), end: utc(2026, 3, 23, 10), tzid: "UTC", rrule: "FREQ=DAILY;COUNT=2", reminderMin: 10,
  })).body.event;
  clock = utc(2026, 3, 23, 8, 55);
  await cron();
  await call("POST", `/api/reminders/${rem(twice.id).id}/dismiss`);
  await cron();
  eq(iso(rem(twice.id).at), "2026-03-24 08:50", "a finite series passes its reminder on");
  clock = utc(2026, 3, 24, 11);
  await cron();
  eq(rem(twice.id), undefined, "and has none left after its last occurrence");

  // An all-day event rings at a time on its own date, in the zone it was made in.
  const day = (await call("POST", "/api/calendar/events", {
    calendarId: cal, summary: "Holiday", allDay: true, start: utc(2026, 3, 30), end: utc(2026, 3, 31), tzid: "Europe/Paris", reminderMin: -540,
  })).body.event;
  eq([iso(rem(day.id).at), rem(day.id).body], ["2026-03-30 07:00", "Today"], "an all-day event can ring at 9:00 on its day, and says so");
} finally {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  Object.assign(LIM, saved);
  clearInterval(keepAlive);
}
