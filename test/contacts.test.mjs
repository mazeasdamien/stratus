/**
 * The address book's routes (src/contacts.js), driven the way the Worker
 * drives them, over a real SQLite as scripts/sync-harness does. Every person
 * here is invented.
 */
import { eq, ok } from "./harness.mjs";
import { makeD1 } from "../scripts/sync-harness/fake.mjs";
import { SCHEMA, ensureSchema } from "../src/schema.js";
import { MODULES } from "../src/modules.js";
import { contacts as mod } from "../src/contacts.js";
import { writeVcard } from "../src/vcard.js";

ok(MODULES.includes(mod), "the contacts module is registered");
eq(mod.tables, ["contacts"], "and its table is in the nightly snapshot");

const DB = makeD1();
const env = { DB };
const call = async (method, path, body, headers = {}) => {
  const init = { method, headers };
  if (body !== undefined) init.body = typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body);
  if (body !== undefined && typeof body === "object" && !(body instanceof Uint8Array)) init.headers = { "Content-Type": "application/json", ...headers };
  const res = await mod.api(new Request("http://x" + path, init), env, path);
  if (!res) return { status: null };
  const type = res.headers.get("Content-Type") || "";
  return { status: res.status, res, body: type.includes("json") ? await res.json() : await res.text() };
};

// ── a database from before the address book, with what was kept by hand ──
for (const sql of SCHEMA) DB.raw.exec(sql);
DB.raw.exec("DROP TABLE contacts");
DB.raw.exec("DROP INDEX IF EXISTS idx_contacts_uid");
DB.raw.exec("INSERT INTO contacts_added (email, name, created_at) VALUES ('old.friend@example.test', 'Old Friend', 1000), ('bare@example.test', '', 2000)");
await ensureSchema(env);
{
  const rows = DB.raw.prepare("SELECT * FROM contacts ORDER BY created_at").all();
  eq(rows.map((r) => [r.name, JSON.parse(r.emails)]), [["Old Friend", [{ type: "", value: "old.friend@example.test" }]], ["", [{ type: "", value: "bare@example.test" }]]], "the contacts_added migration makes one card per address, named as it was");
  ok(rows.every((r) => /^[0-9a-f]{16}$/.test(r.id) && r.uid.length >= 16 && r.updated_at === r.created_at), "each with an id, a UID and its original date");
  eq(DB.raw.prepare("SELECT COUNT(*) n FROM contacts_added").get().n, 2, "contacts_added is left in place");
  await ensureSchema(env);
  eq(DB.raw.prepare("SELECT COUNT(*) n FROM contacts").get().n, 2, "and the migration does not run again");
}

// ── CRUD ──
let created;
{
  const r = await call("POST", "/api/contacts", {
    name: "  Camille Roux ", given: "Camille", family: "Roux", org: "Atelier Roux",
    emails: [{ type: "work", value: "Camille@Atelier-Roux.example" }, { type: "", value: "camille@atelier-roux.example" }, { type: "home", value: "" }],
    phones: [{ type: "cell", value: "+33 6 00 00 00 01" }, { type: "", value: "no digits" }],
    uid: "client-chosen", notes: "Met at the fair",
  });
  eq(r.status, 200, "a card is created");
  created = r.body.contact;
  eq([created.name, created.emails, created.phones], ["Camille Roux", [{ type: "work", value: "camille@atelier-roux.example" }], [{ type: "cell", value: "+33 6 00 00 00 01" }]], "trimmed, lower-cased, de-duplicated, and a number with no digits is dropped");
  ok(/^[0-9a-f]{16}$/.test(created.id) && created.uid !== "client-chosen", "the id and the UID are the server's");

  eq((await call("POST", "/api/contacts", { name: "", emails: [] })).status, 400, "a card that says nothing is refused");
  const bad = await call("POST", "/api/contacts", { name: "X", emails: [{ value: "not an address" }] });
  eq([bad.status, /not an email address/.test(bad.body.error)], [400, true], "an address that is not one is refused, by name");
  eq((await call("POST", "/api/contacts", "{broken")).status, 400, "a body that is not JSON is refused");

  const list = await call("GET", "/api/contacts");
  eq(list.body.contacts.map((c) => c.name), ["", "Camille Roux", "Old Friend"], "the list holds every card, by name");
  eq(list.body.contacts[1].emails[0].value, "camille@atelier-roux.example", "with its lists as lists");

  const put = await call("PUT", `/api/contacts/${created.id}`, { ...created, name: "Camille Roux-Dupont", uid: "ignored", emails: [{ type: "work", value: "camille@atelier-roux.example" }, { type: "", value: "c.roux@perso.example" }] });
  eq([put.status, put.body.contact.name, put.body.contact.uid === created.uid, put.body.contact.emails.length], [200, "Camille Roux-Dupont", true, 2], "a card is changed, and keeps its UID");
  eq(DB.raw.prepare("SELECT name, created_at, updated_at FROM contacts WHERE id=?").get(created.id).created_at, created.created_at, "created_at is not touched");
  eq((await call("PUT", "/api/contacts/0000000000000000", { name: "Nobody" })).status, 404, "changing a card that is not there is a 404");

  const one = await call("GET", `/api/contacts/${created.id}/export`);
  ok(one.status === 200 && one.res.headers.get("Content-Disposition").includes("camille-roux-dupont.vcf") && one.res.headers.get("Content-Type").startsWith("text/vcard"), "one card exports as a .vcf named after the person");
  ok(one.body.includes("FN:Camille Roux-Dupont") && one.body.includes("EMAIL;TYPE=INTERNET:c.roux@perso.example"), "with its fields in it");

  const gone = await call("DELETE", `/api/contacts/${created.id}`);
  eq([gone.status, DB.raw.prepare("SELECT COUNT(*) n FROM contacts WHERE id=?").get(created.id).n], [200, 0], "a card is deleted");
  eq((await call("DELETE", "/api/contacts/old.friend%40example.test")).status, null, "the old DELETE-by-address route is not served by the module any more");
}

