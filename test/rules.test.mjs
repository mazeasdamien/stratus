/**
 * Rules: what planActions decides for a message, and the routes that store
 * and run them, against a real SQLite (node:sqlite behind the D1 shape the
 * sync harness provides). Moving mail at iCloud is proven in
 * scripts/sync-harness/rules.mjs; here only the local actions run.
 */
import { register } from "node:module";
import { eq, ok } from "./harness.mjs";

register("../scripts/sync-harness/hooks.mjs", import.meta.url);
const { makeD1, makeR2 } = await import("../scripts/sync-harness/fake.mjs");
const { ensureSchema } = await import("../src/schema.js");
const { handleApi } = await import("../src/api.js");
const { planActions, catalog, FIELDS, ACTIONS } = await import("../src/rules.js");

/* ── planning ── */

let nextId = 1;
const rule = (conditions, actions, extra = {}) => ({
  id: nextId++,
  name: "r",
  enabled: 1,
  position: nextId,
  match: "all",
  conditions: JSON.stringify(conditions),
  actions: JSON.stringify(actions),
  stop: 0,
  ...extra,
});
const c = (field, op, value) => ({ field, op, value });
const star = { type: "star", value: "" };
const types = (plan) => plan.map((a) => a.type);

const msg = {
  from_name: "Zoé Müller",
  from_email: "zoe@news.example.com",
  to_line: "Me <me@example.com>, Bob <bob@other.org>",
  cc_line: "Carol <carol@third.org>",
  subject: "Dîner vendredi soir",
  body: "Le devis est prêt, merci",
  snippet: "preview only",
  att_names: "devis-2026.pdf\nphoto.png",
  importance: 1,
  folder: "inbox",
  unread: 1,
  starred: 0,
  pinned: 0,
  cats: [],
};
const hits = (cond, m = msg) => planActions([rule([cond], [star])], m).length === 1;

// Every field and operator, as the table says it allows them.
const CASES = [
  // from: the address, the name, or both as the header has them
  ["from", "contains", "news.example", true], ["from", "contains", "other", false],
  ["from", "not_contains", "other", true], ["from", "not_contains", "example", false],
  ["from", "is", "zoe@news.example.com", true], ["from", "is", "zoe", false], ["from", "is", "Zoé Müller", true],
  ["from", "starts", "zoe@", true], ["from", "starts", "news", false],
  ["from", "ends", "@news.example.com", true], ["from", "ends", "example", false],
  // to and cc: each recipient is a candidate, so "is" finds any one of them
  ["to", "contains", "bob@", true], ["to", "contains", "carol", false],
  ["to", "is", "bob@other.org", true], ["to", "is", "me@example.com", true], ["to", "is", "alice@other.org", false],
  ["to", "starts", "bob@", true], ["to", "ends", "@other.org", true], ["to", "not_contains", "carol", true],
  ["cc", "contains", "carol", true], ["cc", "is", "carol@third.org", true], ["cc", "contains", "bob", false],
  ["cc", "starts", "carol@", true], ["cc", "ends", "@third.org", true], ["cc", "not_contains", "bob", true],
  // subject
  ["subject", "contains", "vendredi", true], ["subject", "contains", "samedi", false],
  ["subject", "not_contains", "samedi", true], ["subject", "is", "dîner vendredi soir", true],
  ["subject", "is", "dîner", false], ["subject", "starts", "dîner", true], ["subject", "ends", "soir", true],
  ["subject", "ends", "dîner", false],
  // text: the body when the caller has it, never the preview alongside it
  ["body", "contains", "devis", true], ["body", "contains", "preview", false], ["body", "not_contains", "devis", false],
  ["body", "not_contains", "facture", true],
  // attachment name: any one of them
  ["attachment", "contains", "2026", true], ["attachment", "is", "photo.png", true], ["attachment", "is", "photo", false],
  ["attachment", "starts", "devis", true], ["attachment", "ends", ".png", true], ["attachment", "not_contains", "zip", true],
  ["attachment", "not_contains", "photo", false],
  // choices
  ["has_attachment", "is", "yes", true], ["has_attachment", "is", "no", false],
  ["importance", "is", "high", true], ["importance", "is", "normal", false], ["importance", "is_not", "low", true],
  ["importance", "is_not", "high", false],
];
for (const [field, op, value, want] of CASES) eq(hits(c(field, op, value)), want, `${field} ${op} "${value}"`);

