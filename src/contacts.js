/**
 * The address book: cards you keep, and the suggestions the composer offers.
 *
 *   GET    /api/contacts              every card
 *   POST   /api/contacts              a new card
 *   PUT    /api/contacts/:id          change a card
 *   DELETE /api/contacts/:id          remove a card
 *   GET    /api/contacts/suggest      addresses for the composer's autocomplete
 *   POST   /api/contacts/hide         { email }: never suggest this address
 *   POST   /api/contacts/import       a .vcf file as the request body
 *   GET    /api/contacts/export       every card as one .vcf
 *   GET    /api/contacts/:id/export   one card as a .vcf
 *
 * A module (src/modules.js): asked before the built-in routes, it owns
 * everything under /api/contacts. The table is in src/schema.js. Suggestions
 * are still read out of your sent mail, as they always were; a saved contact
 * simply ranks ahead of an address that was only ever seen there.
 */

import { parseAddressList } from "./mime.js";
import { cleanContact, hasContent, isEmail, parseVcard, writeCard, writeVcard } from "./vcard.js";
import { json } from "./util.js";

/** A file is somebody else's bytes: this many, and this many cards in them. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_CARDS = 2000;

/** Statements per D1 batch, and addresses per IN (...), under D1's 100 bound values. */
const BATCH = 50;
const IN_CHUNK = 90;

const SUGGESTIONS = 1000;

const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

