/**
 * Categories, pinned conversations and message importance, against a real
 * SQLite (node:sqlite behind the D1 shape the harness already provides).
 */
import { register } from "node:module";
import { eq, ok } from "./harness.mjs";

register("../scripts/sync-harness/hooks.mjs", import.meta.url);
const { makeD1, makeR2 } = await import("../scripts/sync-harness/fake.mjs");
const { SCHEMA, ensureSchema } = await import("../src/schema.js");
const { handleApi } = await import("../src/api.js");
const { forgetMessages, storeRows } = await import("../src/store.js");
const { rowFromRaw } = await import("../src/sync.js");
const { buildRfc822 } = await import("../src/mime.js");
const { parseHeaders, parseMessage } = await import("../src/rfc822.js");
const { importanceFromHeaders, importanceLines } = await import("../src/importance.js");

const call = async (env, method, path, body) => {
  const res = await handleApi(
    new Request("http://x" + path, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }),
    env,
    path.split("?")[0],
    undefined,
    undefined
  );
  return { status: res.status, body: await res.json() };
};
const hex = (n) => n.toString(16).padStart(16, "0");

/* ── the colour migration, on a database as it was before categories ── */
{
  const DB = makeD1();
  const env = { DB, MAIL: makeR2() };
  // The old shape: no category tables, no pinned or importance column.
  for (const s of SCHEMA) {
    if (/^CREATE (TABLE|INDEX) IF NOT EXISTS (message_categories|categories|idx_message_categories)/.test(s)) continue;
    DB.raw.exec(s.replace(/\n\s*pinned\s+INTEGER[^\n]*/, "").replace(/\n\s*importance\s+INTEGER[^\n]*/, ""));
  }
  const cols = () => DB.raw.prepare("SELECT name FROM pragma_table_info('messages')").all().map((r) => r.name);
  ok(!cols().includes("pinned") && !cols().includes("importance"), "la base d'avant n'a pas les nouvelles colonnes");
  const put = DB.raw.prepare(
    "INSERT INTO messages (id, account_id, pid, folder, date, color, created_at) VALUES (?,?,?,?,?,?,0)"
  );
  [0, 1, 2, 3, 4, 5, 5, 3].forEach((c, i) => put.run(hex(i + 1), "a", `p${i}`, "inbox", 1000 + i, c));

  await ensureSchema(env);
  const cats = DB.raw.prepare("SELECT id, name, color FROM categories ORDER BY id").all().map((r) => ({ ...r }));
  eq(cats, [
    { id: 1, name: "Red", color: 0 }, { id: 2, name: "Orange", color: 1 }, { id: 3, name: "Yellow", color: 2 },
    { id: 4, name: "Green", color: 3 }, { id: 5, name: "Blue", color: 4 },
  ], "les cinq couleurs deviennent cinq catégories, dans l'ordre");
  const links = DB.raw.prepare("SELECT message_id, category_id FROM message_categories ORDER BY message_id, category_id").all().map((r) => [r.message_id, r.category_id]);
  eq(links, [[hex(2), 1], [hex(3), 2], [hex(4), 3], [hex(5), 4], [hex(6), 5], [hex(7), 5], [hex(8), 3]],
    "chaque couleur existante est gardée, et « sans couleur » n'a aucune catégorie");
  ok(cols().includes("pinned") && cols().includes("importance"), "les colonnes sont ajoutées par la guérison");
  eq(DB.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE pinned=0 AND importance=0").get().n, 8, "le courrier déjà stocké reste normal et non épinglé");
  eq(DB.raw.prepare("SELECT color FROM messages ORDER BY id").all().map((r) => r.color), [0, 1, 2, 3, 4, 5, 5, 3], "la colonne color n'est pas touchée");
  // Une seconde passe (autre empreinte) ne rejoue pas la migration.
  DB.raw.exec("DELETE FROM settings WHERE key='schema_fp'");
  DB.raw.exec("UPDATE categories SET name='Rouge' WHERE id=1");
  await ensureSchema(env);
  eq(DB.raw.prepare("SELECT name FROM categories WHERE id=1").get().name, "Rouge", "la migration ne tourne qu'une fois");
}

/* ── CRUD ── */
{
  const DB = makeD1();
  const MAIL = makeR2();
  const env = { DB, MAIL };
  await ensureSchema(env);
  const names = async () => (await call(env, "GET", "/api/categories")).body.categories.map((c) => c.name);
  eq(await names(), ["Red", "Orange", "Yellow", "Green", "Blue"], "une base neuve a les cinq catégories de départ");

  const made = await call(env, "POST", "/api/categories", { name: "  Taxes   2027 ", color: 7 });
  eq([made.status, made.body.categories.at(-1).name, made.body.categories.at(-1).color], [201, "Taxes 2027", 7], "créer : espaces ramenés à un, couleur gardée");
  const id = made.body.categories.at(-1).id;
  eq((await call(env, "POST", "/api/categories", { name: "taxes 2027" })).status, 409, "créer un doublon qui ne diffère que par la casse est refusé");
  eq((await call(env, "POST", "/api/categories", { name: "" })).status, 400, "un nom vide est refusé");
  eq((await call(env, "POST", "/api/categories", { name: "X", color: 99 })).status, 400, "une couleur hors palette est refusée");
  const auto = await call(env, "POST", "/api/categories", { name: "Auto" });
  eq(auto.body.categories.at(-1).color, 5, "sans couleur donnée, la première couleur la moins utilisée");

  eq((await call(env, "PATCH", `/api/categories/${id}`, { name: "RED" })).status, 409, "renommer en un nom existant à la casse près est refusé");
  eq((await call(env, "PATCH", `/api/categories/${id}`, { name: "TAXES 2027" })).status, 200, "changer la seule casse de son propre nom est permis");
  const re = await call(env, "PATCH", `/api/categories/${id}`, { color: 2 });
  const row = re.body.categories.find((c) => c.id === id);
  eq([row.name, row.color], ["TAXES 2027", 2], "recolorer ne touche pas au nom");
  eq((await call(env, "PATCH", "/api/categories/9999", { name: "Z" })).status, 404, "renommer l'inconnue : 404");

  // Supprimer une catégorie utilisée : ses liens partent, les autres restent.
  DB.raw.prepare("INSERT INTO messages (id, account_id, pid, folder, date, created_at) VALUES (?,?,?,?,?,0)").run(hex(1), "a", "p1", "inbox", 1);
  DB.raw.prepare("INSERT INTO messages (id, account_id, pid, folder, date, created_at) VALUES (?,?,?,?,?,0)").run(hex(2), "a", "p2", "inbox", 2);
  const set = await call(env, "POST", `/api/messages/${hex(1)}/categories`, { add: [id, 1, 4242] });
  eq(set.body.cats, [1, id], "ajouter ignore une catégorie qui n'existe pas");
  await call(env, "POST", `/api/messages/${hex(2)}/categories`, { add: [id] });
  const del = await call(env, "DELETE", `/api/categories/${id}`);
  eq([del.status, del.body.unlabelled], [200, 2], "supprimer retire la catégorie des deux messages");
  eq(DB.raw.prepare("SELECT COUNT(*) AS n FROM message_categories WHERE category_id=?").get(id).n, 0, "aucun lien orphelin");
  eq(DB.raw.prepare("SELECT category_id FROM message_categories WHERE message_id=?").all(hex(1)).map((r) => r.category_id), [1], "les autres catégories du message restent");
  eq((await call(env, "POST", `/api/messages/${hex(1)}/categories`, { remove: [1] })).body.cats, [], "retirer");
  eq((await call(env, "POST", `/api/messages/${hex(77)}/categories`, { add: [1] })).status, 404, "message inconnu : 404");

  // Toute la conversation d'un coup.
  const ins = DB.raw.prepare("INSERT INTO messages (id, account_id, pid, thread_key, folder, date, created_at) VALUES (?,?,?,?,?,?,0)");
  ins.run(hex(11), "a", "t1", "<t@x>", "inbox", 11);
  ins.run(hex(12), "a", "t2", "<t@x>", "inbox", 12);
  const whole = await call(env, "POST", `/api/messages/${hex(11)}/categories`, { add: [2], thread: true });
  eq(whole.body.cats, [2], "avec thread, la conversation entière");
  eq(DB.raw.prepare("SELECT message_id FROM message_categories WHERE category_id=2 ORDER BY message_id").all().map((r) => r.message_id), [hex(11), hex(12)], "chaque message de la conversation");

  // Supprimer des messages ne laisse aucune ligne orpheline, par le même chemin que l'index de recherche.
  await forgetMessages(env, [hex(11), hex(12), hex(1)]);
  eq(DB.raw.prepare("SELECT COUNT(*) AS n FROM message_categories WHERE message_id IN (?,?,?)").get(hex(11), hex(12), hex(1)).n, 0, "forgetMessages nettoie message_categories");
}

/* ── the list: pinned conversations first, paged by the cursor ── */
{
  const DB = makeD1();
  const env = { DB, MAIL: makeR2() };
  await ensureSchema(env);
  const ins = DB.raw.prepare("INSERT INTO messages (id, account_id, pid, thread_key, folder, date, created_at) VALUES (?,?,?,?,?,?,0)");
  // Twelve single messages, with two sharing one date, and two conversations
  // of three. The pinned ones are: the oldest single, one in the middle of
  // the two tied dates, and a conversation whose NEWEST reply is unpinned.
  const rows = [];
  let n = 1;
  const add = (thread, date) => {
    const id = hex(n++);
    ins.run(id, "a", "p" + id, thread, "inbox", date);
    rows.push({ id, thread, date });
    return id;
  };
  const oldest = add("", 100);
  for (const d of [900, 800, 700, 700, 600, 500, 400, 300, 200]) add("", d);
  const tied = rows.find((r) => r.date === 700).id;
  const t1 = ["<c1@x>", [add("<c1@x>", 150), add("<c1@x>", 250), add("<c1@x>", 1000)]];
  const t2 = ["<c2@x>", [add("<c2@x>", 120), add("<c2@x>", 1100)]];
  for (const id of [oldest, tied, t1[1][0]]) DB.raw.prepare("UPDATE messages SET pinned=1 WHERE id=?").run(id);
  await call(env, "POST", `/api/messages/${t2[1][1]}/pin`, { pinned: true });
  eq(DB.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_key='<c2@x>' AND pinned=1").get().n, 2, "épingler marque toute la conversation");

  // The order the list should have: pinned conversations by date, then the rest.
  const heads = new Map(); // conversation -> its newest row
  for (const r of rows) {
    const key = r.thread || r.id;
    const cur = heads.get(key);
    if (!cur || r.date > cur.date || (r.date === cur.date && r.id > cur.id)) heads.set(key, r);
  }
  const pinnedKeys = new Set([oldest, tied, "<c1@x>", "<c2@x>"]);
  const byDate = (a, b) => b.date - a.date || (a.id < b.id ? 1 : -1);
  const all = [...heads.entries()].map(([key, r]) => ({ ...r, pin: pinnedKeys.has(key) }));
  const want = [...all.filter((r) => r.pin).sort(byDate), ...all.filter((r) => !r.pin).sort(byDate)].map((r) => r.id);
  eq(want.length, 12, "douze conversations attendues");

  for (const limit of [1, 2, 3, 4, 5, 12, 50]) {
    const seen = [];
    let q = `/api/messages?folder=inbox&limit=${limit}`;
    for (let guard = 0; guard < 30; guard++) {
      const page = (await call(env, "GET", q)).body.messages;
      if (!page.length) break;
      seen.push(...page.map((m) => m.id));
      const last = page.at(-1);
      q = `/api/messages?folder=inbox&limit=${limit}&before=${last.date}&before_id=${last.id}&before_pin=${last.pinned}`;
    }
    eq(seen, want, `pages de ${limit} : ni saut ni répétition, épinglés d'abord`);
  }
  const first = (await call(env, "GET", "/api/messages?folder=inbox&limit=50")).body.messages;
  eq(first.map((m) => m.pinned), [1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0], "chaque ligne dit si sa conversation est épinglée");
  eq(first.find((m) => m.id === t1[1][2]).pinned, 1, "une réponse arrivée après l'épinglage prend la conversation épinglée");

  // Un nouveau message dans une conversation épinglée l'est aussitôt.
  add("<c1@x>", 2000);
  eq((await call(env, "GET", "/api/messages?folder=inbox&limit=1")).body.messages[0].id, rows.at(-1).id, "sans qu'il soit lui-même épinglé");
  await call(env, "POST", `/api/messages/${rows.at(-1).id}/pin`, { pinned: false });
  eq(DB.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_key='<c1@x>' AND pinned=1").get().n, 0, "désépingler libère toute la conversation");
  eq((await call(env, "GET", "/api/messages?folder=inbox&limit=1")).body.messages[0].pinned, 1, "les autres épinglés restent");

  // Ni la recherche ni les favoris ne sont réordonnés.
  DB.raw.exec("UPDATE messages SET starred=1");
  const star = (await call(env, "GET", "/api/messages?folder=inbox&starred=1&limit=50")).body.messages.map((m) => m.date);
  eq(star, [...star].sort((a, b) => b - a), "les favoris restent par date");
  const found = (await call(env, "GET", "/api/messages?folder=all&q=is:pinned&limit=50")).body.messages;
  eq(found.map((m) => m.date), [...found.map((m) => m.date)].sort((a, b) => b - a), "une recherche reste par date");

  // Les catégories d'une conversation, vues depuis sa ligne.
  await call(env, "POST", `/api/messages/${t2[1][0]}/categories`, { add: [3] });
  eq((await call(env, "GET", "/api/messages?folder=inbox&limit=50")).body.messages.find((m) => m.thread_key === "<c2@x>").cats, [3], "la ligne d'une conversation montre les catégories de n'importe lequel de ses messages");
}

/* ── importance ── */
{
  const h = (txt) => parseHeaders(txt);
  eq(importanceFromHeaders(h("Importance: High")), 1, "Importance: High");
  eq(importanceFromHeaders(h("Importance: low")), -1, "Importance: low");
  eq(importanceFromHeaders(h("Importance: normal")), 0, "Importance: normal");
  eq(importanceFromHeaders(h("X-Priority: 1 (Highest)")), 1, "X-Priority 1");
  eq(importanceFromHeaders(h("X-Priority: 2")), 1, "X-Priority 2");
  eq(importanceFromHeaders(h("X-Priority: 3 (Normal)")), 0, "X-Priority 3");
  eq(importanceFromHeaders(h("X-Priority: 4")), -1, "X-Priority 4");
  eq(importanceFromHeaders(h("X-Priority: 5 (Lowest)")), -1, "X-Priority 5");
  eq(importanceFromHeaders(h("X-MSMail-Priority: High")), 1, "X-MSMail-Priority: High");
  eq(importanceFromHeaders(h("X-MSMail-Priority: Low")), -1, "X-MSMail-Priority: Low");
  eq(importanceFromHeaders(h("Importance: low\nX-Priority: 1")), -1, "Importance l'emporte sur X-Priority");
  eq(importanceFromHeaders(h("Importance: whatever\nX-Priority: 1")), 1, "une valeur incomprise passe la main à l'en-tête suivant");
  eq(importanceFromHeaders(h("Subject: hi")), 0, "aucun en-tête : normal");
  eq(importanceFromHeaders(h("X-Priority: 9")), 0, "hors échelle : normal");

  // Aller-retour : ce que le composeur écrit, l'analyseur le relit.
  for (const [want, label] of [[1, "high"], [-1, "low"], [0, "normal"]]) {
    const raw = buildRfc822({ from: "me@x.fr", to: "you@x.fr", subject: "S", text: "body", importance: want });
    const parsed = parseMessage(new TextEncoder().encode(raw));
    eq(importanceFromHeaders(parsed.headers), want, `aller-retour par buildRfc822 : ${label}`);
    eq(rowFromRaw({ uid: 0, flags: "", raw: new TextEncoder().encode(raw) }, "sent").row.importance, want, `rowFromRaw : ${label}`);
  }
  eq(buildRfc822({ from: "me@x.fr", to: "you@x.fr", subject: "S", text: "b" }).includes("Importance"), false, "sans choix, aucun en-tête d'importance");
  eq(importanceLines("high").length, 0, "une valeur qui n'est pas 1 ou -1 est normale");

  // Stocké, et corrigé si le serveur le relit autrement.
  const DB = makeD1();
  const env = { DB, MAIL: makeR2() };
  await ensureSchema(env);
  await storeRows(env, "a", [{ pid: "<i@x>", folder: "inbox", importance: 1, date: 1 }, { pid: "<j@x>", folder: "inbox", date: 2 }]);
  eq(DB.raw.prepare("SELECT pid, importance FROM messages ORDER BY date").all().map((r) => [r.pid, r.importance]), [["<i@x>", 1], ["<j@x>", 0]], "storeRows écrit l'importance");
}
