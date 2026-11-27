/**
 * The search box's language: words, "phrases", -words and key:value operators
 * → SQL fragments over `messages m`.
 *
 * Pure, so it can be tested against a real SQLite without a Worker. Nothing
 * the user types is ever spliced into SQL: values travel as bound parameters,
 * and what goes into an FTS5 MATCH is only quoted runs of letters and digits.
 * FTS5's own query language (quotes, colons, carets, hyphens, AND/OR/NOT) is
 * therefore unreachable from the box, which is why an address or a URL pasted
 * into it is a search and not a syntax error.
 *
 * Anything that is not understood is searched as plain words instead of being
 * refused: a person who types "re: invoice" or pastes a link wants results.
 */

const DAY_MS = 86_400_000;

// One token: optional "-", optional "key:", then a "quoted run" or a bare word.
// An odd quote is dropped before this runs, so a quote here always has a mate.
const TOKEN = /(-?)(?:([a-z]+):)?(?:"([^"]*)"|([^\s"]+))/gi;

const words = (s) => String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

// Every term is quoted, so a word that happens to be an FTS5 keyword (NEAR,
// AND, NOT) is only ever a word. The star makes the last one a prefix, so
// "lily" finds "Lilyn" while you are still typing.
const phrase = (ws, prefix) => `"${ws.join(" ")}"${prefix ? "*" : ""}`;

// Escaped, so a search for "100%" or "a_b" means those characters and not
// LIKE's wildcards.
const LIKE = " LIKE ? ESCAPE '\\'";
const contains = (v) => `%${v.replace(/[\\%_]/g, "\\$&")}%`;

/** Name or address, in any of the given columns, contains the value. */
const person = (...columns) => (v) => ({
  where: `(${columns.map((c) => c + LIKE).join(" OR ")})`,
  values: columns.map(() => contains(v)),
});

/**
 * One column of the full-text index. `starts` matches the start of the last
 * word wherever the token sits in the line, for values that are rarely typed
 * whole: a name, a piece of an address.
 */
const column = (name, { starts = false } = {}) => (v, { prefix }) => {
  const ws = words(v);
  return ws.length ? { match: `${name} : ${phrase(ws, starts || prefix)}` } : null;
};

const flag = (where) => ({ where });

const IS = {
  unread: flag("m.unread=1"),
  read: flag("m.unread=0"),
  flagged: flag("m.starred=1"),
  starred: flag("m.starred=1"),
  // An open follow-up on this very message (src/followup.js).
  followup: flag("m.id IN (SELECT message_id FROM followups)"),
  // A conversation is pinned when any of its messages is (src/categories.js).
  pinned: flag("(m.pinned=1 OR (m.thread_key<>'' AND m.thread_key IN (SELECT thread_key FROM messages WHERE pinned=1 AND thread_key<>'')))"),
  important: flag("m.importance=1"),
};

const IMPORTANCE = { high: 1, normal: 0, low: -1 };

/**
 * Midnight of a YYYY-MM-DD day in the reader's zone, as epoch ms; null for
 * anything that is not a real date.
 *
 * `tz` is minutes as Date#getTimezoneOffset reports them: UTC minus local, so
 * Paris in summer is -120. The offset is the one in force now, so a day that
 * lies across a daylight-saving change is an hour out at its edges.
 */
function dayStart(v, tz) {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(v);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  // A 31st of February rolls over into March; refuse it rather than guess.
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return t.getTime() + tz * 60_000;
}

const onDate = (make) => (v, { tz }) => {
  const t = dayStart(v, tz);
  return t === null ? null : make(t);
};

/**
 * One entry per key: given the value and the context, either null (not a
 * valid use, so the whole token is searched as words) or a fragment:
 * `where` + `values` for SQL over `m`, or `match` for the full-text index.
 */
