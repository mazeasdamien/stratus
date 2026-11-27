/**
 * Rules, the pure half: what a rule can look at, what it can do, and which of
 * its actions a message earns. Nothing here touches the database or iCloud;
 * src/sorting.js stores the rules and carries the plan out.
 *
 * A rule is stored as a row whose conditions and actions are JSON lists:
 *
 *   conditions  [{ field, op, value }]   what the message must look like
 *   actions     [{ type, value }]        what is done to it
 *
 * Both lists are tables below, FIELDS and ACTIONS, so a new field or action is
 * one entry, and the editor in the client is built from the same tables the
 * server answers with rather than keeping a copy.
 *
 * What is stored may be older or newer than this build, or hand-edited, so
 * nothing read back is trusted: a rule with a field, an operator or an action
 * this build does not know is skipped whole, never half-applied.
 */

import { parseAddressList } from "./mime.js";

/** Lowercase, accents and combining marks removed, runs of space made one. */
export const fold = (s) =>
  String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The tests an operator can apply. Each gets every string the field offers
 * for this message (a sender is its address and its name; a message can have
 * several attachments) and the folded value, and says whether the condition
 * holds. "Does not" holds only when no candidate does.
 */
export const OPS = {
  contains: { label: "contains", test: (c, v) => c.some((x) => x.includes(v)) },
  not_contains: { label: "does not contain", test: (c, v) => !c.some((x) => x.includes(v)) },
  is: { label: "is", test: (c, v) => c.some((x) => x === v) },
  is_not: { label: "is not", test: (c, v) => !c.some((x) => x === v) },
  starts: { label: "starts with", test: (c, v) => c.some((x) => x.startsWith(v)) },
  ends: { label: "ends with", test: (c, v) => c.some((x) => x.endsWith(v)) },
};

const TEXT_OPS = ["contains", "not_contains", "is", "starts", "ends"];

/** An address header as the strings worth comparing: each address, each name, and the line itself. */
const people = (line) => [...parseAddressList(line).flatMap((a) => [a.email, a.name]), line];

/**
 * What a rule can look at.
 *
 *   kind    "text" compares what is typed; "choice" picks from `values`.
 *   read    The message's strings for this field (unfolded).
 *   values  For a choice: [value, label] pairs.
 *
 * `body` is the message text when the caller has it, the preview otherwise.
 */
export const FIELDS = {
  from: {
    label: "From",
    kind: "text",
    ops: TEXT_OPS,
    read: (m) => [m.from_email, m.from_name, `${m.from_name || ""} <${m.from_email || ""}>`],
  },
  to: { label: "To", kind: "text", ops: TEXT_OPS, read: (m) => people(m.to_line || "") },
  cc: { label: "Cc", kind: "text", ops: TEXT_OPS, read: (m) => people(m.cc_line || "") },
  subject: { label: "Subject", kind: "text", ops: TEXT_OPS, read: (m) => [m.subject] },
  body: { label: "Text", kind: "text", ops: ["contains", "not_contains"], read: (m) => [m.body ?? m.snippet] },
  attachment: {
    label: "Attachment name",
    kind: "text",
    ops: TEXT_OPS,
    read: (m) => String(m.att_names || "").split("\n").filter(Boolean),
  },
  has_attachment: {
    label: "Has attachment",
    kind: "choice",
    ops: ["is"],
    values: [["yes", "Yes"], ["no", "No"]],
    read: (m) => [String(m.att_names || "").trim() ? "yes" : "no"],
  },
  importance: {
    label: "Importance",
    kind: "choice",
    ops: ["is", "is_not"],
    values: [["high", "High"], ["normal", "Normal"], ["low", "Low"]],
    read: (m) => [Number(m.importance) === 1 ? "high" : Number(m.importance) === -1 ? "low" : "normal"],
  },
};

const sameFolder = (m, v) => fold(m.folder) === fold(v);
const set = (v) => v !== undefined && v !== null;

/**
 * What a rule can do.
 *
 *   value  "folder" or "category" when the action needs one, null when not.
 *   via    "imap" is done at iCloud so every device agrees; "local" only here.
 *   noop   Whether the message already is how the action would leave it, told
 *          only from the fields the caller gave: an unknown state is not a no-op.
 */
export const ACTIONS = {
  move: { label: "Move to folder", value: "folder", via: "imap", noop: (m, v) => set(m.folder) && sameFolder(m, v) },
  category: {
    label: "Add category",
    value: "category",
    via: "local",
    noop: (m, v) => Array.isArray(m.cats) && m.cats.includes(Number(v)),
  },
  star: { label: "Star", value: null, via: "imap", noop: (m) => set(m.starred) && Number(m.starred) === 1 },
  read: { label: "Mark as read", value: null, via: "imap", noop: (m) => set(m.unread) && Number(m.unread) === 0 },
  pin: { label: "Pin", value: null, via: "local", noop: (m) => set(m.pinned) && Number(m.pinned) === 1 },
  trash: { label: "Move to Trash", value: null, via: "imap", noop: (m) => set(m.folder) && sameFolder(m, "trash") },
};

/** What the client needs to build the editor: the two tables, without their code. */
export const catalog = () => ({
  fields: Object.entries(FIELDS).map(([id, f]) => ({ id, label: f.label, kind: f.kind, ops: f.ops, values: f.values || null })),
  ops: Object.fromEntries(Object.entries(OPS).map(([id, o]) => [id, o.label])),
  actions: Object.entries(ACTIONS).map(([id, a]) => ({ id, label: a.label, value: a.value })),
});

