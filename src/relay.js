/**
 * Sending as a domain iCloud does not know: Cloudflare Email Sending.
 *
 * iCloud's SMTP only lets an account send as its own addresses, so mail from
 * an address on one of your own domains (agentxr.app) was refused at Apple.
 * Those addresses leave through the `send_email` binding instead; everything
 * else — the copy filed in Sent, the account it belongs to — stays as it was.
 *
 * Which domains go this way is RELAY_DOMAINS in wrangler.jsonc, and only when
 * the EMAIL binding exists: no binding, no relay, nothing changes.
 */

import { importanceLines } from "./importance.js";

/** The domains that leave through Cloudflare, lowercased. */
export function relayDomains(env) {
  return String(env?.RELAY_DOMAINS || "")
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

/** Whether mail from this address goes out through Cloudflare. */
export function isRelayed(env, address) {
  if (!env?.EMAIL || typeof env.EMAIL.send !== "function") return false;
  const domain = String(address || "").trim().toLowerCase().split("@")[1] || "";
  return !!domain && relayDomains(env).includes(domain);
}

/**
 * The structured message for env.EMAIL.send().
 *
 * Structured rather than raw MIME: Cloudflare sets Date and Message-ID itself
 * and rejects a request that tries to, so handing it the bytes iCloud would
 * have sent is not an option. Bcc is its own field here and never a header,
 * exactly as with SMTP.
 */
export function relayMessage({ fromName, from, to, cc, bcc, subject, text, html, attachments, inReplyTo, references, importance }) {
  const msg = {
    from: fromName && fromName.toLowerCase() !== from.toLowerCase() ? { email: from, name: fromName } : from,
    to,
    subject: subject || "",
  };
  if (cc?.length) msg.cc = cc;
  if (bcc?.length) msg.bcc = bcc;
  if (text) msg.text = text;
  if (html) msg.html = html;
  const files = (attachments || []).filter((a) => a && a.filename && a.data);
  if (files.length) {
    msg.attachments = files.map((a) => ({
      content: a.data,
      filename: a.filename,
      type: a.type || "application/octet-stream",
      disposition: "attachment",
    }));
  }
  // Threading. Both are on Cloudflare's allowlist; without them a reply sent
  // from here starts a new conversation at the other end.
  const headers = {};
  if (inReplyTo) headers["In-Reply-To"] = inReplyTo;
  // Only X-Priority: the allowlist takes any X- header, while Importance and
  // X-MSMail-Priority are not documented as on it, and a refused header would
  // refuse the send.
  const xp = importanceLines(importance).find((l) => l.startsWith("X-Priority: "));
  if (xp) headers["X-Priority"] = xp.slice(12);
  const chain = (references || []).join(" ");
  if (chain) headers.References = chain.slice(0, 2000);
  if (Object.keys(headers).length) msg.headers = headers;
  return msg;
}

/**
 * Sends it, and returns the Message-ID Cloudflare gave the message in the
 * angle-bracket form a header uses, or "" when it gave none that looks like one.
 */
export async function relaySend(env, message) {
  let res;
  try {
    res = await env.EMAIL.send(message);
  } catch (e) {
    const code = e?.code ? ` (${e.code})` : "";
    throw new Error(`Cloudflare Email Sending refused it${code}: ${String(e?.message || e).slice(0, 200)}`);
  }
  const id = String(res?.messageId || "").trim().replace(/^<|>$/g, "");
  return id.includes("@") ? `<${id}>` : "";
}
