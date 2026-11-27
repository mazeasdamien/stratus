/**
 * Demo-only static server with a fake mail API, used to shoot README
 * screenshots. Not part of the deployed app.
 *
 *   node scripts/demo-server.mjs 8765
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { demoContacts } from "./demo-contacts.mjs";
import { readingBodies, readingMessages } from "./demo-reading.mjs";
import { demoTransfer } from "./demo-transfer.mjs";
import { CLIENT_VERSION } from "../src/version.js";
import { catalog, cleanRule } from "../src/rules.js";

// The calendar view's API: the real module over a seeded in-memory database.
const calendarDemo = (await import("./demo-calendar.mjs")).default;

const root = join(fileURLToPath(new URL("..", import.meta.url)), "public");
const port = Number(process.argv[2] || 8765);

const now = Date.now();
const accounts = [{ id: "a1", email: "you@icloud.com", provider: "icloud", color: "#1f6fd0" }];
const folders = [
  { folder: "inbox", n: 12, unread: 3 },
  { folder: "archive", n: 40, unread: 0 },
  { folder: "sent", n: 88, unread: 0 },
  { folder: "drafts", n: 2, unread: 0 },
  { folder: "spam", n: 5, unread: 1 },
  { folder: "trash", n: 1, unread: 0 },
  { folder: "Newsletters", n: 14, unread: 2 },
  { folder: "Work/Clients", n: 9, unread: 0 },
];
const messages = [
  {
    id: "m1", account_id: "a1", mid: "<m1@demo>", pid: "m1", thread_key: "t1", folder: "inbox",
    from_name: "Camille Roux", from_email: "camille@atelier-roux.fr",
    to_line: "you@icloud.com", cc_line: "", bcc_line: "",
    subject: "Photos du week-end", snippet: "Je t'ai mis les photos dans l'album partagé…",
    date: now - 12 * 60000, unread: 1, starred: 1, n: 1, cats: [1, 6], pinned: 1, importance: 1,
  },
  {
    id: "m2", account_id: "a1", mid: "<m2@demo>", pid: "m2", thread_key: "t2", folder: "inbox",
    from_name: "Apple", from_email: "no_reply@email.apple.com",
    to_line: "you@icloud.com", cc_line: "", bcc_line: "",
    subject: "Votre reçu Apple", snippet: "Merci pour votre achat sur l’App Store…",
    date: now - 2 * 3600000, unread: 1, starred: 0, n: 3, cats: [4], pinned: 0, importance: 0,
  },
  {
    id: "m3", account_id: "a1", mid: "<m3@demo>", pid: "m3", thread_key: "t3", folder: "inbox",
    from_name: "Léa Martin", from_email: "lea@studio-martin.com",
    to_line: "you@icloud.com", cc_line: "team@studio-martin.com", bcc_line: "",
    subject: "Re: maquette home", snippet: "La v2 est prête, dis-moi ce que tu en penses…",
    date: now - 5 * 3600000, unread: 0, starred: 0, n: 1, cats: [5, 2, 3, 6], pinned: 0, importance: -1,
  },
  {
    id: "m4", account_id: "a1", mid: "<m4@demo>", pid: "m4", thread_key: "t4", folder: "inbox",
    from_name: "GitHub", from_email: "noreply@github.com",
    to_line: "you@icloud.com", cc_line: "", bcc_line: "",
    subject: "[dmzs-mail] Build passed", snippet: "All checks have passed…",
    date: now - 8 * 3600000, unread: 1, starred: 0, n: 1,
  },
  {
    id: "m5", account_id: "a1", mid: "<m5@demo>", pid: "m5", thread_key: "t5", folder: "inbox",
    from_name: "Newsletter Café", from_email: "hello@cafe-news.fr",
    to_line: "you@icloud.com", cc_line: "", bcc_line: "",
    subject: "Cette semaine : trois lectures", snippet: "Trois articles à lire avec un café…",
    date: now - 26 * 3600000, unread: 0, starred: 0, n: 1,
  },
  {
    id: "m6", account_id: "a1", mid: "<m6@demo>", pid: "m6", thread_key: "t6", folder: "sent",
    from_name: "You", from_email: "you@icloud.com",
    to_line: "marc@garage-dupont.fr", cc_line: "", bcc_line: "",
    subject: "Devis pour la rénovation", snippet: "Pouvez-vous me confirmer le devis avant jeudi ?",
    date: now - 20 * 3600000, unread: 0, starred: 0, n: 1,
  },
];

// Follow-ups, as src/followup.js lists them: one due later, one overdue, and a
// sent message waiting for a reply.
let followups = [
  { message_id: "m1", account_id: "a1", thread_key: "t1", kind: "flag", due: now + 20 * 3600000, state: "waiting" },
  { message_id: "m3", account_id: "a1", thread_key: "t3", kind: "flag", due: now - 26 * 3600000, state: "reminded" },
  { message_id: "m6", account_id: "a1", thread_key: "t6", kind: "noreply", due: now + 2 * 86400000, state: "waiting" },
];

// Categories, as the Worker keeps them (src/categories.js): five to begin with,
// and a sixth with a longer name, so the chips and the editor have something to show.
let categories = [
  ["Red", 0], ["Orange", 1], ["Yellow", 2], ["Green", 3], ["Blue", 4], ["Project Atelier Roux", 5],
].map(([name, color], i) => ({ id: i + 1, name, color, position: i }));
const withCounts = () =>
  categories.map((c) => ({ ...c, n: messages.filter((m) => (m.cats || []).includes(c.id)).length }));
const readBody = (req) =>
  new Promise((resolve) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => {
      try { resolve(JSON.parse(s || "{}")); } catch { resolve({}); }
    });
  });

const bodies = {
  m1: {
    message: messages[0],
    account: accounts[0],
    body: {
      html: `<p>Bonjour !</p><p>Je t'ai mis les photos du week-end dans l'album partagé. La série du samedi au marché est plutôt réussie.</p><p>À très vite,<br>Camille</p>`,
      attachments: [], blocked: 0, empty: false, missing: false,
    },
  },
};

// A winmail.dat message and two that read right to left (scripts/demo-reading.mjs).
for (const m of readingMessages) {
  messages.push(m);
  bodies[m.id] = { message: m, account: accounts[0], body: { attachments: [], blocked: 0, empty: false, missing: false, ...readingBodies[m.id] } };
}

// Fired reminders for the header button and its sheet. Dismiss and snooze
// take one off for the life of the process, as the real routes would.
// Invented rules: one with a problem at iCloud, one switched off, one of each
// kind of action, so the sheet has something to show.
let rules = [
  { id: 1, name: "Newsletters", enabled: true, match: "any", stop: true, n: 128, last_at: now - 3 * 3600000, last_error: "", unreadable: false,
    conditions: [{ field: "from", op: "ends", value: "@cafe-news.fr" }, { field: "subject", op: "contains", value: "newsletter" }],
    actions: [{ type: "move", value: "Newsletters" }, { type: "read", value: "" }] },
  { id: 2, name: "Receipts", enabled: true, match: "all", stop: false, n: 12, last_at: now - 5 * 86400000, last_error: "",  unreadable: false,
    conditions: [{ field: "from", op: "contains", value: "apple" }, { field: "has_attachment", op: "is", value: "yes" }],
    actions: [{ type: "category", value: "4" }, { type: "star", value: "" }] },
  { id: 3, name: "Studio Martin", enabled: true, match: "all", stop: false, n: 4, last_at: now - 86400000, unreadable: false,
    last_error: "No mailbox matching \"Clients\". Server has: INBOX, Archive, Sent Messages",
    conditions: [{ field: "from", op: "is", value: "lea@studio-martin.com" }],
    actions: [{ type: "move", value: "Work/Clients" }, { type: "pin", value: "" }] },
  { id: 4, name: "Build noise", enabled: false, match: "all", stop: false, n: 0, last_at: null, last_error: "", unreadable: false,
    conditions: [{ field: "from", op: "is", value: "noreply@github.com" }, { field: "importance", op: "is_not", value: "high" }],
    actions: [{ type: "trash", value: "" }] },
];
const ruleRows = () => rules.map((r) => ({ ...r }));
const ruleCatalog = () => catalog();

let reminders = [
  { id: "r1", kind: "event", ref: "e1", title: "Design review", body: "Room 4, bring the mockups", at: now - 4 * 60000, fired_at: now - 3 * 60000 },
  { id: "r2", kind: "task", ref: "t1", title: "Send the invoice to Atelier Roux", body: "", at: now - 25 * 60000, fired_at: now - 24 * 60000 },
  { id: "r3", kind: "followup", ref: "m3", title: "Follow up: maquette home", body: "Léa has not replied since Monday. The v2 was waiting on her notes.", at: now - 2 * 3600000, fired_at: now - 2 * 3600000 },
];

// Invented tasks for the Tasks view, one or more in every group. The fake
// routes below keep them for the life of the process and group them with the
// real groupTasks, so the demo shows what the Worker would.
const HOUR = 3600000;
const dayUtc = (n) => { const d = new Date(now + n * 86400000); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); };
const at = (n, h, m = 0) => { const d = new Date(now); d.setDate(d.getDate() + n); d.setHours(h, m, 0, 0); return d.getTime(); };
const T = (id, title, o = {}) => ({
  id, title, notes: "", due: null, due_all_day: 0, reminder: null, important: 0, done_at: null,
  message_id: null, position: Number(id.slice(1)), created_at: now - Number(id.slice(1)) * 1000, updated_at: now, ...o,
});
let tasks = [
  T("t1", "Renew the car insurance", { due: dayUtc(-2), due_all_day: 1, important: 1 }),
  T("t2", "Send the invoice to Atelier Roux", { due: at(-1, 17), reminder: now + 2 * HOUR }),
  T("t3", "Reply to Camille about the photos", { due: at(0, 18), message_id: "m1" }),
  T("t4", "Book the dentist", { due: dayUtc(0), due_all_day: 1, notes: "Ask for an evening slot." }),
  T("t5", "Prepare the design review notes", { due: at(1, 9, 30), reminder: at(1, 9), important: 1 }),
  T("t6", "Order printer paper", { due: dayUtc(6), due_all_day: 1 }),
  T("t7", "Call the plumber"),
  T("t8", "Read the maquette feedback", { notes: "Léa's v2 notes are in the shared album." }),
  T("t9", "Pay the water bill", { done_at: now - 3 * HOUR }),
  T("t10", "Cancel the old gym membership", { done_at: now - 26 * HOUR }),
];
const taskOut = (t) => {
  const m = t.message_id && messages.find((x) => x.id === t.message_id);
  return {
    id: t.id, title: t.title, notes: t.notes, due: t.due, allDay: !!t.due_all_day, reminder: t.reminder,
    important: !!t.important, doneAt: t.done_at, message: m ? { id: m.id, subject: m.subject } : null,
    createdAt: t.created_at, updatedAt: t.updated_at,
  };
};
async function demoTasks(req, res, p, url) {
  const { groupTasks } = await import("../src/tasks.js");
  const body = req.method === "POST" ? JSON.parse((await new Promise((r) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => r(s || "{}")); }))) : {};
  if (p === "/api/tasks" && req.method === "GET") {
    const g = groupTasks(tasks.map((t) => ({ ...t, message: undefined })), Date.now(), url.searchParams.get("tz"));
    return json(res, { due: g.due, doneCount: g.doneCount, groups: g.groups.map((x) => ({ ...x, tasks: x.tasks.map(taskOut) })) });
  }
  if (p === "/api/tasks" && req.method === "POST") {
    const t = T(`t${Date.now() % 1e9}`, String(body.title || "").trim(), {
      message_id: body.messageId || null, due: body.due ?? null, due_all_day: body.allDay ? 1 : 0,
      reminder: body.reminder ?? null, important: body.important ? 1 : 0, notes: body.notes || "", position: tasks.length + 20,
    });
    tasks.push(t);
    return json(res, { task: taskOut(t) }, 201);
  }
  if (p === "/api/tasks/clear-completed") {
    tasks = tasks.filter((t) => t.done_at == null);
    return json(res, { ok: true });
  }
  const m = p.match(/^\/api\/tasks\/([^/]+?)(?:\/(complete|reopen))?$/);
  const t = m && tasks.find((x) => x.id === m[1]);
  if (!t) return json(res, { error: "No such task" }, 404);
  if (m[2]) t.done_at = m[2] === "complete" ? Date.now() : null;
  else if (req.method === "DELETE") tasks = tasks.filter((x) => x !== t);
  else if (req.method === "POST") {
    for (const [k, v] of Object.entries({ title: "title", notes: "notes", due: "due", reminder: "reminder" })) if (k in body) t[v] = body[k];
    if ("allDay" in body) t.due_all_day = body.allDay ? 1 : 0;
    if ("important" in body) t.important = body.important ? 1 : 0;
  }
  return json(res, req.method === "DELETE" ? { ok: true } : { task: taskOut(t) });
}

for (const m of messages.slice(2)) {
  if (m.id === "m3" || m.id === "m6") {
    bodies[m.id] = {
      message: m, account: accounts[0],
      body: { html: `<p>Bonjour,</p><p>${m.snippet}</p>`, attachments: [], blocked: 0, empty: false, missing: false },
    };
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
};

const json = (res, data, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json", "X-Shell": CLIENT_VERSION });
  res.end(JSON.stringify(data));
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const p = url.pathname;
  if (p.startsWith("/api/")) {
    if (p.startsWith("/api/calendar/")) return calendarDemo(req, res, url);
    if (p === "/api/reminders") return json(res, { reminders, count: reminders.length });
    const rem = p.match(/^\/api\/reminders\/([^/]+)\/(?:dismiss|snooze)$/);
    if (rem) {
      reminders = reminders.filter((r) => r.id !== rem[1]);
      return json(res, { ok: true });
    }
    if (await demoContacts(req, res, p)) return;
    if (p.startsWith("/api/tasks")) return demoTasks(req, res, p, url);
    if (p === "/api/followups" && req.method === "GET") return json(res, { followups });
    if (p === "/api/followups") {
      const b = await readBody(req);
      const m = messages.find((x) => x.id === b.message_id);
      followups = followups.filter((f) => f.message_id !== b.message_id);
      followups.push({ message_id: b.message_id, account_id: "a1", thread_key: m.thread_key, kind: b.kind, due: b.due, state: "waiting" });
      followups.sort((a, c) => a.due - c.due);
      if (b.kind === "flag") m.starred = 1;
      return json(res, { ok: true });
    }
    const fuDone = p.match(/^\/api\/followups\/([^/]+)\/complete$/);
    if (fuDone) {
      followups = followups.filter((f) => f.message_id !== fuDone[1]);
      return json(res, { ok: true });
    }
    if (await demoTransfer(req, res, p, url)) return;
    if (p === "/api/accounts") return json(res, { accounts });
    if (p === "/api/folders") return json(res, { folders });
    if (p === "/api/messages") {
      // Pinned conversations lead, as the Worker orders them.
      const rows = [...messages].sort((a, b) => b.pinned - a.pinned || b.date - a.date);
      return json(res, { messages: rows });
    }
    if (p === "/api/categories") {
      if (req.method === "POST") {
        const b = await readBody(req);
        const name = String(b.name || "").trim();
        if (categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
          return json(res, { error: `There is already a category called ${name}` }, 409);
        }
        categories.push({ id: Math.max(0, ...categories.map((c) => c.id)) + 1, name, color: categories.length % 10, position: categories.length });
        return json(res, { ok: true, categories: withCounts() }, 201);
      }
      return json(res, { categories: withCounts(), palette: 10 });
    }
    const cat = p.match(/^\/api\/categories\/(\d+)$/);
    if (cat) {
      const id = Number(cat[1]);
      if (req.method === "DELETE") {
        categories = categories.filter((c) => c.id !== id);
        for (const m of messages) m.cats = (m.cats || []).filter((c) => c !== id);
      } else {
        const b = await readBody(req);
        const c = categories.find((x) => x.id === id);
        if (b.name !== undefined) {
          if (categories.some((x) => x.id !== id && x.name.toLowerCase() === String(b.name).trim().toLowerCase())) {
            return json(res, { error: `There is already a category called ${String(b.name).trim()}` }, 409);
          }
          c.name = String(b.name).trim();
        }
        if (b.color !== undefined) c.color = Number(b.color);
      }
      return json(res, { ok: true, categories: withCounts() });
    }
    // Rules, kept in memory. Validation and the catalog are the Worker's own.
    if (p === "/api/rules" && req.method === "GET") return json(res, { rules: ruleRows(), catalog: ruleCatalog() });
    if (p === "/api/rules" && req.method === "POST") {
      const c = cleanRule(await readBody(req));
      if (c.error) return json(res, { error: c.error }, 400);
      rules.push({ id: Math.max(0, ...rules.map((r) => r.id)) + 1, enabled: true, n: 0, last_at: null, last_error: "", unreadable: false, ...c, stop: !!c.stop });
      return json(res, { ok: true, rules: ruleRows(), catalog: ruleCatalog() }, 201);
    }
    if (p === "/api/rules/order") {
      const b = await readBody(req);
      rules.sort((a, c) => b.ids.indexOf(a.id) - b.ids.indexOf(c.id));
      return json(res, { ok: true, rules: ruleRows(), catalog: ruleCatalog() });
    }
    if (p === "/api/rules/run") return json(res, { ok: true, scanned: 12, changed: 3, failed: 0, next: null });
    const ruleOne = p.match(/^\/api\/rules\/(\d+)$/);
    if (ruleOne) {
      const id = Number(ruleOne[1]);
      const b = await readBody(req);
      if (req.method === "DELETE") rules = rules.filter((r) => r.id !== id);
      else {
        const r = rules.find((x) => x.id === id);
        if (b.name === undefined) r.enabled = !!b.enabled;
        else {
          const c = cleanRule(b);
          if (c.error) return json(res, { error: c.error }, 400);
          Object.assign(r, c, { stop: !!c.stop, last_error: "" });
        }
      }
      return json(res, { ok: true, rules: ruleRows(), catalog: ruleCatalog() });
    }
    const msgCats = p.match(/^\/api\/messages\/([^/]+)\/categories$/);
    if (msgCats) {
      const b = await readBody(req);
      const m = messages.find((x) => x.id === msgCats[1]);
      m.cats = [...new Set([...(m.cats || []).filter((c) => !(b.remove || []).includes(c)), ...(b.add || [])])].sort((a, c) => a - c);
      return json(res, { ok: true, cats: m.cats, pinned: m.pinned });
    }
    const pin = p.match(/^\/api\/messages\/([^/]+)\/pin$/);
    if (pin) {
      const b = await readBody(req);
      const m = messages.find((x) => x.id === pin[1]);
      m.pinned = b.pinned ? 1 : 0;
      return json(res, { ok: true, pinned: m.pinned, n: 1 });
    }
    const detail = p.match(/^\/api\/messages\/([^/]+)$/);
    if (detail && bodies[detail[1]]) {
      const b = bodies[detail[1]];
      return json(res, { ...b, message: { ...b.message, ...messages.find((m) => m.id === detail[1]) } });
    }
    return json(res, { messages: [], folders: [], accounts: [] });
  }
  let file = p === "/" ? "/index.html" : p;
  file = normalize(file).replace(/^(\.\.[/\\])+/, "");
  try {
    const data = await readFile(join(root, file));
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(port, () => console.log(`demo on http://localhost:${port}`));