// The table is what the cases cover.
const covered = new Set(CASES.map(([f, o]) => `${f}/${o}`));
const offered = Object.entries(FIELDS).flatMap(([f, d]) => d.ops.map((o) => `${f}/${o}`));
eq(offered.filter((k) => !covered.has(k)), [], "every operator a field offers is tested");
eq(catalog().fields.map((f) => f.id), Object.keys(FIELDS), "the catalog lists the fields in table order");

// No attachment, low importance, and a body that was not loaded.
const bare = { ...msg, att_names: "", importance: 0, body: undefined };
eq(hits(c("has_attachment", "is", "no"), bare), true, "no attachment names means no attachment");
eq(hits(c("attachment", "not_contains", "x"), bare), true, "'does not contain' holds when there is nothing to contain it");
eq(hits(c("importance", "is", "normal"), bare), true, "importance 0 is normal");
eq(hits(c("importance", "is", "low"), { ...bare, importance: -1 }), true, "importance -1 is low");
eq(hits(c("body", "contains", "preview"), bare), true, "without a loaded body the preview is read");

// Case and accents, on both sides.
eq(hits(c("subject", "contains", "DINER")), true, "accents and case in the value are ignored");
eq(hits(c("from", "is", "ZOE MULLER")), true, "a name matches without its accents or case");
eq(hits(c("subject", "contains", "  dîner   vendredi ")), true, "runs of space and the ends are ignored");
eq(hits(c("subject", "contains", "diner"), { ...msg, subject: "DÎNER" }), true, "accents and case in the message are ignored");

// All versus any.
const two = [c("from", "contains", "zoe"), c("subject", "contains", "samedi")];
eq(planActions([rule(two, [star], { match: "all" })], msg).length, 0, "all: one failing condition fails the rule");
eq(planActions([rule(two, [star], { match: "any" })], msg).length, 1, "any: one holding condition is enough");
eq(planActions([rule(two, [star], { match: "whatever" })], msg).length, 0, "an unknown match is read as all");
eq(planActions([rule([c("subject", "contains", "x"), c("subject", "contains", "y")], [star], { match: "any" })], msg).length, 0, "any: none holding fails it");

// Order, and stop.
{
  const a = rule([c("from", "contains", "zoe")], [{ type: "category", value: "1" }], { position: 5 });
  const b = rule([c("from", "contains", "zoe")], [{ type: "pin", value: "" }], { position: 2 });
  const d = rule([c("from", "contains", "zoe")], [{ type: "read", value: "" }], { position: 9 });
  eq(types(planActions([a, d, b], msg)), ["pin", "category", "read"], "rules are tried by position, whatever order they are handed over in");
  eq(planActions([a, d, b], msg).map((p) => p.rule), [b.id, a.id, d.id], "each action names the rule it came from");
  const stop = { ...a, stop: 1 };
  eq(types(planActions([stop, d, b], msg)), ["pin", "category"], "stop: nothing after the matching rule is tried");
  const quiet = rule([c("from", "contains", "nobody")], [star], { position: 1, stop: 1 });
  eq(types(planActions([quiet, stop, d, b], msg)), ["pin", "category"], "a rule that does not match does not stop anything");
  const idle = rule([c("from", "contains", "zoe")], [], { position: 1, stop: 1 });
  eq(planActions([idle, d], msg).length, 0, "a matching rule with no action still stops the ones after it");
}