/** A condition this build understands and can evaluate, or null. */
export function readCondition(c) {
  const f = FIELDS[c?.field];
  if (!f || !f.ops.includes(c.op) || !OPS[c.op]) return null;
  const value = fold(c.value);
  if (f.kind === "choice" ? !f.values.some(([v]) => v === value) : !value) return null;
  return { field: c.field, op: c.op, value };
}

/** An action this build understands, or null. A move needs a folder, a category one to add. */
export function readAction(a) {
  const def = ACTIONS[a?.type];
  if (!def) return null;
  if (!def.value) return { type: a.type, value: "" };
  const value = String(a.value ?? "").trim();
  return value ? { type: a.type, value } : null;
}

/** A stored list: already an array, or JSON text for one; anything else is no list. */
const list = (v) => {
  if (Array.isArray(v)) return v;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * A stored rule in the form planning uses, or null when it must be skipped:
 * unreadable JSON, no condition, or any condition or action this build does
 * not know. A rule with no conditions never matches rather than matching all.
 */
export function readRule(row) {
  const conds = list(row?.conditions);
  const acts = list(row?.actions);
  if (!conds?.length || !acts) return null;
  const conditions = conds.map(readCondition);
  const actions = acts.map(readAction);
  if (conditions.includes(null) || actions.includes(null)) return null;
  return {
    id: row.id,
    enabled: !!Number(row.enabled),
    match: row.match === "any" ? "any" : "all",
    conditions,
    actions,
    stop: !!Number(row.stop),
  };
}

/** Whether the message satisfies the rule's conditions. */
function matches(rule, m) {
  const holds = (c) => OPS[c.op].test(FIELDS[c.field].read(m).map(fold), c.value);
  return rule.match === "any" ? rule.conditions.some(holds) : rule.conditions.every(holds);
}

/**
 * The one place conflicts between actions are settled. The actions arrive in
 * rule order, every rule that matched having contributed its own.
 *
 *   - Trash beats a move, whichever rule asked first; with no Trash, the first
 *     move wins and later ones are dropped.
 *   - The same action twice is done once.
 *   - An action the message is already in the state of is dropped, so running
 *     rules over mail they have handled changes nothing and counts nothing.
 */
function settle(picked, m) {
  const trash = picked.find((a) => a.type === "trash");
  const out = [];
  const seen = new Set();
  let moved = false;
  for (const a of picked) {
    if (a.type === "move") {
      if (trash || moved) continue;
      moved = true;
    }
    if (a.type === "trash" && a !== trash) continue;
    const key = `${a.type}\0${fold(a.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (ACTIONS[a.type].noop(m, a.value)) continue;
    out.push(a);
  }
  return out;
}

/**
 * What would be done to this message, in order, as [{ rule, type, value }].
 *
 * `rules` are stored rows, in any order; they are tried by position. A rule
 * that is disabled, unreadable or has nothing to match never acts. A matching
 * rule marked `stop` is the last one tried.
 *
 * `message` is a messages row, with `body` (the text) and `cats` (category
 * ids) when the caller has them. Planning only reads it.
 */
export function planActions(rules, message) {
  const ordered = [...rules].sort((a, b) => Number(a.position) - Number(b.position) || Number(a.id) - Number(b.id));
  const picked = [];
  for (const row of ordered) {
    const rule = readRule(row);
    if (!rule || !rule.enabled || !matches(rule, message)) continue;
    for (const a of rule.actions) picked.push({ rule: rule.id, ...a });
    if (rule.stop) break;
  }
  return settle(picked, message);
}

/** Whether any rule that could act looks at the message text, so a caller can skip fetching bodies. */
export const needsBody = (rules) =>
  rules.some((row) => {
    const r = readRule(row);
    return r && r.enabled && r.conditions.some((c) => c.field === "body");
  });

/**
 * A rule as the API takes it, cleaned, or { error } naming what is wrong.
 * Stricter than readRule: what is stored should always be readable, and the
 * reading side is only lenient for what an older or newer build left behind.
 */
export function cleanRule(b, categoryIds = null) {
  const name = String(b?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!name) return { error: "Give the rule a name" };
  const conds = Array.isArray(b.conditions) ? b.conditions : [];
  if (!conds.length) return { error: "Add at least one condition" };
  if (conds.length > 10) return { error: "A rule can have at most 10 conditions" };
  const acts = Array.isArray(b.actions) ? b.actions : [];
  if (!acts.length) return { error: "Add at least one action" };
  if (acts.length > 8) return { error: "A rule can have at most 8 actions" };

  const conditions = [];
  for (const c of conds) {
    const r = readCondition({ ...c, value: String(c?.value ?? "").slice(0, 200) });
    if (!r) return { error: `Condition "${FIELDS[c?.field]?.label || c?.field}" is not complete` };
    // The text as typed, not folded: the editor shows it back.
    conditions.push({ field: r.field, op: r.op, value: FIELDS[r.field].kind === "choice" ? r.value : String(c.value).trim().slice(0, 200) });
  }
  const actions = [];
  for (const a of acts) {
    const r = readAction({ ...a, value: String(a?.value ?? "").slice(0, 100) });
    if (!r) return { error: `Action "${ACTIONS[a?.type]?.label || a?.type}" is not complete` };
    if (r.type === "category") {
      if (!/^\d+$/.test(r.value) || (categoryIds && !categoryIds.has(Number(r.value)))) return { error: "That category no longer exists" };
    }
    actions.push(r);
  }
  return { name, match: b.match === "any" ? "any" : "all", conditions, actions, stop: b.stop ? 1 : 0 };
}
