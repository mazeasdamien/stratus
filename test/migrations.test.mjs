/**
 * The one-off data migrations (src/schema.js MIGRATIONS) on a real SQLite,
 * through ensureSchema as the cron runs it.
 *
 * Two of them insert rows with random ids, so running one again is a second
 * copy of everything it made. That happened two ways: the list of what had
 * run was written only once every pending migration had finished, so a later
 * one throwing replayed the earlier ones the next minute; and a restored
 * snapshot brings back an older list.
 */
import { eq, ok } from "./harness.mjs";
import { makeD1 } from "../scripts/sync-harness/fake.mjs";
import { SCHEMA, MIGRATIONS, ensureSchema } from "../src/schema.js";

const BEFORE_BOOK = ["colors_to_categories", "thread_key_mid", "drop_gemini_key", "events_floating"];

/** A database as it stood before the address book and the signatures: hand-kept addresses and one plain signature. */
function oldDatabase() {
  const DB = makeD1();
  for (const s of SCHEMA) DB.raw.exec(s);
  DB.raw.prepare("INSERT INTO settings (key, value) VALUES ('migrations', ?)").run(JSON.stringify(BEFORE_BOOK));
  DB.raw.prepare("INSERT INTO settings (key, value) VALUES ('signature', ?)").run("Damien\r\n<b>& co</b>");
  const add = DB.raw.prepare("INSERT INTO contacts_added (email, name, created_at) VALUES (?, ?, 1)");
  add.run("zoe@x.example", "Zoe");
  add.run("Sam@Y.example", "Sam");
  return DB;
}

const rows = (DB) => ({
  contacts: DB.raw.prepare("SELECT name, emails FROM contacts ORDER BY name").all().map((r) => [r.name, r.emails]),
  signatures: DB.raw.prepare("SELECT name, html FROM signatures ORDER BY name").all().map((r) => [r.name, r.html]),
  use: DB.raw.prepare("SELECT COUNT(*) AS n FROM signature_use WHERE address='*' AND new_id IN (SELECT id FROM signatures)").get().n,
  leftover: DB.raw.prepare("SELECT COUNT(*) AS n FROM settings WHERE key='signature'").get().n,
});
const ran = (DB) => JSON.parse(DB.raw.prepare("SELECT value FROM settings WHERE key='migrations'").get().value);
const quiet = async (f) => {
  const log = console.log;
  console.log = () => {};
  try {
    return await f();
  } finally {
    console.log = log;
  }
};

// Once, as it should go.
const once = oldDatabase();
await quiet(() => ensureSchema({ DB: once }));
const ONCE = rows(once);
eq(ONCE.contacts.length, 2, "the hand-kept addresses become two cards");
eq(ONCE.signatures, [["Default", "Damien<br>&lt;b&gt;&amp; co&lt;/b&gt;"]], "the old signature becomes one named Default");
eq([ONCE.use, ONCE.leftover], [1, 0], "used for every address, and the old setting gone");

// ── a later migration throwing does not replay the earlier ones ──
{
  const DB = oldDatabase();
  MIGRATIONS.push(["boom", "INSERT INTO no_such_table VALUES (1)"]);
  let threw = false;
  try {
    await quiet(() => ensureSchema({ DB }));
  } catch {
    threw = true;
  }
  ok(threw, "a migration that throws stops the pass");
  eq(ran(DB).slice(BEFORE_BOOK.length), ["contacts_book", "signatures_default"], "and every one before it is recorded as it completed");
  ok(!ran(DB).includes("boom"), "the one that threw is not");
  // The next minute: the pass runs again, and so does the broken one.
  await quiet(() => ensureSchema({ DB })).catch(() => {});
  await quiet(() => ensureSchema({ DB })).catch(() => {});
  MIGRATIONS.pop();
  await quiet(() => ensureSchema({ DB }));
  eq(rows(DB), ONCE, "three more passes leave the same rows as one");
}

// ── each converges when it is run again ─────────────────────
{
  const DB = oldDatabase();
  const run = (name) => {
    for (const sql of [].concat(MIGRATIONS.find(([n]) => n === name)[1])) DB.raw.exec(sql);
  };
  run("contacts_book");
  run("contacts_book");
  eq(rows(DB).contacts, ONCE.contacts, "contacts_book run twice makes the cards it makes once");
  // signatures_default stopped half-way, then run whole: its first statement twice.
  DB.raw.exec(MIGRATIONS.find(([n]) => n === "signatures_default")[1][0]);
  run("signatures_default");
  run("signatures_default");
  eq(rows(DB).signatures, ONCE.signatures, "signatures_default run again makes no second Default");
  eq(rows(DB).use, 1, "and one signature is used for every address");
}

// ── a restored snapshot brings back an older list ───────────
{
  const DB = oldDatabase();
  await quiet(() => ensureSchema({ DB }));
  // What a restore puts back: the list from before, the old setting and the
  // hand-kept addresses, beside the rows the migrations made.
  DB.raw.prepare("UPDATE settings SET value=? WHERE key='migrations'").run(JSON.stringify(BEFORE_BOOK));
  DB.raw.prepare("INSERT INTO settings (key, value) VALUES ('signature', ?)").run("Damien\r\n<b>& co</b>");
  DB.raw.exec("DELETE FROM settings WHERE key='schema_fp'");
  await quiet(() => ensureSchema({ DB }));
  eq(rows(DB), ONCE, "running them again after a restore leaves the rows running them once does");
}
