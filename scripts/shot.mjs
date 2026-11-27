/**
 * One look at the page: serves the demo server, drives headless Chrome over
 * CDP at a true device width, runs a script in the page, prints what it
 * returns and saves a PNG.
 *
 *   node scripts/shot.mjs <out.png> [width] [height] [light|dark] "<js; return a value>"
 *
 * A --window-size below about 518px is a wider page cropped, which hides
 * overflow; this emulates the device instead, with touch below 700px. Set PRE
 * to a script that runs first, before a reload, for state read at load
 * (PRE='localStorage.setItem("dmzs-lang","fr")'). Set CHROME if Chrome is not
 * where Windows, macOS or Linux usually put it. Not part of `npm run check`.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [out, w = "390", h = "800", theme = "light", js = "1"] = process.argv.slice(2);
const repo = fileURLToPath(new URL("..", import.meta.url));
const port = 8700 + Math.floor(Math.random() * 200);
const dport = port + 300;
const CHROME = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => p && existsSync(p));
if (!CHROME || !out) {
  console.log(CHROME ? "usage: node scripts/shot.mjs <out.png> [width] [height] [light|dark] \"<js>\"" : "shot: Chrome not found, set CHROME to its path");
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [join(repo, "scripts/demo-server.mjs"), String(port)], { stdio: "ignore" });
const profile = mkdtempSync(join(tmpdir(), "stratus-shot-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${profile}`,
  `--remote-debugging-port=${dport}`, "--window-size=1200,900", "about:blank",
], { stdio: "ignore" });

try {
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${dport}/json`)).json();
      target = list.find((t) => t.type === "page");
    } catch {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) pending.get(m.id)(m);
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      pending.set(++id, r);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const mobile = Number(w) < 700;
  await send("Emulation.setDeviceMetricsOverride", { width: Number(w), height: Number(h), deviceScaleFactor: 1, mobile });
  if (mobile) await send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  await send("Page.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  await sleep(2500);
  // PRE runs first and the page is then reloaded: for state that only takes
  // effect at load, such as the language.
  if (process.env.PRE) {
    await send("Runtime.evaluate", { expression: process.env.PRE });
    await send("Page.reload");
    await sleep(3000);
  }
  const res =await send("Runtime.evaluate", { expression: `(async()=>{${js}})()`, awaitPromise: true, returnByValue: true });
  console.log("eval:", JSON.stringify(res.result?.result?.value ?? res.result?.exceptionDetails?.exception?.description ?? null));
  await sleep(900);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(out, Buffer.from(shot.result.data, "base64"));
  ws.close();
} finally {
  chrome.kill();
  server.kill();
}