// ── import ──
const file = writeVcard([
  { uid: "uid-a", name: "Samir Haddad", given: "Samir", family: "Haddad", org: "", title: "", emails: [{ type: "work", value: "samir@haddad.example" }], phones: [], address: "", birthday: "1990-02-14", notes: "" },
  { uid: "uid-b", name: "Priya Raman", given: "", family: "", org: "", title: "", emails: [{ type: "", value: "priya@raman.example" }, { type: "", value: "old.friend@example.test" }], phones: [{ type: "cell", value: "+44 7700 900123" }], address: "", birthday: "", notes: "" },
]) + "BEGIN:VCARD\r\nVERSION:3.0\r\nPHOTO:AAAA\r\nEND:VCARD\r\n";
{
  // priya's second address is Old Friend's: she is matched on it and merged.
  const first = await call("POST", "/api/contacts/import", new TextEncoder().encode(file));
  eq([first.status, first.body.added, first.body.updated, first.body.skipped], [200, 1, 1, 1], "first import: one added, one merged into the card with the same address, one empty card skipped");
  const merged = DB.raw.prepare("SELECT * FROM contacts WHERE name='Priya Raman'").get();
  eq([JSON.parse(merged.emails).map((e) => e.value), JSON.parse(merged.phones).length], [["old.friend@example.test", "priya@raman.example"], 1], "the merge keeps the address that was held and adds the new one");
  const before = DB.raw.prepare("SELECT COUNT(*) n FROM contacts").get().n;
  const second = await call("POST", "/api/contacts/import", new TextEncoder().encode(file));
  eq([second.body.added, second.body.updated, second.body.skipped], [0, 0, 3], "the same file again changes nothing and says so");
  eq(DB.raw.prepare("SELECT COUNT(*) n FROM contacts").get().n, before, "and no one is duplicated");

  // Matched on UID even when every address is different.
  const moved = writeVcard([{ uid: "uid-a", name: "Samir Haddad", given: "", family: "", org: "Haddad Conseil", title: "", emails: [{ type: "", value: "samir@new-job.example" }], phones: [], address: "", birthday: "", notes: "" }]);
  const third = await call("POST", "/api/contacts/import", moved);
  eq([third.body.added, third.body.updated], [0, 1], "a card with a known UID is that person, whatever its addresses");
  const samir = DB.raw.prepare("SELECT * FROM contacts WHERE uid='uid-a'").get();
  eq([samir.org, JSON.parse(samir.emails).length, samir.birthday], ["Haddad Conseil", 2, "1990-02-14"], "what the file says wins, the rest is kept");

  // Two cards for one person in one file are one person.
  const twice = writeVcard([
    { uid: "u1", name: "Lena Voss", emails: [{ type: "", value: "lena@voss.example" }], phones: [] },
    { uid: "u2", name: "Lena Voss", emails: [{ type: "", value: "lena@voss.example" }, { type: "", value: "l@voss2.example" }], phones: [] },
  ]);
  const t = await call("POST", "/api/contacts/import", twice);
  eq([t.body.added, t.body.updated, DB.raw.prepare("SELECT COUNT(*) n FROM contacts WHERE name='Lena Voss'").get().n], [1, 1, 1], "two cards sharing an address inside one file make one contact");

  // Untrusted input never throws past the route.
  eq((await call("POST", "/api/contacts/import", new Uint8Array(0))).body, { ok: true, found: 0, added: 0, updated: 0, skipped: 0 }, "an empty file imports nothing, without an error");
  const junk = await call("POST", "/api/contacts/import", new Uint8Array(3000).map((_, i) => (i * 37 + 11) & 0xff));
  eq([junk.status, junk.body.added], [200, 0], "garbage imports nothing, without an error");
  const huge = await call("POST", "/api/contacts/import", new Uint8Array(5 * 1024 * 1024 + 1));
  eq(huge.status, 413, "a file over 5 MB is refused");
  const declared = await call("POST", "/api/contacts/import", "x", { "Content-Length": String(6 * 1024 * 1024) });
  eq(declared.status, 413, "and so is one that says it is, before it is read");
  const crowd = Array.from({ length: 2001 }, (_, i) => `BEGIN:VCARD\nFN:Person ${i}\nEMAIL:p${i}@crowd.example\nEND:VCARD\n`).join("");
  const many = await call("POST", "/api/contacts/import", crowd);
  eq([many.status, DB.raw.prepare("SELECT COUNT(*) n FROM contacts WHERE name LIKE 'Person %'").get().n], [413, 0], "a file with too many cards is refused whole, not half imported");
  const big = Array.from({ length: 300 }, (_, i) => `BEGIN:VCARD\nFN:Bulk ${i}\nEMAIL:b${i}@bulk.example\nTEL:+1 555 01${String(i).padStart(2, "0")}\nEND:VCARD\n`).join("");
  const bulk = await call("POST", "/api/contacts/import", big);
  eq([bulk.body.added, DB.raw.prepare("SELECT COUNT(*) n FROM contacts WHERE name LIKE 'Bulk %'").get().n], [300, 300], "three hundred cards import in batches");
}

