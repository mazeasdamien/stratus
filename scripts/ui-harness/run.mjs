/**
 * Drives the real page in headless Chrome against a fake API that records
 * what it is asked. The composer loses work in ways no unit test sees — a
 * draft that was never posted, a send that closed the wrong message — and
 * this is the only check that watches the page do it.
 *
 *   node scripts/ui-harness/run.mjs             every scenario
 *   node scripts/ui-harness/run.mjs late-send   one of them
 *
 * Not part of `npm run check`: it needs Chrome on the machine. Set CHROME to
 * its path if it is not where Windows, macOS or Linux usually put it.
 */
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VERSION = /CLIENT_VERSION = "([^"]+)"/.exec(await readFile(join(ROOT, "src/version.js"), "utf8"))[1];
const only = (process.argv[2] || "").split(",").filter(Boolean);
const CHROME = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => p && existsSync(p));
if (!CHROME) {
  console.log("ui: Chrome not found — set CHROME to its path");
  process.exit(1);
}

/* ── the fake API ── */
const now = Date.now();
const accounts = [{ id: "a1", email: "you@icloud.com", label: "You", provider: "icloud", status: "ok", aliases: [], unread: 0 }];
const folders = ["inbox", "archive", "sent", "drafts", "trash"].map((folder) => ({ folder, n: 3, unread: 0 }));
const mk = (id, from, subject, extra = {}) => ({
  id, account_id: "a1", mid: `<${id}@demo>`, pid: id, thread_key: `t-${id}`, folder: "inbox", from_name: from,
  from_email: `${from.toLowerCase()}@gmail.com`, to_line: "you@icloud.com", cc_line: "", bcc_line: "", subject, snippet: "…",
  date: now - 60000 * Number(id.slice(1)), unread: 0, starred: 0, n: 1, has_body: 1, ...extra,
});
const messages = [mk("m1", "Camille", "One"), mk("m2", "Lea", "Two"), mk("m3", "Zoe", "Three")];
const OUT = "11111111-2222-3333-4444-555555555555";
let log = [];
/** Per-run switches a scenario sets through /__reset: delays and failures. */
let knobs = {};

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const json = (data, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json", "X-Shell": VERSION });
    res.end(JSON.stringify(data));
  };
  if (p === "/__log") return json(log);
  if (p === "/__reset") {
    log = [];
    knobs = Object.fromEntries(url.searchParams);
    return json({});
  }
  // Switches a scenario flips in the middle of a run, without clearing the log.
  if (p === "/__set") {
    Object.assign(knobs, Object.fromEntries(url.searchParams));
    for (const [k, v] of Object.entries(knobs)) if (v === "") delete knobs[k];
    return json({});
  }
  // A dropped connection: the socket dies with no answer, which is what fetch
  // calls a TypeError. And a session the server no longer accepts.
  if (p.startsWith("/api/") && knobs.down) return void req.socket.destroy();
  if (p.startsWith("/api/") && knobs.unauth) return json({ error: "This device is not activated" }, 401);
  if (!p.startsWith("/api/")) {
    try {
      const file = p === "/" ? "/index.html" : p;
      const data = await readFile(join(ROOT, "public", file));
      res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
      return res.end(data);
    } catch {
      res.writeHead(404);
      return res.end("not found");
    }
  }
  let body = "";
  for await (const c of req) body += c;
  let parsed = null;
  try { parsed = body ? JSON.parse(body) : null; } catch { /* not json */ }
  if (req.method !== "GET") log.push({ method: req.method, path: p, body: parsed });
  else if (p === "/api/messages" || /^\/api\/messages\/\w+$/.test(p)) log.push({ method: "GET", path: p, query: Object.fromEntries(url.searchParams) });
  const wait = (ms) => new Promise((r) => setTimeout(r, Number(ms) || 0));

  // The address book the send checks compare against.
  if (p === "/api/contacts/suggest") return json({ contacts: [{ email: "alice@acme-corp.test", name: "Alice", n: 4 }] });
  // Signatures: with `sigs` on, two of them and an alias, so From can change.
  if (p === "/api/accounts") return json({ accounts: knobs.sigs ? [{ ...accounts[0], aliases: ["work@icloud.com"] }] : accounts });
  if (p === "/api/signatures") {
    return json(knobs.sigs
      ? {
          signatures: [
            { id: "s1", name: "Personal", html: "<b>Damien</b>", position: 0 },
            { id: "s2", name: "Work", html: 'Damien Mazeas<br>Studio <a href="https://studio.example">site</a>', position: 1 },
          ],
          use: { "you@icloud.com": { new_id: "s1", reply_id: "s1" }, "work@icloud.com": { new_id: "s2", reply_id: "s2" } },
        }
      : { signatures: [], use: {} });
  }
  if (p === "/api/folders") return json({ folders });
  if (p === "/api/messages") {
    if (url.searchParams.get("thread")) return json({ messages: [] });
    const here = url.searchParams.get("folder") || "inbox";
    return json({ messages: here === "inbox" && !url.searchParams.get("before") ? messages : [] });
  }
  const att = /^\/api\/messages\/(\w+)\/attachment\/(\d+)$/.exec(p);
  if (att) {
    await wait(knobs.attDelay);
    if (knobs.attFail === att[2]) return json({ error: "Apple returned nothing for that part" }, 502);
    res.writeHead(200, { "Content-Type": "application/pdf", "X-Shell": VERSION });
    return res.end("%PDF-fake");
  }
  if (p === "/api/messages/d1" || p === "/api/messages/d2") {
    const id = p.slice(-2);
    const files = id === "d1" ? [{ filename: "a.pdf", type: "application/pdf", size: 10, part: "2" }] : [];
    return json({ message: { ...mk("m9", "You", "A draft"), id, mid: `<${id}@x>`, folder: "drafts" }, account: accounts[0], invite: null, rsvp: "", body: { html: "<div>draft words</div>", attachments: files, blocked: 0 } });
  }
  const detail = /^\/api\/messages\/(m\d)$/.exec(p);
  if (detail && knobs.cid) {
    return json({
      message: messages.find((m) => m.id === detail[1]), account: accounts[0], invite: null, rsvp: "",
      body: { html: '<p>hi</p><img alt="logo" src="cid:logo%40shop">', attachments: [{ filename: "logo.png", type: "image/png", size: 9, part: "2", cid: "logo@shop" }], blocked: 0 },
    });
  }
  if (detail) {
    await wait(knobs.detailDelay);
    const files = detail[1] === "m2" ? [{ filename: "one.pdf", type: "application/pdf", size: 9, part: "2" }, { filename: "two.pdf", type: "application/pdf", size: 9, part: "3" }] : [];
    return json({
      message: messages.find((m) => m.id === detail[1]), account: accounts[0], invite: null, rsvp: "",
      body: { html: "<p>hello</p><blockquote>an older message, quoted</blockquote>", attachments: files, blocked: 0, replyTo: detail[1] === "m3" ? "Customer <customer@x.fr>" : "" },
    });
  }
  if (p === "/api/draft") return knobs.draftFail ? json({ error: "the server refused it" }, 500) : json({ ok: true, pid: `<draft${log.length}@x>`, filed: true });
  if (p === "/api/outbox") return json({ outbox: [{ id: OUT, account_id: "a1", at: now + 3600000, subject: "Scheduled one", to_line: "zoe@x.fr", tries: 0 }] });
  if (p === `/api/outbox/${OUT}/cancel`) return json({ ok: true, message: { account_id: "a1", to: "zoe@x.fr", subject: "Scheduled one", html: "<div>later</div>", text: "later" } });
  if (p === "/api/send") {
    await wait(knobs.sendDelay);
    return knobs.sendFail ? json({ error: "Apple refused it" }, 502) : json({ ok: true, filed: true }, 202);
  }
  if (p === "/api/assist") {
    await wait(knobs.assistDelay);
    return json({ text: "Corrected words." });
  }
  if (/\/move$/.test(p)) return json({ ok: true, from: "inbox" });
  if (p === "/api/thread") return json({ ok: true, n: 2, from: parsed?.from || "inbox", ids: ["0000000000000001", "0000000000000002"] });
  return json({ ok: true, messages: [], folders: [], accounts: [], contacts: [], snoozed: [], outbox: [], events: [], blocked: [], senders: [], text: "" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const APP = `http://127.0.0.1:${server.address().port}`;

/* ── Chrome, over the DevTools protocol ── */
const freePort = () => new Promise((r) => { const s = netServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); }); });
const dbg = await freePort();
const profile = join(tmpdir(), `dmzs-ui-harness-${Date.now()}`);
await mkdir(profile, { recursive: true });
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${dbg}`, `--user-data-dir=${profile}`, "--window-size=1280,800", "--no-first-run", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target = null;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json()).find((t) => t.type === "page"); } catch { /* not up yet */ }
}
if (!target) throw new Error("Chrome did not start");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  // "Leave site?" and the like: answered, or every later step waits on it.
  if (m.method === "Page.javascriptDialogOpening") cdp("Page.handleJavaScriptDialog", { accept: true });
};
const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
await cdp("Page.enable");
/** Runs page code; the page's own functions and variables are in scope. */
const ev = async (expression, ms = 30000) => {
  // A step that never answers is a failure with a name, not a hung run.
  const m = await Promise.race([
    cdp("Runtime.evaluate", { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true }),
    sleep(ms).then(() => { throw new Error("no answer from: " + expression.trim().slice(0, 100)); }),
  ]);
  if (m.error) throw new Error("CDP: " + JSON.stringify(m.error));
  if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text);
  return m.result?.result?.value;
};
/** A clean page: reloaded, storage emptied, the request log and switches reset. */
const fresh = async (switches = {}) => {
  const q = new URLSearchParams(switches).toString();
  await fetch(`${APP}/__reset?${q}`);
  await cdp("Page.navigate", { url: APP + "/" });
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    await sleep(150);
    ready = await ev("return typeof accounts !== 'undefined' && accounts.length > 0 && typeof messages !== 'undefined' && messages.length > 0", 3000).catch(() => false);
  }
  if (!ready) throw new Error("the page did not load");
  await ev(`
    window.wait = (ms) => new Promise((r) => setTimeout(r, ms));
    window.fill = (subject, body) => {
      for (const [sel, v] of [["#cTo", "zoe@x.fr"], ["#cSubj", subject]]) { $(sel).value = v; $(sel).dispatchEvent(new Event("input", { bubbles: true })); }
      $("#cBody").innerHTML = "<div>" + body + "</div>";
      $("#cBody").dispatchEvent(new Event("input", { bubbles: true }));
    };
    localStorage.clear();
  `);
  await fetch(`${APP}/__reset?${q}`);
};
const seen = async () => (await fetch(`${APP}/__log`)).json();
const posts = async (path) => (await seen()).filter((l) => l.method !== "GET" && l.path === path);
const drafts = () => posts("/api/draft");

let pass = 0, fail = 0;
const ok = (c, label) => { c ? pass++ : fail++; console.log(`${c ? "  ok  " : "  FAIL"}  ${label}`); };
const scenario = async (name, fn) => {
  if (only.length && !only.includes(name)) return;
  console.log(`\n── ${name}`);
  // A page that reloads under a scenario (the service worker taking over on
  // its first run) kills the evaluation; that is the harness, so try again.
  for (let attempt = 0; ; attempt++) {
    const before = [pass, fail];
    try { await fn(); return; } catch (e) {
      [pass, fail] = before;
      if (attempt < 2 && /navigated or closed|context was destroyed/i.test(String(e.message))) continue;
      fail++;
      console.log(`  FAIL  threw: ${String(e.message).slice(0, 300)}`);
      return;
    }
  }
};

try {
  await scenario("compose-over-draft", async () => {
    await fresh();
    const after = await ev(`$("#composeBtn").click(); await wait(150); fill("First draft", "words I wrote"); $("#composeBtn").click(); await wait(600); return { subj: $("#cSubj").value, composing: document.body.classList.contains("composing") };`);
    const d = await drafts();
    ok(d.some((x) => x.body?.subject === "First draft"), `the message being written is saved before the composer is reused — drafts posted: ${JSON.stringify(d.map((x) => x.body?.subject))}`);
    ok(after.composing && after.subj === "", "and the new composer is empty");
  });

  await scenario("edit-scheduled", async () => {
    await fresh();
    await ev(`$("#outboxList").innerHTML = '<button data-oedit="${OUT}">Edit</button>'; $("#outboxList").firstChild.click(); await wait(500); if ($("#cSubj").value !== "Scheduled one") throw new Error("composer did not open: " + $("#cSubj").value); closeSheets(); await wait(600);`);
    const d = await drafts();
    ok(d.some((x) => x.body?.subject === "Scheduled one"), `a scheduled message taken out for editing is kept when the composer closes — drafts posted: ${JSON.stringify(d.map((x) => x.body?.subject))}`);
  });

  await scenario("attach-then-close", async () => {
    await fresh();
    await ev(`openCompose({ to: "zoe@x.fr", subject: "Resumed", html: "<div>hi</div>", pid: "<p1@x>" }); await wait(150); await addFiles([new File(["x"], "a.txt", { type: "text/plain" })]); closeSheets(); await wait(600);`);
    const d = await drafts();
    ok(d.some((x) => x.body?.subject === "Resumed" && x.body?.attachments?.length === 1 && x.body?.replaces === "<p1@x>"), `a file attached to a saved draft is saved with it — ${JSON.stringify(d.map((x) => [x.body?.subject, x.body?.attachments?.length]))}`);
  });

  await scenario("draft-with-files", async () => {
    await fresh();
    await ev(`await resumeDraft("d1"); await wait(200); fill("A draft, edited", "typo fixed"); closeSheets(); await wait(600);`);
    const d = await drafts();
    ok(d.length === 1 && d[0].body?.replaces === undefined, `editing a draft whose files are not in the composer does not replace it — replaces: ${JSON.stringify(d.map((x) => x.body?.replaces))}`);
    await fresh();
    await ev(`await resumeDraft("d2"); await wait(200); fill("A draft, edited", "typo fixed"); closeSheets(); await wait(600);`);
    const d2 = await drafts();
    ok(d2.length === 1 && d2[0].body?.replaces === "<d2@x>", `a draft without files is still replaced by its next save — replaces: ${JSON.stringify(d2.map((x) => x.body?.replaces))}`);
  });

  await scenario("local-copies", async () => {
    // A draft the server refused lives only in this browser. Writing another
    // message must not take its place.
    await fresh({ draftFail: 1 });
    const s = await ev(`
      openCompose(); await wait(150); fill("Refused by the server", "only copy"); await wait(900);
      closeSheets(); await wait(500);
      openCompose(); await wait(150); fill("Another message", "typed after"); await wait(900);
      const mid = keptDraft()?.subject;
      $("#cTo").value = ""; $("#cSubj").value = ""; $("#cBody").innerHTML = ""; closeSheets(); await wait(400);
      const kept = keptDraft();
      return { mid, after: kept?.subject, why: kept?.why || "" };`);
    ok(s.mid === "Refused by the server" && s.after === "Refused by the server", `a draft held only in this browser survives another message being written and closed — ${JSON.stringify(s)}`);
    ok(/refused/.test(s.why), "and still says why it was not saved");
    const r = await ev(`resumeKept(keptDraft()); await wait(200); const subj = $("#cSubj").value; const slots = Object.keys(localStorage).filter((k) => k.startsWith("dmzs-draft")).length; return { subj, slots };`);
    ok(r.subj === "Refused by the server" && r.slots === 1, `resuming it moves it to the composer's own slot — ${JSON.stringify(r)}`);
    await fresh();
    const big = await ev(`
      openCompose(); await wait(150);
      const px = "data:image/png;base64," + "A".repeat(6 * 1024 * 1024);
      fill("With a photo", 'words to keep<img alt="p" src="' + px + '">'); await wait(1200);
      const kept = JSON.parse(localStorage.getItem(draftSlot()) || "null");
      return { has: !!kept, words: /words to keep/.test(kept?.html || ""), size: (kept?.html || "").length };`);
    ok(big.has && big.words && big.size < 100000, `a message too large to keep locally is kept without its pictures — ${JSON.stringify(big)}`);
  });

  await scenario("block-prefill", async () => {
    await fresh();
    const v = await ev(`await openMsg("m1", messages[0]); await wait(400); $("#sdBlock").click(); await wait(200); const v = $("#modalInput").value; closeModal(null); return v;`);
    ok(v === "camille@gmail.com", `Block and delete offers the sender's address, not the whole domain — offered: ${v}`);
  });

  await scenario("french", async () => {
    // The language is per device and applies on a load: chosen, then the page
    // is loaded again. Everything below is read off the page as a person sees it.
    const load = async () => {
      await cdp("Page.navigate", { url: APP + "/" });
      for (let i = 0; i < 40; i++) {
        await sleep(150);
        if (await ev("window.wait = (ms) => new Promise((r) => setTimeout(r, ms)); return typeof accounts !== 'undefined' && accounts.length > 0 && messages.length > 0", 3000).catch(() => false)) return;
      }
      throw new Error("the page did not load");
    };
    const read = () => ev(`
      const text = (s) => ($(s)?.textContent || "").replace(/\\s+/g, " ").trim();
      const tabs = ["Mail", "Timeline", "People", "Tasks"].map((n) => text("#tab" + n));
      $("#acctBtn").click(); await wait(200);
      const settings = [...document.querySelectorAll("#setNav .pill")].map((b) => b.textContent.trim());
      const heading = text("#acctSheet .sh-t");
      closeSheets(); await wait(300);
      openCompose(); await wait(150);
      const composer = { send: text("#cSend"), discard: $("#cDiscard").getAttribute("aria-label") };
      closeSheets(); await wait(400);
      await openMsg("m1", messages[0]); await wait(300);
      $("#rArchive").click(); await wait(300);
      const toastText = text("#toast");
      await openMsg("m2", messages[1]); await wait(300);
      $("#sdBlock").click(); await wait(200);
      const dialog = text("#modalTitle");
      closeModal(null);
      return { lang: document.documentElement.lang, tabs, settings, heading, composer, toastText, dialog, date: fmtWhen(Date.UTC(2024, 2, 3, 12)), number: (1234.5).toLocaleString(LOCALE) };`);
    await fresh();
    const en = await read();
    ok(en.lang === "en" && en.tabs.join() === "Mail,Calendar,People,Tasks" && en.composer.send === "Send" && /Archived/.test(en.toastText), `English by default — ${JSON.stringify(en)}`);
    await ev(`localStorage.setItem("dmzs-lang", "fr");`);
    await load();
    const fr = await read();
    ok(fr.lang === "fr", `<html lang> follows the choice — ${fr.lang}`);
    ok(fr.tabs.join() === "Mail,Calendrier,Contacts,Tâches", `the view tabs are in French — ${fr.tabs}`);
    ok(fr.heading === "Réglages" && fr.settings.includes("Apparence") && fr.settings.includes("Confidentialité"), `the settings headings are in French — ${fr.heading}, ${fr.settings}`);
    ok(fr.composer.send === "Envoyer" && /brouillon/i.test(fr.composer.discard), `the composer's buttons are in French — ${JSON.stringify(fr.composer)}`);
    ok(/^Archiv/.test(fr.toastText), `a toast after archiving is in French — ${fr.toastText}`);
    ok(/bloquer/i.test(fr.dialog), `a dialog is in French — ${fr.dialog}`);
    ok(/mars/.test(fr.date) && /1\s?234,5/.test(fr.number), `a date and a number are formatted for French — ${fr.date}, ${fr.number}`);
    // Back to English through the same chips a person uses.
    await ev(`$("#acctBtn").click(); await wait(100); $('#langPick [data-lang="en"]').click();`).catch(() => {});
    await sleep(400);
    await load();
    const back = await read();
    ok(back.lang === "en" && back.tabs.join() === "Mail,Calendar,People,Tasks" && back.composer.send === "Send", `switching back restores English — ${JSON.stringify(back.tabs)}`);
  });

  await scenario("late-send", async () => {
    await fresh({ sendDelay: 1500 });
    const s = await ev(`
      openCompose(); await wait(150); fill("Message A", "a");
      const sending = postSend(outgoing());
      await wait(150); closeSheets(); await wait(100);
      openCompose(); await wait(150); fill("Message B", "b");
      await sending; await wait(400);
      return { composing: document.body.classList.contains("composing"), subj: $("#cSubj").value, clean: draftClean };`);
    ok(s.composing && s.subj === "Message B", `a send that finishes late leaves the message now being written open — ${JSON.stringify(s)}`);
    ok(s.clean === false, "and still marked as unsaved, so closing keeps it");
  });

  await scenario("send-survives-navigation", async () => {
    // Pressing Send and then opening the next message used to cancel the send.
    await fresh();
    const s = await ev(`
      openCompose(); await wait(150); fill("Goes anyway", "body");
      $("#cSend").click(); await wait(300);
      await openMsg("m2", messages[1]); await wait(300);
      const pendingAfterOpen = !!pendingSend;
      pendingSend && pendingSend.fire(); await wait(600);
      return { pendingAfterOpen, composing: document.body.classList.contains("composing") };`);
    const sent = await posts("/api/send");
    ok(s.pendingAfterOpen && sent.length === 1 && sent[0].body?.subject === "Goes anyway", `opening another message does not take a send back — ${JSON.stringify(s)}, sent ${sent.length}`);
    ok((await drafts()).length === 0, "and the message that went is not also saved as a draft");
    // Undo after the composer was closed puts the message back in front.
    await fresh();
    const u = await ev(`
      openCompose(); await wait(150); fill("Taken back", "body");
      $("#cSend").click(); await wait(200); closeSheets(); await wait(200);
      cancelPendingSend(); await wait(300);
      return { composing: document.body.classList.contains("composing"), subj: $("#cSubj").value };`);
    ok(u.composing && u.subj === "Taken back" && (await posts("/api/send")).length === 0, `Undo after closing brings the message back and sends nothing — ${JSON.stringify(u)}`);
    // A send that fails after the composer moved on is filed in Drafts.
    await fresh({ sendFail: 1 });
    await ev(`
      openCompose(); await wait(150); fill("Refused by Apple", "body");
      $("#cSend").click(); await wait(200);
      openCompose(); await wait(150); fill("The next one", "body");
      pendingSend && pendingSend.fire(); await wait(900);`);
    const d = await drafts();
    ok(d.some((x) => x.body?.subject === "Refused by Apple"), `a message that failed to send after the composer moved on is filed in Drafts — ${JSON.stringify(d.map((x) => x.body?.subject))}`);
    // A hidden page sends at once instead of waiting to be frozen.
    await fresh();
    await ev(`
      openCompose(); await wait(150); fill("Sent on leaving", "body");
      $("#cSend").click(); await wait(200);
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange")); await wait(600);`);
    ok((await posts("/api/send")).length === 1, "a page that is hidden sends at once");
  });

  await scenario("forward-waits-for-files", async () => {
    await fresh({ attDelay: 700, attFail: 1 });
    const s = await ev(`
      await openMsg("m2", messages[1]); await wait(400);
      $("#rForward").click(); await wait(250);
      $("#cTo").value = "zoe@x.fr"; $("#cTo").dispatchEvent(new Event("input", { bubbles: true }));
      $("#cSend").click(); await wait(150);
      const early = { pending: !!pendingSend, toast: $("#toast").textContent };
      await wait(2200);
      return { early, files: attached.map((a) => a.filename), toast: $("#toast").textContent };`);
    ok(!s.early.pending && /still loading/.test(s.early.toast), `Send waits while a forward's files are loading — ${JSON.stringify(s.early)}`);
    ok(s.files.length === 1 && /two\.pdf/.test(s.toast), `and a file that could not be fetched is named — files ${JSON.stringify(s.files)}, toast: ${s.toast}`);
  });

  await scenario("assistant", async () => {
    // Fix with nothing selected rewrites what you wrote, not what you quoted.
    await fresh();
    const s = await ev(`
      openCompose({ to: "zoe@x.fr", subject: "Re: x", html: '<div>my wrods</div><blockquote>THE ORIGINAL, <b>as sent</b></blockquote>' }); await wait(150);
      await assist("grammar", $("#aiFix")); await wait(200);
      return { html: $("#cBody").innerHTML, clean: draftClean };`);
    const sentText = (await posts("/api/assist"))[0]?.body?.text || "";
    ok(!/ORIGINAL/.test(sentText) && /my wrods/.test(sentText), `only your own words go to the assistant — sent: ${JSON.stringify(sentText)}`);
    ok(/Corrected words\./.test(s.html) && /<blockquote>THE ORIGINAL, <b>as sent<\/b><\/blockquote>/.test(s.html), "and the quoted message comes back untouched");
    // An answer that arrives after the composer moved on is not written in.
    await fresh({ assistDelay: 800 });
    const late = await ev(`
      openCompose({ to: "zoe@x.fr", subject: "A", html: "<div>first message</div>" }); await wait(150);
      const asked = assist("grammar", $("#aiFix")); await wait(150);
      openCompose({ to: "zoe@x.fr", subject: "B", html: "<div>second message</div>" }); await wait(150);
      await asked; await wait(200);
      return $("#cBody").innerText;`);
    ok(/second message/.test(late) && !/Corrected/.test(late), `a late answer does not overwrite the next message — ${JSON.stringify(late.slice(0, 80))}`);
  });

  await scenario("list-and-conversations", async () => {
    const threadPosts = async () => (await posts("/api/thread")).map((l) => l.body);
    // "Load older" starts after the last row by date and id.
    await fresh();
    await ev(`messages._more = true; await loadList(true); await wait(200);`);
    const page = (await seen()).filter((l) => l.method === "GET" && l.path === "/api/messages" && l.query.before).pop();
    ok(page && page.query.before_id === "m3" && Number(page.query.before) > 0, `the next page is asked for by date and id — ${JSON.stringify(page?.query)}`);
    // Undo of a conversation move names the messages that moved.
    await fresh();
    await ev(`await fileThread("t-m1", "inbox", "archive", "Archived"); await wait(100); lastUndo(); await wait(400);`);
    const moves = await threadPosts();
    ok(moves.length === 2 && moves[1].from === "archive" && moves[1].folder === "inbox" && Array.isArray(moves[1].ids) && moves[1].ids.length === 2, `Undo puts back exactly what moved — ${JSON.stringify(moves[1])}`);
    // Stepping to a conversation with the keyboard and filing it files all of it.
    await fresh();
    await ev(`messages[1].n = 3; renderList(); await openMsg("m1", messages[0]); await wait(400); step(1); await wait(500); document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true })); await wait(400);`);
    const stepped = await threadPosts();
    ok(stepped.length === 1 && stepped[0].key === "t-m2", `j then e files the whole conversation — ${JSON.stringify(stepped)}`);
    // So does a bulk action on a row that stands for one.
    await fresh();
    await ev(`messages[0].n = 3; renderList(); enterSelmode(); for (const el of [...document.querySelectorAll("#list [data-id]")].slice(0, 2)) togglePick(el.closest(".wrap") || el); bulkApply("archive", "Archived"); await wait(500);`);
    const bulk = await threadPosts();
    const single = (await seen()).filter((l) => l.method === "POST" && l.path.endsWith("/move")).map((l) => l.path);
    ok(bulk.length === 1 && bulk[0].key === "t-m1" && single.length === 1 && single[0].includes("/m2/"), `a bulk action files a picked conversation whole and a single message alone — thread ${JSON.stringify(bulk.map((b) => b.key))}, single ${JSON.stringify(single)}`);
    // Reply goes to Reply-To when the sender set one.
    await fresh();
    const to = await ev(`await openMsg("m3", messages[2]); await wait(400); $("#rReply").click(); await wait(300); return addrGet("#cTo", "#cToChips");`);
    ok(to === "customer@x.fr", `a reply goes to the Reply-To address — to: ${to}`);
  });

  await scenario("inline-picture", async () => {
    await fresh({ cid: 1 });
    const html = await ev(`await openMsg("m1", messages[0]); await wait(900); return await resolveInlineImages(current.body.html, "m1", current.body.attachments);`);
    ok(/src="data:/.test(html) && !/cid:/.test(html), `a picture whose cid is written with an escape is put in — ${html.slice(0, 90)}`);
  });

  await scenario("key-repeat", async () => {
    await fresh();
    const filed = (l) => l.method === "POST" && (l.path.endsWith("/move") || l.path === "/api/thread");
    await ev(`await openMsg("m1", messages[0]); await wait(400); document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "e", repeat: true, bubbles: true })); await wait(300);`);
    ok((await seen()).filter(filed).length === 0, "a held key does not file a message");
    await ev(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true })); await wait(400);`);
    ok((await seen()).filter(filed).length === 1, "a single press still does");
  });

  await scenario("toast-clears-bar", async () => {
    await fresh();
    const r = await ev(`await openMsg("m1", messages[0]); await wait(500); toast("Deleted", () => {}); await wait(450);
      const t = $("#toast").getBoundingClientRect(), b = $("#reader .rbar").getBoundingClientRect();
      const under = innerWidth / 2 >= b.left && innerWidth / 2 <= b.right;
      return { under, toastBottom: Math.round(t.bottom), barTop: Math.round(b.top) };`);
    ok(r.under && r.toastBottom <= r.barTop, `the Undo toast sits above the reader's action bar — ${JSON.stringify(r)}`);
    const s = await ev(`closeReader(); $("#reader").classList.remove("up"); toast("Archived"); await wait(450); return $("#toast").style.bottom;`);
    ok(s === "", `with no bar under it the toast goes back to its usual spot — bottom: "${s}"`);
  });

  await scenario("signature-follows-from", async () => {
    await fresh({ sigs: 1 });
    const sigId = `($("#cBody").querySelector(".sig") || {}).dataset?.sig || null`;
    const s = await ev(`
      openCompose(); await wait(150);
      const first = ${sigId};
      document.querySelector('[data-cfrom="work@icloud.com"]').click(); await wait(100);
      const swapped = ${sigId};
      document.querySelector('[data-cacc="a1"]').click(); await wait(100);
      const back = ${sigId};
      return { first, swapped, back, picker: $("#cSigPick").value };`);
    ok(s.first === "s1" && s.swapped === "s2" && s.back === "s1", `changing From swaps a signature nobody touched — ${JSON.stringify(s)}`);
    // Edited in this draft: never replaced.
    const e = await ev(`
      openCompose(); await wait(150);
      $("#cBody").querySelector(".sig").append(" — typed by hand");
      document.querySelector('[data-cfrom="work@icloud.com"]').click(); await wait(100);
      return { sig: ${sigId}, text: $("#cBody").querySelector(".sig").textContent };`);
    ok(e.sig === "s1" && /typed by hand/.test(e.text), `a signature edited in the draft is left alone — ${JSON.stringify(e)}`);
    // Taken out by hand: not put back by a change of From.
    const gone = await ev(`
      openCompose(); await wait(150);
      $("#cBody").querySelector(".sig").remove();
      document.querySelector('[data-cfrom="work@icloud.com"]').click(); await wait(100);
      return ${sigId};`);
    ok(gone === null, "a signature the user deleted does not come back when From changes");
    // The picker: another one, or none, and the mail carries what it says, as text too.
    await ev(`
      openCompose(); await wait(150);
      $("#cTo").value = "zoe@x.fr"; $("#cSubj").value = "Hello";
      $("#cBody").insertAdjacentHTML("afterbegin", "<div>words</div>");
      $("#cSigPick").value = "s2"; $("#cSigPick").dispatchEvent(new Event("change", { bubbles: true })); await wait(150);
      document.querySelector('[data-cfrom="work@icloud.com"]').click(); await wait(50);
      document.querySelector('[data-cacc="a1"]').click(); await wait(50);
      $("#cSend").click(); await wait(200); pendingSend && pendingSend.fire(); await wait(500);`);
    const sent = (await posts("/api/send"))[0]?.body || {};
    ok(/Studio/.test(sent.html || "") && !/data-sig/.test(sent.html || ""), `a signature chosen by hand stays when From changes, and its bookkeeping does not leave — ${JSON.stringify(sent.html)}`);
    ok(/words\s+Damien Mazeas\nStudio site \(https:\/\/studio\.example\)$/.test(sent.text || ""), `the plain-text alternative carries a plain rendering — ${JSON.stringify(sent.text)}`);
  });

  await scenario("send-warnings", async () => {
    // Fills the composer with the given To and Cc; the body is a line of words.
    const open = `
      window.compose = async (to, cc, opts = {}) => {
        openCompose(opts); await wait(150);
        addrSet("#cTo", "#cToChips", to); if (cc) { addrSet("#cCc", "#cCcChips", cc); $("#cCcWrap").hidden = false; }
        $("#cSubj").value = "Hello"; $("#cBody").innerHTML = "<div>words</div>";
        await loadContacts();
      };
      window.state = () => ({ asking: $("#modal").open, title: $("#modalTitle").textContent, detail: $("#modalDetail").textContent, alt: !$("#modalAlt").hidden, held: !!pendingSend });`;
    // A look-alike stops the send until Send anyway.
    await fresh();
    let s = await ev(`${open}
      await compose("alice@acme-corp.tset"); $("#cSend").click(); await wait(300);
      return state();`);
    ok(s.asking && /alice@acme-corp\.tset/.test(s.detail) && /alice@acme-corp\.test/.test(s.detail) && !s.held && !s.alt, `a look-alike recipient is asked about, naming both addresses, and nothing is held — ${JSON.stringify(s)}`);
    ok((await posts("/api/send")).length === 0, "and nothing has been sent");
    s = await ev(`$("#modalCancel").click(); await wait(200); return { ...state(), composing: document.body.classList.contains("composing") };`);
    ok(!s.asking && !s.held && s.composing && (await posts("/api/send")).length === 0, `Go back leaves the message in the composer — ${JSON.stringify(s)}`);
    s = await ev(`$("#cSend").click(); await wait(300); $("#modalOk").click(); await wait(200); const held = !!pendingSend; pendingSend && pendingSend.fire(); await wait(500); return held;`);
    const sent = await posts("/api/send");
    ok(s && sent.length === 1 && sent[0].body.to === "alice@acme-corp.tset", `Send anyway starts the usual hold, and then the send — held ${s}, sent ${sent.length}`);

    // Five outside addresses: Move them to Bcc.
    await fresh();
    const five = "a@one.test, b@two.test, c@three.test, d@four.test, e@five.test";
    s = await ev(`${open}
      await compose("a@one.test, b@two.test, c@three.test", "d@four.test, e@five.test"); $("#cSend").click(); await wait(300);
      return state();`);
    ok(s.asking && s.alt && !s.held && /5 people/.test(s.detail), `five outside addresses across domains are asked about, with Move them to Bcc offered — ${JSON.stringify(s)}`);
    await ev(`$("#modalAlt").click(); await wait(200); pendingSend && pendingSend.fire(); await wait(500);`);
    const moved = (await posts("/api/send"))[0]?.body || {};
    const sets = (x) => (x || "").split(",").map((v) => v.trim()).filter(Boolean).sort();
    ok(JSON.stringify(sets(moved.bcc)) === JSON.stringify(sets(five)) && !/one\.test|two\.test|three\.test|four\.test|five\.test/.test(`${moved.to} ${moved.cc || ""}`), `Move to Bcc sends with all five in Bcc and none in To or Cc — to ${moved.to}, cc ${moved.cc}, bcc ${moved.bcc}`);

    // Scheduled: asked at scheduling.
    await fresh();
    s = await ev(`${open}
      await compose("alice@acme-corp.tset"); const at = Date.now() + 2 * 3600000;
      const p = scheduleAt(at); await wait(300); const mid = state(); $("#modalOk").click(); await p; await wait(300);
      return mid;`);
    const later = (await posts("/api/send"))[0]?.body || {};
    ok(s.asking && later.at > Date.now(), `a scheduled send asks at the moment it is scheduled — ${JSON.stringify(s)}, at ${later.at}`);
    await fresh();
    s = await ev(`${open}
      await compose("alice@acme-corp.tset"); const p = scheduleAt(Date.now() + 2 * 3600000); await wait(300); $("#modalCancel").click(); await p; await wait(200);
      return state();`);
    ok(!s.asking && (await posts("/api/send")).length === 0, "and Go back schedules nothing");

    // A reply-all to people who were all on the message is not asked about.
    await fresh();
    s = await ev(`${open}
      await compose(${JSON.stringify(five)}, "", { title: "Reply all", reply: "m1", to: ${JSON.stringify(five)} }); $("#cSend").click(); await wait(400);
      return state();`);
    ok(!s.asking && s.held, `a reply-all whose recipients were all already on the message goes straight to the hold — ${JSON.stringify(s)}`);
    // The same five, written fresh into a new message, are asked about.
    await fresh();
    s = await ev(`${open}
      await compose(${JSON.stringify(five)}); $("#cSend").click(); await wait(300);
      return state();`);
    ok(s.asking, "but the same five in a new message are");
  });

  await scenario("reaction", async () => {
    await fresh();
    // m3's sender asked for answers to go to a Reply-To address.
    const s = await ev(`
      await openMsg("m3", messages[2]); await wait(700);
      const offered = !$("#rReact").hidden;
      $("#rReact").click(); await wait(200);
      const picker = { up: $("#reactSheet").classList.contains("up"), faces: [...document.querySelectorAll("#reactRow [data-emoji]")].map((b) => b.dataset.emoji), to: $("#reactTo").textContent };
      document.querySelector('#reactRow [data-emoji="🎉"]').click(); await wait(300);
      const held = !!pendingSend;
      const early = (await (await fetch("/__log")).json()).filter((l) => l.path === "/api/send").length;
      pendingSend && pendingSend.fire(); await wait(500);
      return { offered, picker, held, early };`);
    ok(s.offered && s.picker.up && s.picker.faces.join("") === "👍❤️🎉😂😮😢" && /customer@x\.fr/.test(s.picker.to), `the reader offers six reactions and shows where one will go — ${JSON.stringify(s.picker)}`);
    const sent = await posts("/api/send");
    const b = sent[0]?.body || {};
    ok(s.held && s.early === 0 && sent.length === 1, `it waits in the undo hold and then goes through /api/send once — held ${s.held}, sent ${sent.length}`);
    ok(b.to === "customer@x.fr" && b.reply_to === "m3" && b.subject === "Re: Three" && /^🎉\n\n.*reaction/.test(b.text || "") && b.account_id === "a1", `a reply to the Reply-To address, threaded to the message, saying what it is — ${JSON.stringify({ to: b.to, reply_to: b.reply_to, subject: b.subject, text: b.text })}`);
    ok((await drafts()).length === 0, "and nothing is left in Drafts");
    // Undo takes it back without a composer.
    await fresh();
    const u = await ev(`
      await openMsg("m3", messages[2]); await wait(700);
      $("#rReact").click(); await wait(200);
      document.querySelector('#reactRow [data-emoji="👍"]').click(); await wait(200);
      cancelPendingSend(); await wait(200);
      return { held: !!pendingSend, composing: document.body.classList.contains("composing") };`);
    ok(!u.held && !u.composing && (await posts("/api/send")).length === 0, `Undo sends nothing and opens no composer — ${JSON.stringify(u)}`);
  });

  await scenario("reaction-warned", async () => {
    // Not offered on a message with a sender warning.
    await fresh();
    const w = await ev(`
      await openMsg("m1", messages[0]); await wait(700);
      const before = !$("#rReact").hidden;
      current.message.from_name = "PayPal"; await renderSenderWarning(current.message); await wait(100);
      return { before, warned: !$("#rWarn").hidden, after: !$("#rReact").hidden };`);
    ok(w.before && w.warned && !w.after, `a message carrying the warning gets no reaction button — ${JSON.stringify(w)}`);
  });

  await scenario("stale-selection", async () => {
    await fresh();
    const n = await ev(`enterSelmode(); const first = document.querySelector("#list [data-id]"); togglePick(first.closest(".wrap") || first); const before = picked.size; renderFolders(); document.querySelector('[data-folder="archive"]').click(); await wait(400); return { before, after: picked.size, selmode: document.body.classList.contains("selmode") };`);
    ok(n.before === 1 && n.after === 0 && !n.selmode, `changing folder ends the selection — ${JSON.stringify(n)}`);
  });
  /* ── offline mail ── */
  const setKnob = (q) => fetch(`${APP}/__set?${q}`);
  const dbNames = () => ev(`return (await indexedDB.databases()).map((d) => d.name);`);
  const flag = () => ev(`return localStorage.getItem("dmzs-offline");`);
  /** A clean page with Offline mail off (database deleted), or on with a list and one opened message kept. */
  const offlineFresh = async (on, switches = {}) => {
    await fresh(switches);
    await ev(`await offlineWipe();`);
    if (on) await ev(`setOfflineFlag(true); await refreshAll(); await openMsg("m1", messages[0]); await wait(400);`);
  };

  await scenario("offline-off", async () => {
    await offlineFresh(false);
    await ev(`await refreshAll(); await openMsg("m1", messages[0]); await wait(400); await openMsg("m2", messages[1]); await wait(400); await wait(2600);`);
    ok((await dbNames()).length === 0, `with the setting off, reading a list and two messages creates no database — ${JSON.stringify(await dbNames())}`);
    ok((await flag()) === null, "and the setting is not left on");
    // Offline with it off, the page fails exactly as before: nothing said, nothing shown.
    await setKnob("down=1");
    const r = await ev(`await loadList(); await wait(300); return { note: !$("#offListNote").hidden, toast: $("#toast").textContent };`);
    ok(!r.note && !/saved|connection/.test(r.toast), `and a lost connection shows no offline copy and says nothing new — ${JSON.stringify(r)}`);
    ok((await dbNames()).length === 0, "still no database");
  });

  await scenario("offline-copy", async () => {
    await offlineFresh(true);
    // Let the fill take what has not been opened.
    const kept = await ev(`for (let i = 0; i < 60 && !(await offlineStore.keys()).includes("msg:m3"); i++) await wait(150); return await offlineStore.keys();`);
    ok(["list:|inbox", "msg:m1", "msg:m2", "msg:m3", "meta:accounts", "meta:folders"].every((k) => kept.includes(k)), `the list, the opened message, the filled ones and what the list stands on are kept — ${JSON.stringify(kept)}`);
    // The connection drops, and the page is opened cold.
    await setKnob("down=1");
    await cdp("Page.navigate", { url: APP + "/" });
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await sleep(150);
      up = await ev("return typeof messages !== 'undefined' && messages.length > 0", 3000).catch(() => false);
    }
    ok(up, "a page opened with no connection still lists the mail");
    await ev(`window.wait = (ms) => new Promise((r) => setTimeout(r, ms));`);
    const l = await ev(`return { n: messages.length, rows: document.querySelectorAll("#list [data-id]").length, accounts: accounts.length, note: $("#offListNote").hidden ? "" : $("#offListNote").textContent };`);
    ok(l.n === 3 && l.rows === 3 && l.accounts === 1, `the list is painted from the copy — ${JSON.stringify(l)}`);
    ok(/Offline copy, saved \S+/.test(l.note), `and marked as an offline copy with when it was saved — "${l.note}"`);
    const m = await ev(`await openMsg("m2", messages[1]); await wait(300); return { subj: current.message.subject, html: current.body.html, note: $("#offReadNote").hidden ? "" : $("#offReadNote").textContent };`);
    ok(m.subj === "Two" && /hello/.test(m.html), `a message that was filled in the background opens offline — ${m.subj}`);
    ok(/Offline copy, saved \S+.*Attachments are not kept/.test(m.note), `and says it is a copy, and that attachments are not kept — "${m.note}"`);
    // A folder that was never opened has no copy, and says so.
    const gone = await ev(`await api("/api/messages?folder=archive&limit=51").catch(() => 0); await wait(200); return $("#toast").textContent;`);
    ok(/not saved on this device/.test(gone), `a folder with no copy says so — ${gone}`);
    // Back online the server answers, and the marks go.
    await setKnob("down=");
    const back = await ev(`await loadList(); await openMsg("m1", messages[0]); await wait(300); return { list: $("#offListNote").hidden, read: $("#offReadNote").hidden };`);
    ok(back.list && back.read, `online again, the notes are gone — ${JSON.stringify(back)}`);
  });

  await scenario("offline-fill", async () => {
    await fresh({ detailDelay: 600 });
    await ev(`await offlineWipe(); setOfflineFlag(true); offlineFillSoon(true);`);
    await fetch(`${APP}/__reset?detailDelay=600`);
    const details = async () => (await seen()).filter((l) => /^\/api\/messages\/\w+$/.test(l.path));
    let n = 0;
    for (let i = 0; i < 80 && n < 2; i++) { await sleep(100); n = (await details()).length; }
    ok(n >= 2, `the background fill asks for messages — ${n}`);
    await ev(`$("#offSwitch").click(); await wait(100);`);
    const at = (await details()).length;
    await sleep(2200);
    const after = await details();
    ok(after.length === at && at < 3, `switching the setting off stops it at once — ${at} requests when it went off, ${after.length} later`);
    ok(after.every((l) => l.query.peek === "1"), `and every message it asked for was asked for with peek=1 — ${JSON.stringify(after.map((l) => [l.path, l.query.peek]))}`);
    ok((await dbNames()).length === 0 && (await flag()) === null, "and nothing is left behind");
  });

  await scenario("offline-refused", async () => {
    await offlineFresh(true);
    await setKnob("down=1");
    const r = await ev(`
      await openMsg("m1", messages[0]); await wait(200);
      $("#rStar").click(); await wait(400);
      const star = Number(current.message.starred);
      const starToast = $("#toast").textContent;
      const filed = await fileMessage("m1", "archive"); await wait(100);
      const fileToast = $("#toast").textContent;
      openCompose(); await wait(150); fill("Written offline", "still mine"); await wait(1200);
      const draft = JSON.parse(localStorage.getItem(draftSlot()) || "null");
      return { star, starToast, filed, fileToast, still: messages.some((m) => m.id === "m1"), draft: draft && draft.subject, composing: document.body.classList.contains("composing") };`);
    ok(r.star === 0 && /needs a connection/.test(r.starToast), `a star offline changes nothing and says it needs a connection — ${JSON.stringify([r.star, r.starToast])}`);
    ok(r.filed === null && /needs a connection/.test(r.fileToast) && r.still, `so does filing a message — ${JSON.stringify([r.filed, r.fileToast, r.still])}`);
    ok(r.composing && r.draft === "Written offline", `a message can still be written, and is kept on this device — ${JSON.stringify([r.composing, r.draft])}`);
    ok((await seen()).filter((l) => l.method === "POST").length === 0, "and nothing reached the server");
  });

  await scenario("offline-401", async () => {
    await offlineFresh(true);
    ok((await dbNames()).includes("stratus-offline"), "there is a copy to lose");
    await setKnob("unauth=1");
    await ev(`await api("/api/folders").catch(() => {}); await wait(600);`);
    ok((await dbNames()).length === 0, `a 401 from the API leaves no database — ${JSON.stringify(await dbNames())}`);
    ok((await flag()) === null, "and turns the setting off");
    await setKnob("unauth=");
    await ev(`await refreshAll(); await wait(2200);`);
    ok((await dbNames()).length === 0, "and nothing brings it back");
  });

  await scenario("offline-switch-off", async () => {
    await offlineFresh(true);
    ok((await dbNames()).includes("stratus-offline"), "there is a copy to remove");
    await ev(`$("#offSwitch").click(); await wait(700);`);
    ok((await dbNames()).length === 0 && (await flag()) === null, `turning the setting off leaves no database — ${JSON.stringify(await dbNames())}`);
    // Back on, then the remove button.
    const on = await ev(`$("#offSwitch").click(); await wait(900); await openMsg("m1", messages[0]); await wait(400); return { on: $("#offSwitch").getAttribute("aria-checked"), persistNote: $("#offMsg").hidden ? "" : $("#offMsg").textContent };`);
    ok(on.on === "true" && (await dbNames()).includes("stratus-offline"), `switching it on again keeps a copy — ${JSON.stringify(on)}`);
    const held = await ev(`$("#acctBtn").click(); await wait(300); return $("#offState").textContent;`);
    ok(/holds \d+ message/.test(held), `Settings says how much it holds — ${held}`);
    await ev(`$("#offRemove").click(); await wait(700);`);
    ok((await dbNames()).length === 0 && (await flag()) === null, "the remove button leaves no database either");
    ok((await ev(`return $("#offSwitch").getAttribute("aria-checked");`)) === "false", "and the setting is off");
  });
} finally {
  ws.close();
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
    else chrome.kill();
  } catch { /* already gone */ }
  server.close();
  await sleep(300);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
console.log(`\n${fail ? "✗" : "✓"} ui : ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
