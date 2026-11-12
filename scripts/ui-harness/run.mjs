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
  else if (p === "/api/messages") log.push({ method: "GET", path: p, query: Object.fromEntries(url.searchParams) });
  const wait = (ms) => new Promise((r) => setTimeout(r, Number(ms) || 0));

  if (p === "/api/accounts") return json({ accounts });
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

  await scenario("stale-selection", async () => {
    await fresh();
    const n = await ev(`enterSelmode(); const first = document.querySelector("#list [data-id]"); togglePick(first.closest(".wrap") || first); const before = picked.size; renderFolders(); document.querySelector('[data-folder="archive"]').click(); await wait(400); return { before, after: picked.size, selmode: document.body.classList.contains("selmode") };`);
    ok(n.before === 1 && n.after === 0 && !n.selmode, `changing folder ends the selection — ${JSON.stringify(n)}`);
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
