/**
 * Recurrence rules (src/rrule.js): each frequency, the parts that narrow or
 * widen it, the awkward dates, a clock change in each direction, an all-day
 * series and a rule that never ends.
 *
 * A series is checked by the dates it lands on. Dates are written as
 * "YYYY-MM-DD" of the wall clock, so a test reads like a calendar.
 */
import { eq, ok } from "./harness.mjs";

const { expand, occurrences, parseRule, formatRule, LIMITS } = await import("../src/rrule.js");

const DAY = 86_400_000;
const utc = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi);
const iso = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const FOREVER = [utc(1990, 1, 1), utc(2100, 1, 1)];

/** An all-day series: its dates are UTC midnights. */
const allDay = (y, m, d, rule, extra = {}) => ({ startMs: utc(y, m, d), endMs: utc(y, m, d) + DAY, allDay: true, tzid: "", rule, ...extra });
const days = (s, from = FOREVER[0], to = FOREVER[1], opts) => expand(s, from, to, opts).map((o) => iso(o.startMs).slice(0, 10));

// ── frequencies ────────────────────────────────────────────

eq(days(allDay(2026, 1, 1, "FREQ=DAILY;COUNT=3")), ["2026-01-01", "2026-01-02", "2026-01-03"], "daily with COUNT");
eq(days(allDay(2026, 1, 1, "FREQ=DAILY;INTERVAL=2;COUNT=4")), ["2026-01-01", "2026-01-03", "2026-01-05", "2026-01-07"], "daily every second day");
eq(days(allDay(2026, 1, 1, "FREQ=DAILY;UNTIL=20260103")), ["2026-01-01", "2026-01-02", "2026-01-03"], "UNTIL as a date includes that day");
eq(
  days(allDay(2026, 1, 1, "FREQ=DAILY;UNTIL=20260103T000000Z")),
  ["2026-01-01", "2026-01-02", "2026-01-03"],
  "UNTIL as a UTC time includes an occurrence at exactly that time"
);
eq(days(allDay(2026, 1, 1, "FREQ=DAILY;UNTIL=20260102T000000Z")), ["2026-01-01", "2026-01-02"], "and stops there");
eq(
  days(allDay(2026, 1, 5, "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5")),
  ["2026-01-05", "2026-01-07", "2026-01-12", "2026-01-14", "2026-01-19"],
  "weekly on chosen days"
);
eq(days(allDay(2026, 1, 5, "FREQ=WEEKLY;COUNT=3")), ["2026-01-05", "2026-01-12", "2026-01-19"], "weekly with no BYDAY keeps the start's weekday");
eq(days(allDay(2026, 1, 5, "FREQ=WEEKLY;INTERVAL=3;COUNT=3")), ["2026-01-05", "2026-01-26", "2026-02-16"], "weekly every third week");
eq(days(allDay(2026, 1, 15, "FREQ=MONTHLY;COUNT=3")), ["2026-01-15", "2026-02-15", "2026-03-15"], "monthly on the start's day");
eq(days(allDay(2026, 1, 15, "FREQ=MONTHLY;INTERVAL=2;COUNT=3")), ["2026-01-15", "2026-03-15", "2026-05-15"], "monthly every second month");
eq(days(allDay(2026, 3, 10, "FREQ=YEARLY;COUNT=3")), ["2026-03-10", "2027-03-10", "2028-03-10"], "yearly");
eq(days(allDay(2026, 3, 10, "FREQ=YEARLY;INTERVAL=2;COUNT=3")), ["2026-03-10", "2028-03-10", "2030-03-10"], "yearly every second year");
eq(days(allDay(2026, 1, 10, "FREQ=MONTHLY;BYMONTHDAY=1,15;COUNT=4")), ["2026-01-15", "2026-02-01", "2026-02-15", "2026-03-01"], "BYMONTHDAY lists, from the start on");
eq(days(allDay(2026, 1, 30, "FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3")), ["2026-01-31", "2026-02-28", "2026-03-31"], "BYMONTHDAY=-1 is the last day, whatever the month");
eq(days(allDay(2026, 1, 1, "FREQ=YEARLY;BYMONTH=3,9;BYMONTHDAY=20;COUNT=3")), ["2026-03-20", "2026-09-20", "2027-03-20"], "yearly in chosen months");

// ── ordinals ───────────────────────────────────────────────

eq(days(allDay(2026, 1, 1, "FREQ=MONTHLY;BYDAY=2TU;COUNT=3")), ["2026-01-13", "2026-02-10", "2026-03-10"], "the second Tuesday of each month");
eq(days(allDay(2026, 1, 1, "FREQ=MONTHLY;BYDAY=-1FR;COUNT=3")), ["2026-01-30", "2026-02-27", "2026-03-27"], "the last Friday of each month");
eq(days(allDay(2026, 1, 1, "FREQ=MONTHLY;BYDAY=1MO,3MO;COUNT=4")), ["2026-01-05", "2026-01-19", "2026-02-02", "2026-02-16"], "two ordinals of one weekday");
eq(days(allDay(2026, 1, 1, "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3")), ["2026-01-30", "2026-02-27", "2026-03-31"], "BYSETPOS picks the last weekday");
eq(days(allDay(2026, 1, 1, "FREQ=YEARLY;BYDAY=20MO;COUNT=2")), ["2026-05-18", "2027-05-17"], "an ordinal with no month counts in the year");
eq(days(allDay(2026, 11, 1, "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH;COUNT=2")), ["2026-11-26", "2027-11-25"], "an ordinal with a month counts in it");