// Conflicts, settled in one place.
{
  const mv = (id, where, extra = {}) => rule([c("from", "contains", "zoe")], [{ type: "move", value: where }], { position: id, ...extra });
  eq(planActions([mv(1, "Work"), mv(2, "Home")], msg).map((a) => a.value), ["Work"], "two moves: the first wins");
  eq(planActions([mv(2, "Home"), mv(1, "Work")], msg).map((a) => a.value), ["Work"], "'first' is by position, not by the order handed over");
  const trash = rule([c("from", "contains", "zoe")], [{ type: "trash", value: "" }], { position: 3 });
  eq(types(planActions([mv(1, "Work"), trash], msg)), ["trash"], "Trash beats a move that came before it");
  eq(types(planActions([trash, mv(4, "Work")], msg)), ["trash"], "and one that comes after");
  eq(types(planActions([rule([c("from", "contains", "zoe")], [{ type: "move", value: "Work" }, { type: "trash", value: "" }, star])], msg)), ["trash", "star"], "within one rule too, and the rest still happens");
  eq(types(planActions([rule([c("from", "contains", "zoe")], [{ type: "trash", value: "" }, { type: "trash", value: "" }])], msg)), ["trash"], "two Trash actions are one");
  eq(planActions([rule([c("from", "contains", "zoe")], [{ type: "category", value: "2" }]), rule([c("from", "contains", "zoe")], [{ type: "category", value: "2" }])], msg).length, 1, "the same category twice is added once");
  eq(planActions([rule([c("from", "contains", "zoe")], [{ type: "category", value: "2" }, { type: "category", value: "3" }])], msg).map((a) => a.value), ["2", "3"], "different categories both stay");
  eq(types(planActions([rule([c("from", "contains", "zoe")], [{ type: "move", value: "Work" }]), trash], { ...msg, folder: "trash" })), [], "Trash still beats a move for a message already in Trash, which then has nothing left to do");
  eq(types(planActions([mv(1, "Work"), mv(2, "Home")], { ...msg, folder: "Work" })), [], "a first move that changes nothing still wins over the later one");
}

// What is already so is not done again.
{
  const all = rule([c("from", "contains", "zoe")], [star, { type: "read", value: "" }, { type: "pin", value: "" }, { type: "category", value: "4" }, { type: "move", value: "Archive" }]);
  eq(types(planActions([all], msg)), ["star", "read", "pin", "category", "move"], "an unhandled message gets all of it");
  eq(types(planActions([all], { ...msg, starred: 1, unread: 0, pinned: 1, cats: [4], folder: "archive" })), [], "a handled one gets none");
  eq(types(planActions([all], { ...msg, starred: 1, cats: [9] })), ["read", "pin", "category", "move"], "only what is missing");
}

// A rule this build cannot read is skipped, not a crash; its neighbours still act.
{
  const good = rule([c("from", "contains", "zoe")], [star], { position: 9 });
  const bad = [
    rule([c("sender", "contains", "zoe")], [star], { position: 1 }),
    rule([c("from", "matches", "zoe")], [star], { position: 2 }),
    rule([c("from", "contains", "zoe")], [{ type: "delete_forever", value: "" }], { position: 3 }),
    rule([c("from", "contains", "zoe")], [star, { type: "launder", value: "" }], { position: 4 }),
    rule([c("has_attachment", "contains", "yes")], [star], { position: 5 }),
    rule([c("importance", "is", "urgent")], [star], { position: 6 }),
    rule([c("from", "contains", "")], [star], { position: 7 }),
    rule([c("from", "contains", "zoe")], [{ type: "move", value: "" }], { position: 8 }),
  ];
  for (const b of bad) eq(types(planActions([b, good], msg)), ["star"], `skipped, and the next rule still acts (${b.conditions} ${b.actions})`);
  const stopper = rule([c("sender", "contains", "zoe")], [star], { position: 1, stop: 1 });
  eq(types(planActions([stopper, rule([c("from", "contains", "zoe")], [{ type: "pin", value: "" }], { position: 2 })], msg)), ["pin"], "a skipped rule does not stop the others, even with stop set");
}

// Rules that never act.
{
  eq(planActions([rule([c("from", "contains", "zoe")], [star], { enabled: 0 })], msg).length, 0, "a disabled rule never matches");
  eq(planActions([rule([], [star])], msg).length, 0, "an empty condition list never matches");
  eq(planActions([rule([c("from", "contains", "zoe")], [star], { enabled: 0, stop: 1 }), rule([c("from", "contains", "zoe")], [{ type: "pin", value: "" }], { position: 99 })], msg).length, 1, "a disabled rule does not stop the others");
  for (const [label, conditions] of [
    ["not JSON", "{{{"], ["an object, not a list", '{"field":"from"}'], ["null", "null"], ["a number", "7"], ["empty text", ""], ["undefined", undefined],
    ["a list of nulls", "[null]"], ["a list with a bare string", '["from"]'],
  ]) {
    eq(planActions([{ ...rule([], [star]), conditions }], msg).length, 0, `conditions stored as ${label}: skipped`);
  }
  eq(planActions([{ ...rule([c("from", "contains", "zoe")], []), actions: "not json" }], msg).length, 0, "actions that are not JSON: skipped");
  eq(planActions([{ ...rule([c("from", "contains", "zoe")], []), actions: '{"type":"star"}' }], msg).length, 0, "actions that are not a list: skipped");
  eq(planActions([], msg), [], "no rules, no plan");
  // Already parsed lists are accepted as they are.
  eq(types(planActions([{ ...rule([], []), conditions: [c("from", "contains", "zoe")], actions: [star] }], msg)), ["star"], "lists already parsed work too");
}
ok(Object.keys(ACTIONS).length === 6, "six actions");

