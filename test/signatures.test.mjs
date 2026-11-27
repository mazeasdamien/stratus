/**
 * Signatures (src/signatures.js) against a real SQLite: the migration that
 * turns the one plain-text signature into "Default", the routes, and what
 * the markup is made into on the way in.
 */
import { register } from "node:module";
import { eq, ok } from "./harness.mjs";

register("../scripts/sync-harness/hooks.mjs", import.meta.url);
const { makeD1 } = await import("../scripts/sync-harness/fake.mjs");
const { SCHEMA, ensureSchema } = await import("../src/schema.js");
const { handleApi } = await import("../src/api.js");
const { MODULES } = await import("../src/modules.js");
const { signaturesModule, cleanSignature } = await import("../src/signatures.js");

const mkEnv = () => {
  const DB = makeD1();
  for (const s of SCHEMA) DB.raw.exec(s);
  return { DB, APP_URL: "http://x" };
};
const call = async (env, method, path, body) => {
  const res = await handleApi(
    new Request("http://x" + path, { method, body: body ? JSON.stringify(body) : undefined }),
    env, path.split("?")[0], undefined, undefined
  );
  return { status: res.status, body: await res.json() };
};

ok(MODULES.includes(signaturesModule), "the module is registered");

// The migration: an old signature becomes "Default", for every address, both ways.
{
  const env = mkEnv();
  env.DB.raw
    .prepare("INSERT INTO settings (key, value) VALUES ('signature', ?)")
    .run("Damien\r\nTom & <Jerry>\nhttps://example.test/?a=1&b=2");
  await ensureSchema(env);
  const r = await call(env, "GET", "/api/signatures");
  eq(r.body.signatures.length, 1, "one signature came out of the old setting");
  eq(r.body.signatures[0].name, "Default", "named Default");
  eq(
    r.body.signatures[0].html,
    "Damien<br>Tom &amp; &lt;Jerry&gt;<br>https://example.test/?a=1&amp;b=2",
    "its text is escaped and its lines are breaks"
  );
  const id = r.body.signatures[0].id;
  eq(r.body.use["*"], { new_id: id, reply_id: id }, "every address signs with it, for new mail and for replies");
  eq(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM settings WHERE key='signature'").get().n, 0, "the old setting is gone");
  const old = await handleApi(new Request("http://x/api/signature"), env, "/api/signature", undefined, undefined);
  eq(old.status, 404, "and the old route no longer answers");
}

// No signature before, none after.
{
  const env = mkEnv();
  await ensureSchema(env);
  const r = await call(env, "GET", "/api/signatures");
  eq([r.body.signatures, r.body.use], [[], {}], "an install with no signature gets none");
  const again = mkEnv();
  again.DB.raw.prepare("INSERT INTO settings (key, value) VALUES ('signature', '   ')").run();
  await ensureSchema(again);
  eq((await call(again, "GET", "/api/signatures")).body.signatures, [], "a blank one is not carried over");
}

// The routes.
{
  const env = mkEnv();
  eq((await call(env, "POST", "/api/signatures", { name: "  ", html: "x" })).status, 400, "a signature needs a name");
  const a = (await call(env, "POST", "/api/signatures", { name: "Work", html: "<b>Damien</b>" })).body.signature;
  const b = (await call(env, "POST", "/api/signatures", { name: "Home", html: "Dam" })).body.signature;
  eq([a.position, b.position], [0, 1], "kept in the order they were made");
  const up = await call(env, "POST", `/api/signatures/${a.id}`, { name: "Office" });
  eq([up.body.signature.name, up.body.signature.html], ["Office", "<b>Damien</b>"], "a rename leaves the text alone");
  eq((await call(env, "POST", "/api/signatures/nope", { name: "x" })).status, 404, "an unknown id is a 404");

  eq((await call(env, "POST", "/api/signatures/use", { address: "not an address", new_id: a.id })).status, 400, "the address is checked");
  eq((await call(env, "POST", "/api/signatures/use", { address: "me@example.test", new_id: "nope" })).status, 400, "the signature must exist");
  await call(env, "POST", "/api/signatures/use", { address: "Me@Example.test", new_id: a.id, reply_id: b.id });
  await call(env, "POST", "/api/signatures/use", { address: "me@example.test", reply_id: null });
  let use = (await call(env, "GET", "/api/signatures")).body.use;
  eq(use["me@example.test"], { new_id: a.id, reply_id: null }, "set per address, lowercased, a key left out is kept and null is none");

  await call(env, "POST", "/api/signatures/use", { address: "me@example.test", reply_id: a.id });
  eq((await call(env, "DELETE", `/api/signatures/${a.id}`)).body.ok, true, "delete");
  use = (await call(env, "GET", "/api/signatures")).body.use;
  eq(use["me@example.test"], { new_id: null, reply_id: null }, "an address does not keep pointing at a deleted signature");
  eq((await call(env, "GET", "/api/signatures")).body.signatures.map((s) => s.name), ["Home"], "only the other one is left");
  eq((await call(env, "DELETE", `/api/signatures/${a.id}`)).status, 404, "deleting twice is a 404");
}

// What the markup is made into.
{
  const dirty =
    '<div>Damien <b>Mazeas</b></div>' +
    '<img src="https://tracker.example/p.gif" width=1 height=1>' +
    '<img src="data:image/png;base64,AAAA">' +
    '<script>alert(1)</script>' +
    '<div onclick="steal()" style="color:#c00;background:red">Studio</div>' +
    '<div style="background:url(https://tracker.example/x)">Logo</div>' +
    '<a href="https://example.test/a?x=1&y=2" onmouseover="x()">site</a> ' +
    '<a href="javascript:alert(1)">bad</a>' +
    '<span style="color: rgb(200, 0, 0); position:fixed">red</span>' +
    '<font color="#336699">blue</font><i>it</i><u>un</u><br>' +
    '<style>body{background:url(https://tracker.example/y)}</style>' +
    '<iframe src="https://evil.example"></iframe><form action="https://evil.example"><input name=a></form>';
  const out = cleanSignature(dirty);
  ok(!/<img|data-blocked|tracker|<script|alert|onclick|onmouseover|<style|<iframe|<form|<input|javascript:|position|evil/i.test(out), `nothing remote, nothing live (${out})`);
  ok(out.includes("<b>Mazeas</b>"), "bold kept");
  ok(out.includes('<a href="https://example.test/a?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">site</a>'), "a link kept, handler gone");
  ok(out.includes('style="color:#c00"'), "a colour kept, the background gone");
  ok(out.includes('style="color:rgb(200, 0, 0)"') || out.includes("color:rgb(200, 0, 0)"), "an rgb colour kept, the position gone");
  ok(out.includes('<font color="#336699">blue</font>'), "a font colour kept");
  ok(out.includes("<i>it</i><u>un</u><br>"), "italic, underline and a line break kept");
  ok(out.includes("bad") && !out.includes("javascript"), "the text of a dead link stays, the link does not");
  eq(cleanSignature("1 < 2 & 3"), "1 &lt; 2 & 3", "a bare < is text");
  eq(cleanSignature(""), "", "empty is empty");
}

// Through the route as well, so a client cannot skip the cleaning.
{
  const env = mkEnv();
  const s = (await call(env, "POST", "/api/signatures", { name: "x", html: '<b>a</b><img src="https://t.example/p.gif"><script>1</script>' })).body.signature;
  eq(s.html, "<b>a</b>", "the route cleans what it stores");
  const u = (await call(env, "POST", `/api/signatures/${s.id}`, { html: '<i onclick="x()">b</i>' })).body.signature;
  eq(u.html, "<i>b</i>", "and what it updates");
}
