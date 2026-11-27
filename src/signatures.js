/**
 * Signatures: several, each formatted text, and a choice per sending address
 * of which one signs new mail and which one signs replies.
 *
 * Two tables (see schema.js). `signatures` holds the signatures themselves;
 * `signature_use` holds, per address, the id for new mail and the id for
 * replies, either of which may be NULL for "no signature". The address '*' is
 * what every address without a row of its own uses, which is where the single
 * signature from before this existed went (the signatures_default migration).
 *
 * What the page does with them is in public/index.html, under "signatures":
 * it follows the From address, and never replaces a signature that has been
 * edited in the draft.
 */

import { decodeEntities, sanitizeHtml } from "./mime.js";
import { json, ownHost, ui } from "./util.js";

const NAME_MAX = 60;
const HTML_MAX = 20_000;
const ANY = "*";

const TAGS = new Set(["b", "strong", "i", "em", "u", "s", "strike", "a", "br", "div", "p", "span", "font", "ul", "ol", "li", "sub", "sup"]);
const VOID = new Set(["br"]);
const escAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** One colour, in a form a stylesheet cannot make do anything else with. */
const COLOUR = /^(?:#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?(?:\s*,\s*[\d.]+%?){2,3}\s*\)|[a-z]{3,20})$/i;

/** Of an inline style, only what formatting needs: colour, bold, italic, underline. */
function keepStyle(style) {
  const out = [];
  for (const decl of decodeEntities(style).split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim().toLowerCase().replace(/\s*!important$/, "");
    if (prop === "color" && COLOUR.test(val)) out.push(`color:${val}`);
    else if (prop === "font-weight" && /^(?:bold|[6-9]00)$/.test(val)) out.push("font-weight:bold");
    else if (prop === "font-style" && val === "italic") out.push("font-style:italic");
    else if (prop === "text-decoration" && /^(?:underline|line-through)$/.test(val)) out.push(`text-decoration:${val}`);
  }
  return out.join(";");
}

/** The attributes a kept tag may carry, rebuilt from scratch. */
function keepAttrs(tag, raw) {
  const out = [];
  for (const m of raw.matchAll(/([a-zA-Z_:][-\w:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const name = m[1].toLowerCase();
    const val = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
    if (tag === "a" && name === "href") {
      // The URL parser drops spaces and control characters before it reads the scheme.
      const flat = val.replace(/[\x00-\x20]/g, "");
      if (/^(?:https?:|mailto:|tel:)/i.test(flat)) out.push(`href="${escAttr(flat)}" target="_blank" rel="noopener noreferrer"`);
    } else if (tag === "font" && name === "color" && COLOUR.test(val.trim())) {
      out.push(`color="${escAttr(val.trim())}"`);
    } else if (name === "style") {
      const s = keepStyle(val);
      if (s) out.push(`style="${escAttr(s)}"`);
    }
  }
  return out.length ? " " + out.join(" ") : "";
}

/**
 * A signature's markup, made safe.
 *
 * It goes through the sanitiser incoming mail goes through, and then through
 * an allowlist, because that sanitiser keeps what a reader of mail has to see
 * (pictures, whole stylesheets) and a signature is none of it. A remote image
 * is the one it exists to keep out: it tells whoever hosts it, every time the
 * message is opened, that it was. So there is no <img> at all, and no
 * data-blocked-src left behind to be switched back on. What remains is
 * emphasis, colour, links, line breaks and lists.
 */
export function cleanSignature(input) {
  let html = sanitizeHtml(String(input ?? "").slice(0, HTML_MAX), { host: ownHost }).html;
  html = html.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "").replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  html = html.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>?/g, (_m, close, name, rest) => {
    const tag = name.toLowerCase();
    if (!TAGS.has(tag)) return "";
    if (close) return VOID.has(tag) ? "" : `</${tag}>`;
    return `<${tag}${keepAttrs(tag, rest)}>`;
  });
  // A "<" that did not start a tag is text.
  return html.replace(/<(?!\/?[a-z])/gi, "&lt;").trim();
}

const shape = (r) => ({ id: r.id, name: r.name, html: r.html, position: r.position });

async function list(env) {
  const { results } = await env.DB.prepare("SELECT * FROM signatures ORDER BY position, created_at").all();
  const use = {};
  const rows = (await env.DB.prepare("SELECT * FROM signature_use").all()).results ?? [];
  for (const u of rows) use[u.address] = { new_id: u.new_id, reply_id: u.reply_id };
  return json({ signatures: (results ?? []).map(shape), use });
}

const nameOf = (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);

async function create(request, env) {
  const b = await request.json().catch(() => ({}));
  const name = nameOf(b.name);
  if (!name) return json({ error: ui("A signature needs a name") }, 400);
  const now = Date.now();
  const id = crypto.randomUUID();
  const { n } = (await env.DB.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM signatures").first()) ?? { n: 0 };
  await env.DB.prepare("INSERT INTO signatures (id, name, html, position, created_at, updated_at) VALUES (?,?,?,?,?,?)")
    .bind(id, name, cleanSignature(b.html), n, now, now)
    .run();
  const row = await env.DB.prepare("SELECT * FROM signatures WHERE id=?").bind(id).first();
  return json({ signature: shape(row) }, 201);
}

async function update(request, env, id) {
  const row = await env.DB.prepare("SELECT * FROM signatures WHERE id=?").bind(id).first();
  if (!row) return json({ error: ui("No such signature") }, 404);
  const b = await request.json().catch(() => ({}));
  const name = "name" in b ? nameOf(b.name) : row.name;
  if (!name) return json({ error: ui("A signature needs a name") }, 400);
  const html = "html" in b ? cleanSignature(b.html) : row.html;
  await env.DB.prepare("UPDATE signatures SET name=?, html=?, updated_at=? WHERE id=?").bind(name, html, Date.now(), id).run();
  return json({ signature: shape({ ...row, name, html }) });
}

async function remove(env, id) {
  const r = await env.DB.prepare("DELETE FROM signatures WHERE id=?").bind(id).run();
  if (!(r.meta?.changes ?? 0)) return json({ error: ui("No such signature") }, 404);
  // No address keeps pointing at one that is gone: it signs with nothing.
  await env.DB.prepare("UPDATE signature_use SET new_id=NULL WHERE new_id=?").bind(id).run();
  await env.DB.prepare("UPDATE signature_use SET reply_id=NULL WHERE reply_id=?").bind(id).run();
  return json({ ok: true });
}

/** POST { address, new_id?, reply_id? }: a key left out keeps what the address has. */
async function setUse(request, env) {
  const b = await request.json().catch(() => ({}));
  const address = String(b.address ?? "").trim().toLowerCase();
  if ((address !== ANY && !/^[^\s@]+@[^\s@]+$/.test(address)) || address.length > 254) {
    return json({ error: ui("That is not an address") }, 400);
  }
  const cur = (await env.DB.prepare("SELECT * FROM signature_use WHERE address=?").bind(address).first()) ?? { new_id: null, reply_id: null };
  const next = { new_id: cur.new_id, reply_id: cur.reply_id };
  for (const k of ["new_id", "reply_id"]) {
    if (!(k in b)) continue;
    if (b[k] === null || b[k] === "") { next[k] = null; continue; }
    const ok = await env.DB.prepare("SELECT 1 AS x FROM signatures WHERE id=?").bind(String(b[k])).first();
    if (!ok) return json({ error: ui("No such signature") }, 400);
    next[k] = String(b[k]);
  }
  await env.DB.prepare(
    "INSERT INTO signature_use (address, new_id, reply_id) VALUES (?,?,?) ON CONFLICT(address) DO UPDATE SET new_id=excluded.new_id, reply_id=excluded.reply_id"
  )
    .bind(address, next.new_id, next.reply_id)
    .run();
  return json({ ok: true, address, ...next });
}

async function api(request, env, path) {
  if (!path.startsWith("/api/signatures")) return null;
  const method = request.method;
  if (path === "/api/signatures") {
    if (method === "GET") return list(env);
    if (method === "POST") return create(request, env);
    return null;
  }
  if (path === "/api/signatures/use") return method === "POST" ? setUse(request, env) : null;
  const m = path.match(/^\/api\/signatures\/([^/]+)$/);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  if (method === "POST") return update(request, env, id);
  if (method === "DELETE") return remove(env, id);
  return null;
}

export const signaturesModule = {
  name: "signatures",
  api,
  tables: ["signatures", "signature_use"],
};
