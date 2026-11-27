/**
 * Demo-only: import and export routes for scripts/demo-server.mjs. Invented
 * mail, nothing stored, and a pause on each import so progress can be shot.
 * Not the real routes (src/transfer.js).
 */

import { CLIENT_VERSION } from "../src/version.js";

const seen = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (res, data, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json", "X-Shell": CLIENT_VERSION });
  res.end(JSON.stringify(data));
};

const DAY = 86_400_000;
const ids = Array.from({ length: 14 }, (_, i) => ({
  id: `e${String(i).padStart(15, "0")}`,
  date: Date.UTC(2026, 0, 1) + i * DAY,
  unread: i % 4 === 0 ? 1 : 0,
  starred: i % 5 === 0 ? 1 : 0,
}));

export async function demoTransfer(req, res, p, url) {
  if (p === "/api/transfer/import" && req.method === "POST") {
    const probe = url.searchParams.get("probe");
    if (probe) return send(res, { ok: true, duplicate: seen.has(probe) }), true;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("latin1");
    await sleep(Number(process.env.DEMO_IMPORT_MS) || 350);
    if (raw.includes("FAILME")) return send(res, { ok: false, error: "No mailbox matching \"Imported\". Server has: INBOX", reason: "failed" }, 502), true;
    const mid = /^message-id:[ \t]*(\S.*?)\r?$/im.exec(raw)?.[1] || "";
    if (mid && seen.has(mid)) return send(res, { ok: true, duplicate: true }), true;
    if (mid) seen.add(mid);
    return send(res, { ok: true, duplicate: false, folder: url.searchParams.get("folder") }), true;
  }
  if (p === "/api/transfer/ids" && req.method === "GET") {
    const after = url.searchParams.get("after");
    const from = after ? ids.findIndex((i) => `${i.date}.${i.id}` === after) + 1 : 0;
    const page = ids.slice(from, from + 6);
    const more = from + 6 < ids.length;
    return send(res, { ids: page, next: more ? `${page[page.length - 1].date}.${page[page.length - 1].id}` : null, ...(after ? {} : { total: ids.length }) }), true;
  }
  const eml = p.match(/^\/api\/messages\/([^/]+)\/eml$/);
  if (eml) {
    await sleep(Number(process.env.DEMO_EML_MS) || 120);
    const n = ids.findIndex((i) => i.id === eml[1]);
    res.writeHead(200, { "Content-Type": "message/rfc822", "X-Shell": CLIENT_VERSION });
    res.end(`From: Camille Roux <camille@atelier-roux.example>\r\nTo: you@example.com\r\nSubject: Demo message ${n + 1}\r\nMessage-ID: <demo${n}@export.example>\r\nDate: Thu, 01 Jan 2026 09:00:00 +0000\r\n\r\nFrom the demo: line one.\r\nFrom here on, this line would look like a separator.\r\n`);
    return true;
  }
  return false;
}
