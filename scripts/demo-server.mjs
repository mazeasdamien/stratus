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

// Fired reminders for the header button and its sheet. Dismiss and snooze
// take one off for the life of the process, as the real routes would.
let reminders = [
  { id: "r1", kind: "event", ref: "e1", title: "Design review", body: "Room 4, bring the mockups", at: now - 4 * 60000, fired_at: now - 3 * 60000 },
  { id: "r2", kind: "task", ref: "t1", title: "Send the invoice to Atelier Roux", body: "", at: now - 25 * 60000, fired_at: now - 24 * 60000 },
  { id: "r3", kind: "followup", ref: "m3", title: "Follow up: maquette home", body: "Léa has not replied since Monday. The v2 was waiting on her notes.", at: now - 2 * 3600000, fired_at: now - 2 * 3600000 },
];

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
  res.writeHead(status, { "Content-Type": "application/json", "X-Shell": "v40" });
  res.end(JSON.stringify(data));
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const p = url.pathname;
  if (p.startsWith("/api/")) {
    if (p === "/api/reminders") return json(res, { reminders, count: reminders.length });
    const rem = p.match(/^\/api\/reminders\/([^/]+)\/(?:dismiss|snooze)$/);
    if (rem) {
      reminders = reminders.filter((r) => r.id !== rem[1]);
      return json(res, { ok: true });
    }
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
