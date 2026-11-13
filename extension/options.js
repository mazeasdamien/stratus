/**
 * Points the extension at one Stratus and trades the bootstrap key for a
 * session token, once.
 *
 * The key is never written to storage: it is the thing that activates any new
 * device, so an extension that kept a copy would be a second place to steal it
 * from. Only the token it returns is saved. That token can read the unread
 * count and nothing else, and "Sign out other devices" in the app ends it.
 */

import { currentApp, originOf, patternOf, syncContentScript } from "./app.js";

const $ = (id) => document.getElementById(id);

const say = (text, cls) => {
  $("msg").textContent = text;
  $("msg").className = cls || "";
};

/** After a change of address or access: script, old permission, badge. */
async function settle(before, app) {
  if (before && before !== app) {
    await chrome.permissions.remove({ origins: [patternOf(before)] }).catch(() => {});
  }
  await syncContentScript();
  chrome.runtime.sendMessage({ type: "poll" });
}

async function connect() {
  const APP = originOf($("app").value);
  if (!APP) return say("Enter your Stratus address, like https://stratus.you.workers.dev.", "bad");
  $("app").value = APP;
  const key = $("key").value.trim();

  // First, while the click still counts as one: Chrome only shows the
  // permission prompt in answer to a user gesture.
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [patternOf(APP)] });
  } catch {
    granted = false;
  }
  if (!granted) return say(`Chrome needs your permission to reach ${APP}.`, "bad");

  const { app: before = "", token } = await chrome.storage.local.get(["app", "token"]);

  // No key: allowed when only the access was missing, or when an install from
  // before the address was a setting already has a token.
  if (!key) {
    if (token && (!before || before === APP)) {
      await chrome.storage.local.set({ app: APP });
      await settle(before, APP);
      return say("Connected. The badge will update within a minute.", "ok");
    }
    return say("Enter the bootstrap key too.", "bad");
  }

  say("Connecting…");
  try {
    const res = await fetch(`${APP}/api/extension/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) return say(data.error || "That key was refused.", "bad");

    await chrome.storage.local.set({ app: APP, token: data.token, lastUnread: 0 });
    $("key").value = "";
    await settle(before, APP);
    say("Connected. The badge will update within a minute.", "ok");
  } catch {
    say(`Could not reach ${APP}.`, "bad");
  }
}

$("save").addEventListener("click", connect);
for (const id of ["app", "key"]) $(id).addEventListener("keydown", (e) => e.key === "Enter" && connect());

Promise.all([currentApp(), chrome.storage.local.get("token")]).then(([{ app, allowed }, { token }]) => {
  if (app) $("app").value = app;
  if (token && app && allowed) say(`Connected to ${app}. Paste a new key to replace it.`, "ok");
  else if (token && app) say(`Click Connect to let Chrome reach ${app} again. No key needed.`, "bad");
  else if (token) say("Enter your Stratus address and click Connect. No key needed.", "bad");
});