/* ── routes, against a real SQLite ── */

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
const fresh = async () => {
  const DB = makeD1();
  const env = { DB, MAIL: makeR2() };
  await ensureSchema(env);
  return env;
};
const draft = (name, extra = {}) => ({
  name,
  match: "all",
  conditions: [{ field: "from", op: "contains", value: "news" }],
  actions: [{ type: "star" }],
  ...extra,
});

{
  const env = await fresh();
  const names = async () => (await call(env, "GET", "/api/rules")).body.rules.map((r) => r.name);
  eq(await names(), [], "a new database has no rules");
  const cat = (await call(env, "GET", "/api/categories")).body.categories[0];

  const made = await call(env, "POST", "/api/rules", draft("  Newsletters  ", {
    match: "any",
    conditions: [{ field: "from", op: "ends", value: " @news.example.com " }, { field: "has_attachment", op: "is", value: "Yes" }],
    actions: [{ type: "move", value: "Newsletters" }, { type: "category", value: cat.id }, { type: "star" }],
    stop: true,
  }));
  eq(made.status, 201, "create answers 201");
  const first = made.body.rules[0];
  eq([first.name, first.match, first.enabled, first.stop, first.n, first.last_error], ["Newsletters", "any", true, true, 0, ""], "the name is trimmed; a new rule is enabled, unrun and error-free");
  eq(first.conditions, [{ field: "from", op: "ends", value: "@news.example.com" }, { field: "has_attachment", op: "is", value: "yes" }], "conditions are stored cleaned, a choice folded");
  eq(first.actions, [{ type: "move", value: "Newsletters" }, { type: "category", value: String(cat.id) }, { type: "star", value: "" }], "actions are stored with their values as text");
  ok(made.body.catalog.fields.length === 8 && made.body.catalog.actions.length === 6, "the answer carries the catalog the editor is built from");

  for (const [label, body, why] of [
    ["no name", draft(""), "Give the rule a name"],
    ["no condition", draft("x", { conditions: [] }), "Add at least one condition"],
    ["no action", draft("x", { actions: [] }), "Add at least one action"],
    ["unknown field", draft("x", { conditions: [{ field: "sender", op: "is", value: "a" }] }), 'Condition "sender" is not complete'],
    ["operator the field lacks", draft("x", { conditions: [{ field: "importance", op: "contains", value: "high" }] }), 'Condition "Importance" is not complete'],
    ["empty text", draft("x", { conditions: [{ field: "from", op: "is", value: "  " }] }), 'Condition "From" is not complete'],
    ["choice outside its values", draft("x", { conditions: [{ field: "importance", op: "is", value: "urgent" }] }), 'Condition "Importance" is not complete'],
    ["unknown action", draft("x", { actions: [{ type: "expunge" }] }), 'Action "expunge" is not complete'],
    ["a move with no folder", draft("x", { actions: [{ type: "move", value: "" }] }), 'Action "Move to folder" is not complete'],
    ["a category that does not exist", draft("x", { actions: [{ type: "category", value: 9999 }] }), "That category no longer exists"],
    ["eleven conditions", draft("x", { conditions: Array(11).fill({ field: "from", op: "contains", value: "a" }) }), "A rule can have at most 10 conditions"],
  ]) {
    const r = await call(env, "POST", "/api/rules", body);
    eq([r.status, r.body.error], [400, why], `refused: ${label}`);
  }
  eq(await names(), ["Newsletters"], "a refused rule is not stored");

  await call(env, "POST", "/api/rules", draft("Second"));
  await call(env, "POST", "/api/rules", draft("Third"));
  eq(await names(), ["Newsletters", "Second", "Third"], "new rules go to the end");
  const ids = (await call(env, "GET", "/api/rules")).body.rules.map((r) => r.id);

  // Reorder: the ids as the list should be; a stranger is ignored and a missing one keeps its place after.
  eq((await call(env, "POST", "/api/rules/order", { ids: [ids[2], ids[0], 9999, ids[1]] })).body.rules.map((r) => r.name), ["Third", "Newsletters", "Second"], "order puts the rules as asked and ignores an id that is not one");
  eq((await call(env, "POST", "/api/rules/order", { ids: [ids[1]] })).body.rules.map((r) => r.name), ["Second", "Third", "Newsletters"], "a rule the list leaves out follows the ones it names");
  eq((await names()), ["Second", "Third", "Newsletters"], "and the order is kept");
  await call(env, "POST", "/api/rules", draft("Fourth"));
  eq((await names()).at(-1), "Fourth", "a rule created after a reorder still lands last");

  // Edit and switch.
  const off = await call(env, "PATCH", `/api/rules/${ids[0]}`, { enabled: false });
  eq(off.body.rules.find((r) => r.id === ids[0]).enabled, false, "the switch turns a rule off");
  eq(off.body.rules.find((r) => r.id === ids[0]).conditions.length, 2, "and leaves the rest of it alone");
  env.DB.raw.prepare("UPDATE rules SET last_error='boom' WHERE id=?").run(ids[0]);
  const edited = await call(env, "PATCH", `/api/rules/${ids[0]}`, draft("Renamed", { conditions: [{ field: "subject", op: "contains", value: "x" }] }));
  const got = edited.body.rules.find((r) => r.id === ids[0]);
  eq([got.name, got.enabled, got.last_error, got.conditions.length], ["Renamed", false, "", 1], "an edit keeps the switch, clears the old error and replaces the conditions");
  eq((await call(env, "PATCH", `/api/rules/${ids[0]}`, draft("", {}))).status, 400, "an edit is validated like a new rule");
  eq((await call(env, "PATCH", "/api/rules/9999", { enabled: true })).status, 404, "editing an unknown rule: 404");

  // A row from another build: shown as unreadable, still switchable and deletable.
  env.DB.raw.prepare(`INSERT INTO rules (name, enabled, position, "match", conditions, actions, created_at) VALUES ('Future', 1, 50, 'all', '[{"field":"weight","op":"is","value":"1"}]', '[{"type":"star"}]', 0)`).run();
  const future = (await call(env, "GET", "/api/rules")).body.rules.find((r) => r.name === "Future");
  eq([future.unreadable, future.conditions.length], [true, 1], "a rule with a field this build lacks is listed as unreadable");
  eq((await call(env, "PATCH", `/api/rules/${future.id}`, { enabled: false })).body.rules.find((r) => r.name === "Future").enabled, false, "and can still be switched off");
  eq((await call(env, "DELETE", `/api/rules/${future.id}`)).body.rules.some((r) => r.name === "Future"), false, "and deleted");
  env.DB.raw.prepare(`INSERT INTO rules (name, conditions, actions, created_at) VALUES ('Garbled', '{{', 'nope', 0)`).run();
  eq((await call(env, "GET", "/api/rules")).body.rules.find((r) => r.name === "Garbled").unreadable, true, "stored JSON that does not parse does not break the list");

  eq((await call(env, "DELETE", `/api/rules/${ids[2]}`)).body.rules.some((r) => r.id === ids[2]), false, "delete removes it");
  eq((await call(env, "DELETE", "/api/rules/9999")).status, 200, "deleting what is gone is fine");
}

