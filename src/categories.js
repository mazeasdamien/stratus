/**
 * Categories and pins: the names you give to mail, and the conversations you
 * keep at the top.
 *
 * Both live here and nowhere at the provider. iCloud has no category, and its
 * only colours are the flag colours, which are the star: giving a message a
 * colour there would have starred it on every device.
 *
 *   GET    /api/categories                       every category, in order, with how many messages hold it
 *   POST   /api/categories { name, color? }      add one
 *   PATCH  /api/categories/:id { name?, color? } rename or recolour
 *   DELETE /api/categories/:id                   remove it from every message, then itself
 *   POST   /api/messages/:id/categories { add?, remove?, thread? }
 *                                                change a message's (or its whole conversation's) categories
 *   POST   /api/messages/:id/pin { pinned }      pin or unpin the conversation
 *
 * A category's colour is an index into PALETTE_SIZE colours kept by the
 * client. The first five are the five colours a message could carry before
 * categories existed.
 */

import { json } from "./util.js";

export const PALETTE_SIZE = 10;
const NAME_MAX = 40;
// Plenty for one message, and few enough to keep each request inside D1's
// limit of 100 statements in a batch.
const IDS_MAX = 30;

const ids = (v) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter(Number.isInteger))].slice(0, IDS_MAX);

const cleanName = (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
const cleanColor = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n < PALETTE_SIZE ? n : null;
};

/** The messages a change reaches: the one, or every message of its conversation. */
const scope = (msg, thread) =>
  thread && msg.thread_key
    ? { sql: "SELECT id FROM messages WHERE account_id=? AND thread_key=?", binds: [msg.account_id, msg.thread_key] }
    : { sql: "SELECT id FROM messages WHERE id=?", binds: [msg.id] };

/**
 * Puts `cats`, a list of category ids, on each row, as the union over its
 * conversation when `byThread` is set: a conversation's row in the list shows
 * what any of its messages carries.
 */
export async function attachCategories(env, rows, byThread = false) {
  if (!rows.length) return rows;
  const found = new Map(rows.map((r) => [r.id, new Set()]));
  const byKey = new Map();
  if (byThread) {
    for (const r of rows) {
      if (!r.thread_key) continue;
      if (!byKey.has(r.thread_key)) byKey.set(r.thread_key, new Set());
    }
  }
  const stmts = [];
  const mine = [...found.keys()];
  const keys = [...byKey.keys()];
  for (let i = 0; i < mine.length; i += 90) {
    const chunk = mine.slice(i, i + 90);
    stmts.push(
      env.DB.prepare(
        `SELECT message_id AS k, category_id AS c FROM message_categories WHERE message_id IN (${chunk.map(() => "?").join(",")})`
      ).bind(...chunk)
    );
  }
  for (let i = 0; i < keys.length; i += 90) {
    const chunk = keys.slice(i, i + 90);
    stmts.push(
      env.DB.prepare(
        `SELECT DISTINCT x.thread_key AS k, mc.category_id AS c
           FROM messages x JOIN message_categories mc ON mc.message_id=x.id
          WHERE x.thread_key IN (${chunk.map(() => "?").join(",")})`
      ).bind(...chunk)
    );
  }
  const outs = await env.DB.batch(stmts);
  const nMine = Math.ceil(mine.length / 90);
  outs.forEach((out, i) => {
    const into = i < nMine ? found : byKey;
    for (const r of out.results ?? []) into.get(r.k)?.add(r.c);
  });
  for (const r of rows) {
    const all = new Set(found.get(r.id));
    for (const c of byKey.get(r.thread_key) ?? []) all.add(c);
    r.cats = [...all].sort((a, b) => a - b);
  }
  return rows;
}

/** The categories and pin a conversation has, for the reader. */
export async function conversationState(env, msg) {
  const [row] = await attachCategories(env, [{ id: msg.id, thread_key: msg.thread_key }], true);
  const pinned = msg.pinned
    ? 1
    : msg.thread_key
    ? (await env.DB.prepare("SELECT 1 AS p FROM messages WHERE thread_key=? AND pinned=1 LIMIT 1").bind(msg.thread_key).first())
      ? 1
      : 0
    : 0;
  return { cats: row.cats, pinned };
}

/** The first palette colour no category uses, so a new one is told apart. */
async function freeColor(env) {
  const { results } = await env.DB.prepare("SELECT color, COUNT(*) AS n FROM categories GROUP BY color").all();
  const used = new Map((results ?? []).map((r) => [r.color, r.n]));
  let best = 0;
  for (let c = 0; c < PALETTE_SIZE; c++) if ((used.get(c) ?? 0) < (used.get(best) ?? 0)) best = c;
  return best;
}