/** A row as the API and the vCard writer see it. */
function fromRow(r) {
  const list = (s) => {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  return { ...r, emails: list(r.emails), phones: list(r.phones) };
}

const FIELDS = ["uid", "name", "given", "family", "org", "title", "emails", "phones", "address", "birthday", "notes"];

const cells = (c) => FIELDS.map((f) => (f === "emails" || f === "phones" ? JSON.stringify(c[f]) : c[f]));

const insertSql = (db, id, c, now) =>
  db
    .prepare(
      `INSERT INTO contacts (id, ${FIELDS.join(", ")}, created_at, updated_at) VALUES (?${", ?".repeat(FIELDS.length + 2)})`
    )
    .bind(id, ...cells(c), now, now);

const updateSql = (db, id, c, now) =>
  db
    .prepare(`UPDATE contacts SET ${FIELDS.map((f) => `${f}=?`).join(", ")}, updated_at=? WHERE id=?`)
    .bind(...cells(c), now, id);

/**
 * Addresses you chose to keep are no longer hidden. Adding is how a Remove from
 * the suggestions is undone, and suppression wins when suggestions are built,
 * so leaving the row would save a contact and hide it in the same breath.
 */
function unhide(db, emails) {
  const out = [];
  for (let i = 0; i < emails.length; i += IN_CHUNK) {
    const part = emails.slice(i, i + IN_CHUNK);
    out.push(db.prepare(`DELETE FROM contacts_hidden WHERE email IN (${part.map(() => "?").join(",")})`).bind(...part));
  }
  return out;
}

const emailsOf = (c) => c.emails.map((e) => e.value);

/** An editor's JSON as a contact, or the reason it is not one. */
function fromBody(b) {
  for (const key of ["emails", "phones"]) {
    if (b[key] !== undefined && !Array.isArray(b[key])) return { error: "Not a list" };
  }
  for (const e of b.emails || []) {
    const v = String((e && typeof e === "object" ? e.value : e) ?? "").trim();
    if (v && !isEmail(v)) return { error: `${v.slice(0, 80)} is not an email address` };
  }
  const c = cleanContact(b);
  if (!hasContent(c)) return { error: "Give this contact a name, an address or a number" };
  return { contact: c };
}

const download = (text, filename) =>
  new Response(text, {
    headers: {
      "Content-Type": "text/vcard; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });

const slug = (s) => String(s || "").normalize("NFD").replace(/[^\w -]/g, "").trim().replace(/\s+/g, "-").toLowerCase().slice(0, 40) || "contact";

async function allCards(env) {
  const { results } = await env.DB.prepare("SELECT * FROM contacts ORDER BY name COLLATE NOCASE, id").all();
  return (results ?? []).map(fromRow);
}

/**
 * Folds a card from a file into one already held: what the file says wins
 * where it says something, and the addresses and numbers of both are kept. So
 * importing a file twice changes nothing the second time, and importing a
 * different export of the same person adds to them rather than replacing them.
 */
function merge(have, card) {
  const out = { ...have };
  for (const f of ["name", "given", "family", "org", "title", "address", "birthday", "notes"]) {
    if (card[f]) out[f] = card[f];
  }
  for (const f of ["emails", "phones"]) {
    const known = new Set(have[f].map((x) => x.value));
    out[f] = [...have[f], ...card[f].filter((x) => !known.has(x.value))].slice(0, 20);
  }
  return out;
}

const same = (a, b) => FIELDS.every((f) => JSON.stringify(a[f]) === JSON.stringify(b[f]));

/** POST /api/contacts/import */
async function importFile(request, env) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_FILE_BYTES) return json({ error: "That file is too large (5 MB at most)" }, 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_FILE_BYTES) return json({ error: "That file is too large (5 MB at most)" }, 413);

  const { contacts: cards, empty, tooMany } = parseVcard(bytes, { maxCards: MAX_CARDS });
  if (tooMany) return json({ error: `That file holds more than ${MAX_CARDS} contacts` }, 413);

  const held = await allCards(env);
  const byUid = new Map();
  const byEmail = new Map();
  const index = (row) => {
    byUid.set(row.uid, row);
    for (const e of row.emails) if (!byEmail.has(e.value)) byEmail.set(e.value, row);
  };
  held.forEach(index);

  let added = 0;
  let updated = 0;
  let skipped = empty;
  const writes = [];
  const kept = [];
  const now = Date.now();
  for (const card of cards) {
    const row = (card.uid && byUid.get(card.uid)) || card.emails.map((e) => byEmail.get(e.value)).find(Boolean);
    if (!row) {
      const fresh = { ...card, uid: card.uid || crypto.randomUUID(), id: newId() };
      writes.push(insertSql(env.DB, fresh.id, fresh, now));
      kept.push(...emailsOf(fresh));
      index(fresh);
      added++;
      continue;
    }
    const next = merge(row, card);
    if (same(row, next)) {
      skipped++;
      continue;
    }
    writes.push(updateSql(env.DB, row.id, next, now));
    const had = new Set(emailsOf(row));
    kept.push(...emailsOf(next).filter((e) => !had.has(e)));
    Object.assign(row, next);
    index(row);
    updated++;
  }
  const all = [...writes, ...unhide(env.DB, [...new Set(kept)])];
  for (let i = 0; i < all.length; i += BATCH) await env.DB.batch(all.slice(i, i + BATCH));
  return json({ ok: true, found: cards.length + empty, added, updated, skipped });
}

/** GET /api/contacts/suggest: who the composer offers, saved cards first. */
async function suggest(env) {
  const [sent, hidden, saved] = await env.DB.batch([
    env.DB.prepare("SELECT to_line, cc_line FROM messages WHERE folder='sent' ORDER BY date DESC LIMIT 800"),
    env.DB.prepare("SELECT email FROM contacts_hidden"),
    env.DB.prepare("SELECT name, org, emails FROM contacts"),
  ]);
  const skip = new Set((hidden.results ?? []).map((r) => r.email));
  const seen = new Map();
  // Saved first, so the name you gave someone is the one that survives even
  // when your own sent mail spells it differently. Each address of a card is
  // offered, under the card's name.
  for (const r of saved.results ?? []) {
    const c = fromRow(r);
    for (const e of c.emails) {
      if (skip.has(e.value) || seen.has(e.value)) continue;
      seen.set(e.value, { email: e.value, name: c.name || c.org || "", n: 0, added: 1 });
    }
  }
  for (const r of sent.results ?? []) {
    for (const a of parseAddressList(`${r.to_line || ""},${r.cc_line || ""}`)) {
      if (skip.has(a.email)) continue;
      const cur = seen.get(a.email) || { email: a.email, name: "", n: 0 };
      if (!cur.name && a.name) cur.name = a.name;
      cur.n++;
      seen.set(a.email, cur);
    }
  }
  return json({
    contacts: [...seen.values()]
      .sort((a, b) => (b.added || 0) - (a.added || 0) || b.n - a.n || a.email.localeCompare(b.email))
      .slice(0, SUGGESTIONS),
  });
}

async function route(request, env, path) {
  const method = request.method;

  if (path === "/api/contacts/suggest" && method === "GET") return suggest(env);

  if (path === "/api/contacts/import" && method === "POST") return importFile(request, env);

  if (path === "/api/contacts/export" && method === "GET") {
    return download(writeVcard(await allCards(env)), "stratus-contacts.vcf");
  }

  // Never suggest this address. Nothing is deleted at the provider and the sent
  // mail it was read from stays put; this is a suppression list.
  if (path === "/api/contacts/hide" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const email = String(b.email || "").trim().toLowerCase().slice(0, 200);
    if (!isEmail(email)) return json({ error: "Not an address" }, 400);
    await env.DB.prepare("INSERT OR IGNORE INTO contacts_hidden (email, created_at) VALUES (?,?)").bind(email, Date.now()).run();
    return json({ ok: true });
  }

  if (path === "/api/contacts" && method === "GET") return json({ contacts: await allCards(env) });

  if (path === "/api/contacts" && method === "POST") {
    const b = await request.json().catch(() => null);
    if (!b || typeof b !== "object") return json({ error: "Not a contact" }, 400);
    const { contact, error } = fromBody(b);
    if (error) return json({ error }, 400);
    const id = newId();
    const now = Date.now();
    // The UID is ours to give: a client-supplied one could collide with a card
    // already held, and the unique index would turn that into a 500.
    const card = { ...contact, uid: crypto.randomUUID() };
    await env.DB.batch([insertSql(env.DB, id, card, now), ...unhide(env.DB, emailsOf(card))]);
    return json({ ok: true, contact: { id, ...card, created_at: now, updated_at: now } });
  }

  const one = path.match(/^\/api\/contacts\/([a-f0-9]{16})(\/export)?$/);
  if (!one) return null;
  const id = one[1];
  const row = await env.DB.prepare("SELECT * FROM contacts WHERE id=?").bind(id).first();
  if (!row) return json({ error: "No such contact" }, 404);
  const have = fromRow(row);

  if (one[2]) {
    if (method !== "GET") return null;
    return download(writeCard(have), `${slug(have.name || have.org || have.emails[0]?.value)}.vcf`);
  }

  if (method === "PUT") {
    const b = await request.json().catch(() => null);
    if (!b || typeof b !== "object") return json({ error: "Not a contact" }, 400);
    const { contact, error } = fromBody(b);
    if (error) return json({ error }, 400);
    const next = { ...contact, uid: have.uid };
    const now = Date.now();
    const had = new Set(emailsOf(have));
    await env.DB.batch([updateSql(env.DB, id, next, now), ...unhide(env.DB, emailsOf(next).filter((e) => !had.has(e)))]);
    return json({ ok: true, contact: { id, ...next, created_at: have.created_at, updated_at: now } });
  }

  if (method === "DELETE") {
    await env.DB.prepare("DELETE FROM contacts WHERE id=?").bind(id).run();
    return json({ ok: true });
  }

  return null;
}

export const contacts = {
  name: "contacts",
  tables: ["contacts"],
  async api(request, env, path) {
    if (!path.startsWith("/api/contacts")) return null;
    try {
      return await route(request, env, path);
    } catch (e) {
      // A file or a body is untrusted, and a database error is not the
      // client's business: either way the route answers, it does not throw.
      console.log(`contacts: ${e && e.stack ? e.stack : e}`);
      return json({ error: "Could not do that with your contacts" }, 500);
    }
  },
};