/* ── running now, with the local actions (no iCloud needed) ── */
{
  const env = await fresh();
  const DB = env.DB;
  DB.raw.prepare("INSERT INTO accounts (id, provider, email, label, secret, created_at) VALUES ('a','icloud','me@example.com','','sealed',0)").run();
  const ins = DB.raw.prepare(
    "INSERT INTO messages (id, account_id, pid, mid, thread_key, folder, from_email, subject, date, att_names, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,0)"
  );
  // 45 in the inbox, newest first by number; every third is from the sender the rule wants.
  for (let i = 1; i <= 45; i++) ins.run(hex(i), "a", `p${i}`, `<${i}@x>`, `<t${i % 5}@x>`, "inbox", i % 3 === 0 ? "news@x.org" : "other@x.org", `s${i}`, 1000 + i, null);
  ins.run(hex(100), "a", "p100", "<100@x>", "", "archive", "news@x.org", "filed", 5000, null); // not in the inbox
  const cat = (await call(env, "GET", "/api/categories")).body.categories[1];
  await call(env, "POST", "/api/rules", draft("Tag news", { conditions: [{ field: "from", op: "is", value: "news@x.org" }], actions: [{ type: "category", value: cat.id }] }));
  await call(env, "POST", "/api/rules", draft("Pin news", { conditions: [{ field: "from", op: "is", value: "news@x.org" }], actions: [{ type: "pin" }] }));
  await call(env, "POST", "/api/rules", draft("Off", { enabled: false, conditions: [{ field: "from", op: "contains", value: "other" }], actions: [{ type: "pin" }] }));
  const [off] = (await call(env, "GET", "/api/rules")).body.rules.filter((r) => r.name === "Off");
  await call(env, "PATCH", `/api/rules/${off.id}`, { enabled: false });

  const total = { scanned: 0, changed: 0, calls: 0 };
  let cursor;
  for (;;) {
    const r = await call(env, "POST", "/api/rules/run", { cursor });
    total.calls++;
    total.scanned += r.body.scanned;
    total.changed += r.body.changed;
    ok(r.body.scanned <= 20, "a batch never looks at more than 20 messages");
    if (!r.body.next) break;
    cursor = r.body.next;
  }
  eq([total.calls, total.scanned, total.changed], [3, 45, 15], "45 inbox messages take three batches, and 15 of them were changed");
  eq(DB.raw.prepare("SELECT COUNT(*) n FROM message_categories WHERE category_id=?").get(cat.id).n, 15, "the category went on the 15 matching messages");
  eq(DB.raw.prepare("SELECT COUNT(*) n FROM message_categories WHERE message_id=?").get(hex(100)).n, 0, "and not on mail outside the inbox");
  // Pinning is by conversation: every message of a conversation with a match is pinned.
  const pinned = DB.raw.prepare("SELECT COUNT(*) n FROM messages WHERE pinned=1").get().n;
  ok(pinned > 15, `pinning the conversation pins its other messages too (${pinned})`);
  const rules = (await call(env, "GET", "/api/rules")).body.rules;
  // The 15 senders' messages fall in 5 conversations, and pinning one pins its
  // conversation, so only the first message of each makes a change.
  eq(rules.map((r) => [r.name, r.n]), [["Tag news", 15], ["Pin news", 5], ["Off", 0]], "each rule counts the messages it changed, and a disabled one counts none");
  ok(rules[0].last_at > 0 && rules[2].last_at === null, "and records when");

  const again = await call(env, "POST", "/api/rules/run", {});
  eq([again.body.changed, again.body.scanned], [0, 20], "running again changes nothing: what is done is not done twice");
  eq((await call(env, "GET", "/api/rules")).body.rules.map((r) => r.n), [15, 5, 0], "and counts nothing");
  eq((await call(env, "POST", "/api/rules/run", { cursor: { date: "x", id: "not-an-id" } })).body.scanned, 20, "a bad cursor starts from the top");

  // A body condition reads the stored text.
  env.MAIL.map.set("body/" + hex(7) + ".json", JSON.stringify({ html: "<p>Your invoice is attached</p>" }));
  await call(env, "POST", "/api/rules", draft("Invoices", { conditions: [{ field: "body", op: "contains", value: "INVOICE" }], actions: [{ type: "category", value: cat.id }] }));
  const run = await call(env, "POST", "/api/rules/run", {});
  eq(run.body.changed, 0, "the batch of the newest 20 does not reach message 7");
  let hit = 0;
  for (let cur = undefined; ; ) {
    const r = await call(env, "POST", "/api/rules/run", { cursor: cur });
    hit += r.body.changed;
    if (!r.body.next) break;
    cur = r.body.next;
  }
  eq(hit, 1, "a text condition finds the one message whose stored body says so");
  eq(DB.raw.prepare("SELECT COUNT(*) n FROM message_categories WHERE message_id=? AND category_id=?").get(hex(7), cat.id).n, 1, "and tags it");

  // Nothing enabled, nothing to do.
  for (const r of (await call(env, "GET", "/api/rules")).body.rules) await call(env, "PATCH", `/api/rules/${r.id}`, { enabled: false });
  eq((await call(env, "POST", "/api/rules/run", {})).body, { ok: true, scanned: 0, changed: 0, failed: 0, next: null }, "with every rule off, running looks at nothing");
}