export const OPERATORS = {
  // Through the index, which holds every sender's name and address. A LIKE
  // over the two columns read the whole mailbox for each letter typed after
  // "from:", and D1 bills every row read. Recipients are not in the index, so
  // to: and cc: still pay that.
  from: column("sender", { starts: true }),
  to: person("m.to_line"),
  cc: person("m.cc_line"),
  subject: column("subject"),
  body: column("body"),
  // NULL means the message predates attachment names and has not been looked
  // at yet (see backfillAttachments), so it matches neither of these.
  has: (v) => (v.toLowerCase() === "attachment" ? flag("m.att_names<>''") : null),
  attachment: (v) => ({ where: `m.att_names${LIKE}`, values: [contains(v)] }),
  is: (v) => (Object.hasOwn(IS, v.toLowerCase()) ? IS[v.toLowerCase()] : null),
  // By name, whatever the name is: the table's collation ignores case. A name
  // no category has finds nothing, as it would for any other value.
  category: (v) => ({
    where: "m.id IN (SELECT mc.message_id FROM message_categories mc JOIN categories c ON c.id=mc.category_id WHERE c.name=?)",
    values: [v],
  }),
  importance: (v) => (Object.hasOwn(IMPORTANCE, v.toLowerCase()) ? { where: "m.importance=?", values: [IMPORTANCE[v.toLowerCase()]] } : null),
  // after: includes that day, before: stops short of it, as in most mail
  // clients.
  after: onDate((t) => ({ where: "m.date>=?", values: [t] })),
  before: onDate((t) => ({ where: "m.date<?", values: [t] })),
  on: onDate((t) => ({ where: "m.date>=? AND m.date<?", values: [t, t + DAY_MS] })),
};

/**
 * @param {string} term what was typed, already trimmed and capped by the caller
 * @param {{ tzOffsetMin?: number|string|null }} [opts] the reader's zone, in
 *   Date#getTimezoneOffset minutes; anything unusable is read as UTC
 * @returns {{ where: string[], values: any[] }} conditions to AND onto a query
 *   over `messages m`, with their bound values in the same order
 */
export function parseSearch(term, { tzOffsetMin } = {}) {
  const raw = String(term ?? "");
  const off = Number(tzOffsetMin ?? 0);
  const tz = Number.isFinite(off) && Math.abs(off) <= 840 ? Math.round(off) : 0;

  // An unterminated quote has nothing to mate with; its words are plain words.
  let src = raw;
  if ((src.match(/"/g) || []).length % 2) {
    const i = src.lastIndexOf('"');
    src = src.slice(0, i) + src.slice(i + 1);
  }

  const where = [];
  const values = [];
  const positive = [];
  const negative = [];

  const tokens = [...src.matchAll(TOKEN)];
  tokens.forEach(([whole, minus, key, quoted, bare], i) => {
    // The token being typed right now gets the prefix star; one in the middle
    // of the line is finished.
    const prefix = i === tokens.length - 1 && quoted === undefined;
    const op = key && !minus && Object.hasOwn(OPERATORS, key.toLowerCase()) ? OPERATORS[key.toLowerCase()] : null;
    // An empty value (to:"") would match everything; it is not an operator.
    const value = (quoted ?? bare).trim();
    const hit = op && value ? op(value, { tz, prefix }) : null;
    if (hit?.where) {
      where.push(hit.where);
      values.push(...(hit.values ?? []));
      return;
    }
    if (hit?.match) {
      positive.push(hit.match);
      return;
    }

    // Plain text: an unknown key, a malformed value, or no key at all.
    const ws = words(minus ? whole.slice(1) : whole);
    if (!ws.length) return;
    if (minus) negative.push(phrase(ws, false));
    else if (quoted !== undefined && !key) positive.push(phrase(ws, false));
    else ws.forEach((w, j) => positive.push(phrase([w], prefix && j === ws.length - 1)));
  });

  if (positive.length) {
    where.push("m.id IN (SELECT id FROM search WHERE search MATCH ?)");
    values.push(positive.join(" AND "));
  }
  // FTS5's NOT is binary ("a NOT b"), so a query of only negatives has no left
  // side to hang it on. Each leaves-out is its own subquery instead, which
  // works with or without anything to the left.
  for (const n of negative) {
    where.push("m.id NOT IN (SELECT id FROM search WHERE search MATCH ?)");
    values.push(n);
  }

  if (!where.length) {
    // Nothing the index can match (punctuation only, say): fall back to the
    // headers, as the search always has.
    where.push(`(m.subject${LIKE} OR m.from_email${LIKE} OR m.from_name${LIKE})`);
    const like = contains(raw);
    values.push(like, like, like);
  }
  return { where, values };
}
