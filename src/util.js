/**
 * Small shared pieces: JSON responses, hashing, the body key, IMAP flag names, the host the Worker answers on.
 */

import { sanitizeHtml } from "./mime.js";

/**
 * This app's own hostname, for the sanitizer.
 *
 * A message is rendered against this app's address, so a URL in it naming
 * this host is a request to the app itself — with the session cookie, from
 * the print frame. Read at each entry point rather than threaded through
 * every caller of rowFromRaw: one deployment, one host.
 *
 * APP_URL says it when it is set. A fresh self-hosted deploy has none, so the
 * host a request arrived on stands in, and is kept in settings for the cron,
 * which syncs (and so defuses) with no request to read it from.
 */
export let ownHost = "";

let keptHost = "";

export const learnHost = (env, request) => {
  try {
    if (env.APP_URL) ownHost = new URL(env.APP_URL).hostname;
    else if (request) ownHost = new URL(request.url).hostname.toLowerCase();
  } catch {
    /* a malformed APP_URL leaves relative URLs still caught */
  }
};

/** After a fetch with no APP_URL: write the host down once per isolate. */
export const keepHost = (env, ctx) => {
  if (env.APP_URL || !ownHost || ownHost === keptHost || !env.DB) return;
  keptHost = ownHost;
  ctx.waitUntil(
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('app_host', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(ownHost)
      .run()
      .catch(() => (keptHost = "")) // no table before the first cron: try again next time
  );
};

/** Before a cron pass with no APP_URL: the host a request last arrived on. */
export async function recallHost(env) {
  if (env.APP_URL || ownHost || !env.DB) return;
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key='app_host'").first().catch(() => null);
  if (row?.value) ownHost = keptHost = String(row.value);
}

export const defuse = (html) => sanitizeHtml(html, { host: ownHost });

export const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

export const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });

export const SYNC_PER_RUN = 1;              // accounts refreshed per cron pass — there is one

export async function hashHex(s, len) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, len);
}

export const bodyKey = (id) => `body/${id}.json`;

/**
 * IMAP system flags, spelled once.
 *
 * Written inline as "\Seen" these are a trap: \S is not a JavaScript escape,
 * so the backslash vanishes and the string becomes "Seen" — a custom keyword
 * the server stores and ignores, rather than the system flag. It fails
 * silently and looks exactly like a sync bug from the outside.
 */
export const FLAG_SEEN = "\\Seen";

export const FLAG_FLAGGED = "\\Flagged";

/**
 * Attachments are served with the type the sender declared, which is the
 * sender's word and nothing more: an "image" that is really HTML, opened on
 * this origin, would run with the session. nosniff stops the browser guessing
 * past the declared type, and the sandbox policy means that even a page
 * served as a page gets no script and no origin. PDF is the exception —
 * Chrome will not draw a PDF inside a sandboxed document at all — and a PDF
 * cannot script this origin anyway.
 */
export const ATTACHMENT_HEADERS = (type) => ({
  "X-Content-Type-Options": "nosniff",
  ...(/^application\/pdf\b/i.test(String(type || "")) ? {} : { "Content-Security-Policy": "sandbox" }),
});

/**
 * Marks English the person will read. It returns the text untouched: the
 * Worker has no language of its own, and the device matches the sentence
 * against its dictionary (tw() in public/i18n.js). What the mark is for is
 * scripts/check-i18n.mjs, which lists every ui() text so the dictionary can be
 * held to having an entry for each, and refuses an `error:` that is not
 * marked. A sentence with a changing part is a template, ui(`Deleted ${n}`),
 * and the dictionary entry names the part: "Deleted {n}".
 */
export const ui = (text) => text;