// RFC 5545 §3.8.5.3: the same rule reads differently by week start.
eq(
  days(allDay(1997, 8, 5, "FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO")),
  ["1997-08-05", "1997-08-10", "1997-08-19", "1997-08-24"],
  "WKST=MO, the RFC's example"
);
eq(
  days(allDay(1997, 8, 5, "FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU")),
  ["1997-08-05", "1997-08-17", "1997-08-19", "1997-08-31"],
  "WKST=SU gives the other answer"
);

// ── awkward dates ──────────────────────────────────────────

eq(
  days(allDay(2026, 1, 31, "FREQ=MONTHLY;COUNT=5")),
  ["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31", "2026-08-31"],
  "the 31st skips the months that do not have one"
);
eq(days(allDay(2024, 2, 29, "FREQ=YEARLY;COUNT=3")), ["2024-02-29", "2028-02-29", "2032-02-29"], "29 February comes back only in leap years");
eq(days(allDay(2028, 2, 29, "FREQ=YEARLY;INTERVAL=4;COUNT=2")), ["2028-02-29", "2032-02-29"], "and every fourth year by interval");

// ── exclusions and edits ───────────────────────────────────

const weekly = allDay(2026, 1, 5, "FREQ=WEEKLY;COUNT=4", { exdates: [utc(2026, 1, 12)] });
eq(days(weekly), ["2026-01-05", "2026-01-19", "2026-01-26"], "EXDATE removes an occurrence and COUNT still counts it");

const series = allDay(2026, 1, 5, "FREQ=WEEKLY;COUNT=4");
const moved = { recurrenceId: utc(2026, 1, 12), startMs: utc(2026, 1, 14), endMs: utc(2026, 1, 15), summary: "moved" };
const occ = occurrences(series, [moved], FOREVER[0], FOREVER[1]);
eq(occ.map((o) => iso(o.startMs).slice(0, 10)), ["2026-01-05", "2026-01-14", "2026-01-19", "2026-01-26"], "an edited occurrence stands where it was moved to, in order");
eq(occ.map((o) => o.override?.summary ?? null), [null, "moved", null, null], "and carries its own row");
eq(occ[1].recurrenceId, utc(2026, 1, 12), "with the start it had in the rule");
eq(
  occurrences(series, [moved], utc(2026, 1, 12), utc(2026, 1, 13)).length,
  0,
  "the slot it left is empty"
);
eq(
  occurrences(series, [moved], utc(2026, 1, 14), utc(2026, 1, 15)).map((o) => o.override?.summary),
  ["moved"],
  "and a window over where it went finds it though the rule has nothing there"
);

// ── clock changes ──────────────────────────────────────────

/** A series at `h`:00 on the wall of `tzid`, whose offset from UTC that day is `off` hours. */
const zoned = (tzid, y, m, d, h, off, rule) => ({ startMs: utc(y, m, d, h) - off * 3600_000, endMs: utc(y, m, d, h + 1) - off * 3600_000, allDay: false, tzid, rule });
const at = (s, n = 8) => expand(s, FOREVER[0], FOREVER[1], { limit: n }).map((o) => iso(o.startMs));

// Paris is UTC+1 in winter and UTC+2 from the last Sunday of March (29 March 2026)
// to the last Sunday of October (25 October 2026).
eq(
  at(zoned("Europe/Paris", 2026, 3, 23, 9, 1, "FREQ=WEEKLY;COUNT=3")),
  ["2026-03-23 08:00", "2026-03-30 07:00", "2026-04-06 07:00"],
  "9:00 in Paris stays 9:00 when the clocks go forward"
);
eq(
  at(zoned("Europe/Paris", 2026, 10, 19, 9, 2, "FREQ=WEEKLY;COUNT=3")),
  ["2026-10-19 07:00", "2026-10-26 08:00", "2026-11-02 08:00"],
  "and when they go back"
);
// New York: EST is UTC-5, EDT UTC-4; forward on 8 March 2026, back on 1 November.
eq(
  at(zoned("America/New_York", 2026, 3, 2, 9, -5, "FREQ=WEEKLY;COUNT=3")),
  ["2026-03-02 14:00", "2026-03-09 13:00", "2026-03-16 13:00"],
  "9:00 in New York stays 9:00 going forward"
);
eq(
  at(zoned("America/New_York", 2026, 10, 26, 9, -4, "FREQ=WEEKLY;COUNT=3")),
  ["2026-10-26 13:00", "2026-11-02 14:00", "2026-11-09 14:00"],
  "and going back"
);
eq(
  at(zoned("Europe/Paris", 2026, 3, 28, 9, 1, "FREQ=DAILY;COUNT=3")),
  ["2026-03-28 08:00", "2026-03-29 07:00", "2026-03-30 07:00"],
  "a daily one changes its instant on the day the clocks change"
);
const lasting = zoned("Europe/Paris", 2026, 3, 28, 9, 1, "FREQ=DAILY;COUNT=3");
eq(expand(lasting, FOREVER[0], FOREVER[1])[1].endMs - expand(lasting, FOREVER[0], FOREVER[1])[1].startMs, 3600_000, "its length is kept");
// An hour with no zone is the same hour wherever it is read: no offset applied.
eq(
  at({ startMs: utc(2026, 3, 23, 9), endMs: utc(2026, 3, 23, 10), allDay: false, tzid: "", rule: "FREQ=WEEKLY;COUNT=3" }),
  ["2026-03-23 09:00", "2026-03-30 09:00", "2026-04-06 09:00"],
  "a floating hour keeps its wall time"
);

