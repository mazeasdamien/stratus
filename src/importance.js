/**
 * Message importance: what the sender marked it, and what we mark ours.
 *
 * 1 is high, -1 is low, 0 is normal. Mail clients disagree on how to say it,
 * so three headers are read and the first one present decides:
 *
 *   Importance: high | normal | low          (RFC 2156, what Apple Mail and Outlook write)
 *   X-Priority: 1 (Highest) .. 5 (Lowest)    (older, still the commonest)
 *   X-MSMail-Priority: High | Normal | Low   (Outlook)
 *
 * X-Priority 1 and 2 are high, 4 and 5 are low, 3 is normal.
 */

const WORDS = { high: 1, urgent: 1, normal: 0, low: -1, "non-urgent": -1 };

/** @returns {1|0|-1|null} null when the header says nothing we understand */
function fromWord(v) {
  const w = String(v ?? "").trim().toLowerCase();
  return Object.hasOwn(WORDS, w) ? WORDS[w] : null;
}

function fromPriority(v) {
  const n = parseInt(String(v ?? "").trim(), 10);
  if (!(n >= 1 && n <= 5)) return null;
  return n <= 2 ? 1 : n >= 4 ? -1 : 0;
}

/** Parsed headers (lowercase names, as parseHeaders returns them) → -1, 0 or 1. */
export function importanceFromHeaders(h) {
  const found = fromWord(h?.importance) ?? fromPriority(h?.["x-priority"]) ?? fromWord(h?.["x-msmail-priority"]);
  return found ?? 0;
}

/** Whatever a request sent → -1, 0 or 1; anything else is normal. */
export function importanceOf(v) {
  const n = Number(v);
  return n > 0 ? 1 : n < 0 ? -1 : 0;
}

/** The header lines that say it. Normal says nothing, as most mail does. */
export function importanceLines(importance) {
  const n = importanceOf(importance);
  if (n > 0) return ["Importance: high", "X-Priority: 1 (Highest)", "X-MSMail-Priority: High"];
  if (n < 0) return ["Importance: low", "X-Priority: 5 (Lowest)", "X-MSMail-Priority: Low"];
  return [];
}