// ── export ──
{
  const all = await call("GET", "/api/contacts/export");
  ok(all.status === 200 && all.res.headers.get("Content-Disposition").includes("stratus-contacts.vcf"), "everything exports as one file");
  eq((all.body.match(/BEGIN:VCARD/g) || []).length, DB.raw.prepare("SELECT COUNT(*) n FROM contacts").get().n, "with one card for each contact");
  const again = await call("POST", "/api/contacts/import", all.body);
  eq([again.body.added, again.body.updated], [0, 0], "and importing that export changes nothing");
}

// ── suggestions ──
{
  const sent = DB.raw.prepare("INSERT INTO messages (id, account_id, pid, folder, to_line, cc_line, date, created_at) VALUES (?,?,?,?,?,?,?,?)");
  // Zoé is written to most, then Old Friend, then Priya's second address. Sam only ever appears in sent mail.
  let n = 0;
  const send = (to, cc = "") => sent.run(`m${++n}`, "a", `p${n}`, "sent", to, cc, 1e12 + n, 1);
  send("Zoé Marin <zoe@marin.example>");
  send("Zoé Marin <zoe@marin.example>, Sam <sam@sent-only.example>");
  send("Zoé <zoe@marin.example>", "Old Friend <old.friend@example.test>");
  send("Sam <sam@sent-only.example>");
  send("Sam <sam@sent-only.example>");
  send("Sam <sam@sent-only.example>");
  const r = await call("GET", "/api/contacts/suggest");
  const list = r.body.contacts;
  const at = (email) => list.findIndex((c) => c.email === email);
  eq(r.status, 200, "suggestions are served");
  ok(at("old.friend@example.test") >= 0 && at("samir@haddad.example") >= 0 && at("zoe@marin.example") >= 0, "saved addresses and sent ones are both offered");
  ok(list.slice(0, list.findIndex((c) => !c.added)).every((c) => c.added), "every saved contact comes before any address only seen in sent mail");
  ok(at("old.friend@example.test") < at("sam@sent-only.example") && at("samir@haddad.example") < at("sam@sent-only.example"), "even when the sent address was written to far more often");
  ok(at("sam@sent-only.example") < at("zoe@marin.example"), "and sent-only addresses keep their order by how often you wrote");
  // The import above renamed this card to Priya Raman: it had her address too.
  eq(list[at("old.friend@example.test")], { email: "old.friend@example.test", name: "Priya Raman", n: 1, added: 1 }, "a saved address carries its card's name and how often you wrote to it");
  eq([list[at("samir@haddad.example")].name, list[at("samir@new-job.example")].name], ["Samir Haddad", "Samir Haddad"], "a contact with several addresses offers each, under its name");
  eq(list[at("zoe@marin.example")].name, "Zoé", "a sent-only address takes the name from the newest message that has one");

  // A hidden address is never suggested, saved or not.
  eq((await call("POST", "/api/contacts/hide", { email: "Sam@Sent-Only.example" })).status, 200, "an address can be hidden");
  eq((await call("POST", "/api/contacts/hide", { email: "samir@new-job.example" })).status, 200, "a saved address too");
  const after = (await call("GET", "/api/contacts/suggest")).body.contacts.map((c) => c.email);
  ok(!after.includes("sam@sent-only.example") && !after.includes("samir@new-job.example"), "neither is suggested any more");
  ok(after.includes("samir@haddad.example"), "the contact's other address still is");
  eq((await call("POST", "/api/contacts/hide", { email: "nope" })).status, 400, "hiding something that is not an address is refused");

  // Saving an address again is how a hidden one comes back.
  const row = DB.raw.prepare("SELECT id FROM contacts WHERE uid='uid-a'").get();
  const keep = await call("PUT", `/api/contacts/${row.id}`, { name: "Samir Haddad", org: "Haddad Conseil", emails: [{ value: "samir@new-job.example" }, { value: "samir@haddad.example" }, { value: "sam@sent-only.example" }] });
  eq(keep.status, 200, "a card gets a hidden address added");
  const back = (await call("GET", "/api/contacts/suggest")).body.contacts.map((c) => c.email);
  ok(back.includes("sam@sent-only.example"), "an address added to a card is suggested again");
  ok(!back.includes("samir@new-job.example"), "while one that was already on it stays hidden");
  // …but an address that was already on the card stays as hidden as it was.
  await call("POST", "/api/contacts/hide", { email: "samir@haddad.example" });
  await call("PUT", `/api/contacts/${row.id}`, { name: "Samir H.", emails: [{ value: "samir@new-job.example" }, { value: "samir@haddad.example" }, { value: "sam@sent-only.example" }] });
  ok(!(await call("GET", "/api/contacts/suggest")).body.contacts.some((c) => c.email === "samir@haddad.example"), "editing a card does not bring back an address you hid from it");
  const imported = await call("POST", "/api/contacts/import", "BEGIN:VCARD\nFN:Zed\nEMAIL:samir@haddad.example\nEND:VCARD\n");
  eq(imported.body.updated, 1, "an import that adds nothing new to a card");
  ok(!(await call("GET", "/api/contacts/suggest")).body.contacts.some((c) => c.email === "samir@haddad.example"), "does not unhide it either");
  const fresh = await call("POST", "/api/contacts", { name: "Hidden Hana", emails: [{ value: "hana@hidden.example" }] });
  await call("POST", "/api/contacts/hide", { email: "hana@hidden.example" });
  const hana = await call("POST", "/api/contacts", { name: "Hana Again", emails: [{ value: "hana@hidden.example" }] });
  ok((await call("GET", "/api/contacts/suggest")).body.contacts.some((c) => c.email === "hana@hidden.example"), "a new card with a hidden address makes it visible again");
  ok(fresh.status === 200 && hana.status === 200, "(both were created)");
}

// ── a database that fails is an error, not a throw ──
{
  const broken = { DB: { prepare: () => { throw new Error("D1 is down"); }, batch: async () => { throw new Error("D1 is down"); } } };
  const quiet = console.log;
  console.log = () => {};
  let res;
  try {
    res = await mod.api(new Request("http://x/api/contacts"), broken, "/api/contacts");
  } finally {
    console.log = quiet;
  }
  eq(res.status, 500, "a failing database answers 500 and does not throw");
  eq(await mod.api(new Request("http://x/api/accounts"), broken, "/api/accounts"), null, "and a path that is not the module's is left for the built-in routes");
}