// ── windows ────────────────────────────────────────────────

const old = allDay(2000, 1, 1, "FREQ=DAILY");
eq(days(old, utc(2026, 3, 1), utc(2026, 3, 4)), ["2026-03-01", "2026-03-02", "2026-03-03"], "a series from years ago jumps to the window");
eq(
  days(allDay(2000, 1, 1, "FREQ=MONTHLY;BYDAY=2TU"), utc(2026, 3, 1), utc(2026, 4, 1)),
  ["2026-03-10"],
  "monthly and ordinal, the same"
);
eq(days(allDay(2026, 1, 5, "FREQ=WEEKLY;COUNT=3"), utc(2026, 1, 12), utc(2026, 1, 13)), ["2026-01-12"], "a window over one occurrence finds it");
eq(days(allDay(2026, 1, 5, "FREQ=WEEKLY;COUNT=3"), utc(2026, 3, 1), utc(2026, 4, 1)), [], "and one after the last finds none");
eq(
  days(allDay(2026, 1, 5, "FREQ=WEEKLY;COUNT=3"), utc(2026, 1, 12, 12), utc(2026, 1, 12, 13)),
  ["2026-01-12"],
  "an all-day occurrence is found by a window inside it"
);
// An all-day occurrence is a stored midnight, a whole day long.
const first = expand(allDay(2026, 1, 5, "FREQ=WEEKLY;COUNT=2"), FOREVER[0], FOREVER[1])[0];
eq([first.startMs, first.endMs - first.startMs], [utc(2026, 1, 5), DAY], "an all-day series keeps midnight and a day's length");
eq(days({ startMs: utc(2026, 5, 5), endMs: utc(2026, 5, 6), allDay: true, tzid: "", rule: "" }), ["2026-05-05"], "no rule is one occurrence");

// ── what a rule may not do ─────────────────────────────────

const t0 = Date.now();
eq(days(allDay(2026, 1, 1, "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=31"), utc(2026, 1, 1), utc(12000, 1, 1)), [], "a rule that never matches ends");
const runaway = expand(allDay(2026, 1, 1, "FREQ=DAILY"), utc(2026, 1, 1), utc(6000, 1, 1));
eq(runaway.length, LIMITS.out, "an endless rule over a huge window returns no more than the cap");
const wide = expand(allDay(1, 1, 1, "FREQ=DAILY;COUNT=999999"), utc(2026, 1, 1), utc(2027, 1, 1));
ok(wide.length <= LIMITS.out, "a COUNT beyond what is kept is bounded");
ok(Date.now() - t0 < 3000, `and all of it is quick (${Date.now() - t0} ms)`);
eq(parseRule("FREQ=DAILY;COUNT=999999").count, LIMITS.count, "COUNT is clamped when read");
eq(expand(allDay(2026, 1, 1, "FREQ=DAILY"), utc(2026, 1, 1), utc(2026, 2, 1), { limit: 3 }).length, 3, "a caller can ask for fewer");

for (const bad of ["", "FREQ=SECONDLY", "FREQ=HOURLY;COUNT=3", "FREQ=DAILY;INTERVAL=0", "FREQ=DAILY;BYHOUR=9", "COUNT=3", "FREQ=WEEKLY;BYDAY=XX", "FREQ=MONTHLY;BYMONTHDAY=32", "FREQ=DAILY;;", "nonsense"]) {
  eq(parseRule(bad), null, `a rule that is not read: ${JSON.stringify(bad)}`);
}
eq(
  formatRule(parseRule("RRULE:freq=weekly;byday=mo,we;interval=2;until=20261231T000000Z")),
  "FREQ=WEEKLY;INTERVAL=2;UNTIL=20261231T000000Z;BYDAY=MO,WE",
  "a rule is written back in one fixed order"
);
eq(formatRule(parseRule("FREQ=MONTHLY;BYDAY=-1FR;WKST=SU")), "FREQ=MONTHLY;BYDAY=-1FR;WKST=SU", "ordinals and WKST survive the round trip");
eq(days({ startMs: utc(2026, 1, 1), endMs: utc(2026, 1, 2), allDay: true, tzid: "", rule: "FREQ=SECONDLY" }), ["2026-01-01"], "an unreadable rule leaves the event as one occurrence");