const list = async (env) => {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, c.color, c.position,
            (SELECT COUNT(*) FROM message_categories mc WHERE mc.category_id=c.id) AS n
       FROM categories c ORDER BY c.position, c.id`
  ).all();
  return results ?? [];
};

export async function categoriesApi(request, env, path) {
  const m = request.method;

  if (path === "/api/categories" && m === "GET") return json({ categories: await list(env), palette: PALETTE_SIZE });

  if (path === "/api/categories" && m === "POST") {
    const b = await request.json().catch(() => ({}));
    const name = cleanName(b.name);
    if (!name) return json({ error: "Give the category a name" }, 400);
    const color = b.color === undefined ? await freeColor(env) : cleanColor(b.color);
    if (color === null) return json({ error: "Pick one of the colours" }, 400);
    const at = (await env.DB.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM categories").first()).p;
    // The unique name decides a clash, not a read beforehand: two requests
    // together cannot both get in.
    const r = await env.DB.prepare("INSERT OR IGNORE INTO categories (name, color, position, created_at) VALUES (?,?,?,?)")
      .bind(name, color, at, Date.now())
      .run();
    if (!(r.meta?.changes > 0)) return json({ error: `There is already a category called ${name}` }, 409);
    return json({ ok: true, categories: await list(env) }, 201);
  }

  const one = path.match(/^\/api\/categories\/(\d+)$/);
  if (one && m === "PATCH") {
    const id = Number(one[1]);
    const b = await request.json().catch(() => ({}));
    const cur = await env.DB.prepare("SELECT id, name, color FROM categories WHERE id=?").bind(id).first();
    if (!cur) return json({ error: "Unknown category" }, 404);
    const name = b.name === undefined ? cur.name : cleanName(b.name);
    if (!name) return json({ error: "Give the category a name" }, 400);
    const color = b.color === undefined ? cur.color : cleanColor(b.color);
    if (color === null) return json({ error: "Pick one of the colours" }, 400);
    try {
      await env.DB.prepare("UPDATE categories SET name=?, color=? WHERE id=?").bind(name, color, id).run();
    } catch (e) {
      if (/UNIQUE/i.test(String(e?.message || e))) return json({ error: `There is already a category called ${name}` }, 409);
      throw e;
    }
    return json({ ok: true, categories: await list(env) });
  }
  if (one && m === "DELETE") {
    const id = Number(one[1]);
    const [gone] = await env.DB.batch([
      env.DB.prepare("DELETE FROM message_categories WHERE category_id=?").bind(id),
      env.DB.prepare("DELETE FROM categories WHERE id=?").bind(id),
    ]);
    return json({ ok: true, unlabelled: gone.meta?.changes ?? 0, categories: await list(env) });
  }

  const msgCats = path.match(/^\/api\/messages\/([a-f0-9]{16})\/categories$/);
  if (msgCats && m === "POST") {
    const b = await request.json().catch(() => ({}));
    const msg = await env.DB.prepare("SELECT id, account_id, thread_key, pinned FROM messages WHERE id=?").bind(msgCats[1]).first();
    if (!msg) return json({ error: "Unknown message" }, 404);
    const { sql, binds } = scope(msg, !!b.thread);
    const stmts = [];
    for (const c of ids(b.add)) {
      // Inserted through the categories table, so an id that is not one adds nothing.
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO message_categories (message_id, category_id)
           SELECT s.id, c.id FROM (${sql}) s, categories c WHERE c.id=?`
        ).bind(...binds, c)
      );
    }
    for (const c of ids(b.remove)) {
      stmts.push(
        env.DB.prepare(`DELETE FROM message_categories WHERE category_id=? AND message_id IN (${sql})`).bind(c, ...binds)
      );
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true, ...(await conversationState(env, msg)) });
  }

  const pin = path.match(/^\/api\/messages\/([a-f0-9]{16})\/pin$/);
  if (pin && m === "POST") {
    const b = await request.json().catch(() => ({}));
    const msg = await env.DB.prepare("SELECT id, account_id, thread_key FROM messages WHERE id=?").bind(pin[1]).first();
    if (!msg) return json({ error: "Unknown message" }, 404);
    const pinned = b.pinned ? 1 : 0;
    // The conversation, always: a list row is a conversation, and pinning one
    // message of it would unpin itself when the next reply arrived.
    const { sql, binds } = scope(msg, true);
    const r = await env.DB.prepare(`UPDATE messages SET pinned=? WHERE id IN (${sql})`).bind(pinned, ...binds).run();
    return json({ ok: true, pinned, n: r.meta?.changes ?? 1 });
  }

  return null;
}

/** For MODULES in src/modules.js. */
export const categoriesModule = {
  name: "categories",
  api: categoriesApi,
  tables: ["categories", "message_categories"],
};
