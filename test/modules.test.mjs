/**
 * The module registry (src/modules.js), driven through the real handleApi and
 * the real nightly backup rather than through its helpers.
 */
import { register } from "node:module";
import { eq, ok } from "./harness.mjs";

// api.js reaches for cloudflare:sockets; the sync harness has the stand-ins.
register("../scripts/sync-harness/hooks.mjs", import.meta.url);
const { MODULES } = await import("../src/modules.js");
const { handleApi } = await import("../src/api.js");
const { runBackup } = await import("../src/backup.js");
const { default: worker } = await import("../src/index.js");

const text = (s, status = 200) => new Response(s, { status });
const get = (path, env = {}) => handleApi(new Request("http://x" + path), env, path, undefined, undefined);

// With no module, an unknown route is the built-in 404.
eq((await get("/api/nothing-here")).status, 404, "sans module, une route inconnue reste un 404");

const mod = { name: "probe" };
MODULES.push(mod);
try {
  // The built-in /api/accounts needs a database; env has none, so reaching it
  // would throw. Getting the module's answer shows it was asked first.
  mod.api = async (req, env, path) => (path === "/api/accounts" ? text("from module") : null);
  const res = await get("/api/accounts");
  eq(await res.text(), "from module", "l'api d'un module est consultée avant les routes intégrées");

  eq((await get("/api/nothing-here")).status, 404, "null laisse la main aux routes intégrées");

  // The first module to answer wins; later ones are not asked.
  let asked = false;
  const later = { name: "later", api: async () => ((asked = true), text("second")) };
  MODULES.push(later);
  eq(await (await get("/api/accounts")).text(), "from module", "le premier module qui répond l'emporte");
  ok(!asked, "et les suivants ne sont pas interrogés");
  eq(await (await get("/api/other")).text(), "second", "un module qui répond null passe la main au suivant");
  MODULES.pop();

  // Arguments reach the module as handleApi got them.
  let seen;
  mod.api = async (req, env, path, ctx, session) => ((seen = { env, path, ctx, session }), text("ok"));
  const env = { tag: "env" }, ctx = { tag: "ctx" }, session = { tag: "session" };
  await handleApi(new Request("http://x/api/x"), env, "/api/x", ctx, session);
  eq([seen.env, seen.path, seen.ctx, seen.session], [env, "/api/x", ctx, session], "le module reçoit env, path, ctx et session");

  // Cron: a throwing module does not stop the next one, and each runs once
  // per heartbeat. The DB here is empty, so the built-in jobs have nothing to
  // do and the run is only the modules.
  delete mod.api;
  const ran = [];
  mod.cron = () => { ran.push("a"); throw new Error("boom"); };
  MODULES.push({ name: "rejects", cron: async () => { ran.push("b"); throw new Error("later boom"); } });
  MODULES.push({ name: "fine", cron: async (e, c, ev) => { ran.push("c"); ran.push(ev.cron); } });
  const waits = [];
  const quiet = console.log;
  console.log = () => {};
  const db = {
    prepare: () => ({ bind() { return this; }, all: async () => ({ results: [] }), first: async () => ({}), run: async () => ({}) }),
    batch: async () => [],
    exec: async () => ({}),
  };
  try {
    await worker.scheduled({ cron: "* * * * *" }, { DB: db, MAIL: {} }, { waitUntil: (p) => waits.push(p) });
    // The sync pass queues the module crons itself, so keep draining until
    // nothing new has been handed to waitUntil.
    for (let seen = 0; seen < waits.length; ) {
      seen = waits.length;
      await Promise.allSettled(waits);
    }
  } finally {
    console.log = quiet;
  }
  eq(ran, ["a", "b", "c", "* * * * *"], "chaque cron tourne, même quand le précédent échoue, et reçoit l'évènement");
  MODULES.length = 1;

  // Backup: a module's tables are snapshotted and restored with the rest.
  mod.tables = ["probe_rows"];
  const rows = [{ id: 1, v: "a" }, { id: 2, v: "b" }];
  const stored = new Map();
  const r2 = {
    put: async (k, b) => void stored.set(k, b),
    get: async (k) => (stored.has(k) ? { text: async () => stored.get(k) } : null),
    list: async () => ({ objects: [...stored.keys()].map((key) => ({ key })), truncated: false }),
    delete: async (ks) => { for (const k of [].concat(ks)) stored.delete(k); },
  };
  const queried = [];
  const backupDb = {
    prepare: (sql) => ({
      bind: () => ({ all: async () => { queried.push(sql); return { results: sql.includes("FROM probe_rows") ? rows.map((r, i) => ({ _r: i + 1, ...r })) : [] }; } }),
    }),
  };
  const out = await runBackup({ DB: backupDb, MAIL: r2 }, Date.now());
  eq(out.counts.probe_rows, 2, "la sauvegarde nocturne inclut les tables d'un module");
  ok(queried.some((q) => q.includes("FROM messages")), "avec les tables du cœur");
  ok([...stored.keys()].some((k) => /probe_rows-0\.json$/.test(k)), "dans une part à elle");
} finally {
  MODULES.length = 0;
}
