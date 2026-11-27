/**
 * Demo-only calendar API for scripts/demo-server.mjs.
 *
 * It is the real calendar module (src/calendar.js) over an in-memory SQLite,
 * seeded with invented calendars and events around today, so the page can be
 * driven and photographed as it would be: events that are created, moved and
 * deleted here go through the same code as in the Worker. Nothing here is
 * deployed, and nothing in it is real.
 */
import { makeD1 } from "./sync-harness/fake.mjs";
import { SCHEMA } from "../src/schema.js";
import { calendarModule } from "../src/calendar.js";
import { seal } from "../src/crypto.js";

const env = { DB: makeD1(), ENC_KEY: "demo-only-key", APP_URL: "http://localhost" };
for (const s of SCHEMA) env.DB.raw.exec(s);

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const DAY = 86_400_000;
const today = new Date();
const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7));
/** Local wall time on the Monday of this week plus `d` days, as an instant. */
const at = (d, h, m = 0) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + d, h, m).getTime();
const midnightUtc = (d) => Date.UTC(monday.getFullYear(), monday.getMonth(), monday.getDate() + d);

const ask = async (method, path, body) => {
  const res = await calendarModule.api(
    new Request("http://localhost" + path, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
    path.split("?")[0]
  );
  return res.json();
};

const { calendars } = await ask("GET", "/api/calendar/calendars");
const personal = calendars.find((c) => c.kind === "local").id;
await ask("PATCH", `/api/calendar/calendars/${personal}`, { name: "Personal", color: "#1f6fd0" });
const work = (await ask("POST", "/api/calendar/calendars", { name: "Work", color: "#2e9e5b" })).calendar.id;

const add = (calendarId, summary, start, end, extra = {}) =>
  ask("POST", "/api/calendar/events", { calendarId, summary, start, end, tzid: zone, ...extra });

await add(work, "Standup", at(0, 9, 30), at(0, 9, 45), { rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", reminderMin: 10, location: "Room 4" });
await add(work, "Design review", at(1, 14), at(1, 15, 30), { location: "Studio", description: "Bring the v2 mockups." });
await add(work, "Planning", at(1, 14, 30), at(1, 16), { location: "Room 2" });
await add(work, "Roadmap workshop", at(3, 10), at(3, 12, 30), { location: "Atelier Roux" });
await add(work, "Offsite", midnightUtc(3), midnightUtc(5), { allDay: true, location: "Lyon" });
await add(personal, "Lunch with Camille", at(2, 12, 30), at(2, 14), { location: "Le Petit Bistrot", reminderMin: 30 });
await add(personal, "Dentist", at(4, 8, 30), at(4, 9, 15), { reminderMin: 60 });
await add(personal, "Climbing", at(0, 18, 30), at(0, 20), { rrule: "FREQ=WEEKLY;BYDAY=MO,TH" });
await add(personal, "Camille's birthday", midnightUtc(5), midnightUtc(6), { allDay: true });
await add(personal, "Trip to the coast", at(5, 9), at(6, 17), { description: "Back Sunday evening." });
await add(personal, "Rent", midnightUtc(3), midnightUtc(4), { allDay: true, rrule: "FREQ=MONTHLY" });
await add(personal, "Book club", at(7 + 2, 19), at(7 + 2, 21), { rrule: "FREQ=MONTHLY;BYDAY=2WE", location: "Library" });

// A calendar subscribed to on the web: its rows are written directly, since the
// demo has no web to fetch from.
const feed = "demo-feed";
env.DB.raw
  .prepare("INSERT INTO calendars (id, name, color, kind, url_sealed, refresh_min, fetched_at, position, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
  .run(feed, "City FC", "#e0892b", "subscription", await seal(env.ENC_KEY, { url: "https://example.org/city-fc.ics" }), 360, Date.now() - 20 * 60000, 5, Date.now());
const insert = env.DB.raw.prepare(
  "INSERT INTO cal_events (id, calendar_id, uid, summary, location, start_ms, end_ms, all_day, tzid, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,0,0)"
);
[["Home v Rovers", "Stade du Parc", at(2, 20, 45), at(2, 22, 45)], ["Away at Harbour", "Harbour Ground", at(5, 15), at(5, 17)], ["Home v United", "Stade du Parc", at(9, 18), at(9, 20)]].forEach(
  ([name, place, s, e], i) => insert.run(`fc${i}`, feed, `fc${i}@demo`, name, place, s, e, "UTC")
);

// An invitation found in mail, as the sync would have indexed it.
env.DB.raw.prepare("INSERT INTO messages (id, account_id, pid, folder, subject, from_name, from_email, created_at) VALUES (?,?,?,?,?,?,?,0)").run("1111111111111111", "a1", "inv1", "inbox", "Invitation: Customer call", "Léa Martin", "lea@studio-martin.com");
env.DB.raw.prepare("INSERT INTO events (id, account_id, summary, location, url, start_ms, end_ms, status, organizer, created_at) VALUES (?,?,?,?,?,?,?,?,?,0)").run("1111111111111111", "a1", "Customer call", "Online", "https://meet.example.org/abc", at(2, 16), at(2, 17), "CONFIRMED", "Léa Martin <lea@studio-martin.com>");

/** The handler demo-server.mjs hands every /api/calendar/ request to. */
export default async function calendarDemo(req, res, url) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const out = await calendarModule.api(
    new Request(url.href, { method: req.method, body: ["GET", "HEAD"].includes(req.method) ? undefined : body }),
    env,
    url.pathname
  );
  if (!out) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(out.status, { ...Object.fromEntries(out.headers), "X-Shell": "v40" });
  res.end(Buffer.from(await out.arrayBuffer()));
}
