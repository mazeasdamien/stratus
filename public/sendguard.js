/**
 * Two questions worth asking before a message goes, as pure functions.
 *
 * A module of its own, loaded by the page and imported by test/, so the thing
 * the tests pin down is the thing the page runs. It is a module and not part
 * of index.html's script for that reason alone: the page script is one string
 * that nothing can import.
 *
 *   lookalikes   Is a recipient a typo of someone you already write to?
 *   exposure     Does this message show many outside addresses to each other?
 *
 * Neither looks at the message. They are given addresses, and the addresses
 * you know, and answer from those.
 */

/**
 * Providers anybody can have an address at. Two of them being a character
 * apart says nothing about the people behind them, and your own address at
 * one is not "your domain": a thousand strangers share icloud.com.
 */
export const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "outlook.fr", "outlook.de", "hotmail.com", "hotmail.fr", "hotmail.de",
  "hotmail.co.uk", "live.com", "live.fr", "msn.com", "icloud.com", "me.com", "mac.com", "yahoo.com", "yahoo.fr",
  "yahoo.co.uk", "ymail.com", "aol.com", "gmx.com", "gmx.net", "gmx.de", "gmx.fr", "gmx.at", "proton.me",
  "protonmail.com", "pm.me", "mail.com", "zoho.com", "free.fr", "orange.fr", "wanadoo.fr", "sfr.fr", "laposte.net",
  "web.de", "t-online.de", "yandex.com", "mail.ru", "qq.com", "163.com", "fastmail.com", "hey.com", "tutanota.com",
  "tuta.io", "bluewin.ch", "btinternet.com", "comcast.net", "att.net", "verizon.net",
]);

export const domainOf = (addr) => String(addr || "").toLowerCase().split("@").pop();
const localOf = (addr) => String(addr || "").toLowerCase().split("@")[0];
const norm = (addr) => String(addr || "").trim().toLowerCase();

/**
 * True when the two strings differ by exactly one edit: a character
 * inserted, deleted or substituted, or two neighbours swapped.
 */
export function oneAway(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let i = 0;
    while (a[i] === b[i]) i++;
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < s.length && s[i] === l[i]) i++;
  return s.slice(i) === l.slice(i + 1);
}

/**
 * Recipients that look like somebody you know, and are not.
 *
 * A recipient is flagged when it is neither you nor anyone in `known`, and
 * either its domain is one character from the domain of someone you know
 * (acme.com written as acme.co, or amce.com), or it is at the same domain as
 * someone you know with a name one character from theirs (john@ and jon@).
 * Two free-mail domains are never compared with each other, and a domain
 * somebody you know already uses is not a typo of anything. Short names and
 * short domains are left out, because one edit between "al" and "ed" is not
 * a resemblance.
 *
 * Returns [{ address, resembles, part }], part being "domain" or "name".
 */
export function lookalikes(recipients, known, own = []) {
  const mine = new Set(own.map(norm));
  const people = [...new Set([...known.map(norm), ...mine])].filter((a) => a.includes("@"));
  const knownSet = new Set(people);
  const domains = new Set(people.map(domainOf));
  const out = [];
  for (const raw of recipients) {
    const addr = norm(raw);
    if (!addr.includes("@") || knownSet.has(addr)) continue;
    const dom = domainOf(addr);
    const local = localOf(addr);
    let hit = null;
    if (!domains.has(dom) && dom.length >= 6) {
      for (const other of people) {
        const d = domainOf(other);
        if (d.length < 6 || (FREEMAIL.has(dom) && FREEMAIL.has(d))) continue;
        if (oneAway(dom, d)) {
          // The one at the same name, when there is one: it is the likelier mistake.
          hit = { address: addr, resembles: people.find((p) => domainOf(p) === d && localOf(p) === local) || other, part: "domain" };
          break;
        }
      }
    }
    if (!hit && domains.has(dom)) {
      for (const other of people) {
        const l = localOf(other);
        if (domainOf(other) !== dom || Math.min(l.length, local.length) < 3 || Math.max(l.length, local.length) < 4) continue;
        if (oneAway(local, l)) {
          hit = { address: addr, resembles: other, part: "name" };
          break;
        }
      }
    }
    if (hit) out.push(hit);
  }
  return out;
}

/**
 * Many outside addresses, shown to each other.
 *
 * Five or more recipients in To and Cc together, outside your own domains,
 * across at least two domains. Five at one company is a team; five at five
 * is a list. Bcc is not passed in: it is the way out of this. Free-mail
 * domains are never yours, whoever you are at one.
 *
 * Returns null, or { outside, domains }.
 */
export function exposure(recipients, ownAddresses) {
  const mine = new Set(ownAddresses.map(domainOf).filter((d) => d && !FREEMAIL.has(d)));
  const seen = new Set(ownAddresses.map(norm));
  const outside = [];
  for (const raw of recipients) {
    const addr = norm(raw);
    if (!addr.includes("@") || seen.has(addr)) continue;
    seen.add(addr);
    if (!mine.has(domainOf(addr))) outside.push(addr);
  }
  const domains = [...new Set(outside.map(domainOf))];
  return outside.length >= 5 && domains.length >= 2 ? { outside, domains } : null;
}

// The page reaches them from its own script.
if (typeof window !== "undefined") window.SendGuard = { lookalikes, exposure, oneAway, FREEMAIL };
