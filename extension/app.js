/**
 * Which Stratus this extension talks to.
 *
 * Every deployment has its own address (https://stratus.<you>.workers.dev, or
 * a custom domain), so it is typed once on the options page and kept in
 * storage. Chrome only lets the extension reach it once you have granted that
 * one origin: the manifest asks for nothing up front, and the content script
 * that relays the app's "something changed" is registered for that origin
 * alone.
 */

const SCRIPT_ID = "app";

/**
 * Whatever was typed → an origin, or null.
 * "stratus.you.workers.dev", "https://mail.example.com/inbox" → the https
 * origin. Plain http only for a local copy (`npm run dev`).
 */
export function originOf(input) {
  let s = String(input || "").trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
    if (!u.hostname.includes(".") && !local) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** The match pattern for one origin, as permissions and scripting want it. */
export const patternOf = (app) => `${app}/*`;

/** The stored address, and whether Chrome currently lets us reach it. */
export async function currentApp() {
  const { app = "" } = await chrome.storage.local.get("app");
  const allowed = app ? await chrome.permissions.contains({ origins: [patternOf(app)] }) : false;
  return { app, allowed };
}

/**
 * The content script follows the address: registered for it while access is
 * granted, and for nothing otherwise. Registrations persist across restarts,
 * so this only changes something when the address or the permission did.
 */
export async function syncContentScript() {
  const { app, allowed } = await currentApp();
  const want = allowed ? patternOf(app) : null;
  const [have] = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (have && have.matches?.[0] === want) return;
  if (have) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  if (want) {
    await chrome.scripting.registerContentScripts([
      { id: SCRIPT_ID, matches: [want], js: ["content.js"], runAt: "document_idle" },
    ]);
  }
}
