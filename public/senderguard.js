/**
 * Does this sender pose as somebody it is not? A pure function over the From
 * name and the From address, shared by the reader (window.SenderGuard) and the
 * tests, like sendguard.js is.
 *
 * It looks for three things, and warns only on those:
 *
 *   brand-name       the display name is a well-known brand, perhaps with a
 *                    role after it ("PayPal", "Microsoft account team"), and
 *                    the address is not at one of that brand's domains
 *   lookalike-domain the address's domain is one character from a brand's,
 *                    or is the brand with digits, hyphens or lookalike letters
 *                    put in (paypa1, pay-pal, rnicrosoft), or is the brand's
 *                    own name under a top level that is mostly spam
 *   name-is-address  the display name is itself an address or a web address,
 *                    and it is not the sender's
 *
 * A false alarm teaches people to ignore the bar, so each rule is narrow on
 * purpose. A display name counts as naming a brand only when it is nothing
 * but the brand and generic role words: "Amazonia Travel", "Dr. Apple" and
 * "Camille via LinkedIn" are not "Amazon", "Apple" and "LinkedIn". Whether
 * the sender is somebody you know is for the caller to decide; this does not
 * look at your contacts.
 */

/**
 * The brands phishing impersonates most.
 *
 *   names  What the display name says, lowercased words. "aws" is Amazon's.
 *   slds   The registered names it really sends from, under any top level
 *          that is not mostly abuse. So "amazon" covers amazon.com, amazon.fr
 *          and amazon.co.uk, and every subdomain of them. Not the free-mail
 *          domains of a brand's mailboxes (icloud.com, outlook.com, gmail.com):
 *          anyone can register an address there.
 */
export const BRANDS = [
  { brand: "Microsoft", names: ["microsoft", "office 365", "microsoft 365", "office365", "onedrive", "skype", "xbox"], slds: ["microsoft", "microsoftonline", "microsoft365", "office", "office365", "skype", "xbox", "windows", "azure", "sharepoint", "onedrive", "bing"] },
  { brand: "Apple", names: ["apple", "apple id", "icloud", "itunes", "app store", "apple music", "apple pay"], slds: ["apple", "itunes"] },
  { brand: "Google", names: ["google", "gmail", "youtube", "google workspace", "google drive", "google calendar", "google play"], slds: ["google", "youtube", "withgoogle"] },
  { brand: "Amazon", names: ["amazon", "amazon web services", "aws", "amazon prime", "prime video", "amazon pay"], slds: ["amazon", "amazonaws", "primevideo"] },
  { brand: "PayPal", names: ["paypal"], slds: ["paypal", "paypalobjects", "paypal-communication"] },
  { brand: "LinkedIn", names: ["linkedin"], slds: ["linkedin", "licdn"] },
  { brand: "Dropbox", names: ["dropbox"], slds: ["dropbox", "dropboxmail"] },
  { brand: "Facebook", names: ["facebook", "instagram", "meta business", "meta platforms"], slds: ["facebook", "facebookmail", "fb", "instagram", "meta", "metamail"] },
  { brand: "WhatsApp", names: ["whatsapp"], slds: ["whatsapp"] },
  { brand: "Netflix", names: ["netflix"], slds: ["netflix"] },
  { brand: "Adobe", names: ["adobe", "adobe sign", "adobe creative cloud"], slds: ["adobe", "adobesign", "echosign"] },
  { brand: "DHL", names: ["dhl", "dhl express"], slds: ["dhl"] },
  { brand: "FedEx", names: ["fedex"], slds: ["fedex"] },
  { brand: "UPS", names: ["ups"], slds: ["ups"] },
  { brand: "USPS", names: ["usps"], slds: ["usps"] },
  { brand: "La Poste", names: ["la poste", "colissimo", "chronopost"], slds: ["laposte", "colissimo", "chronopost", "lapostegroupe"] },
  { brand: "eBay", names: ["ebay"], slds: ["ebay", "ebaycdn"] },
  { brand: "DocuSign", names: ["docusign"], slds: ["docusign"] },
  { brand: "Zoom", names: ["zoom"], slds: ["zoom", "zoomgov"] },
  { brand: "Spotify", names: ["spotify"], slds: ["spotify"] },
  { brand: "Coinbase", names: ["coinbase"], slds: ["coinbase"] },
  { brand: "Binance", names: ["binance"], slds: ["binance"] },
  { brand: "Revolut", names: ["revolut"], slds: ["revolut"] },
];

/** Words that follow a brand in a sender name without making it somebody else. */
const ROLE_WORDS = new Set(
  ("support team security billing service services customer care account accounts notification notifications alert alerts " +
    "noreply reply no do not help helpdesk desk store order orders payment payments reward rewards shipping delivery " +
    "update updates verification verify admin administrator administration online mail email safety recovery center " +
    "centre department dept official inc corp corporation ltd llc 365 web cloud business pay id login signin sign in " +
    "confirmation invoice invoices statement statements refund refunds claim claims promo offers offer deals " +
    "subscription subscriptions renewal membership wallet portal info news newsletter marketing digital premium plus " +
    "developer developers partner partners seller sellers prime express parcel tracking com fr co uk net org de es it " +
    "nl us ca au the your my").split(" ")
);

/** Top levels brands do not use and phishing does. */
const RISKY_TLDS = new Set("tk ml ga cf gq xyz top click link support help online site store shop icu buzz work info biz cc ws pw su zip mov".split(" "));
/** Second-level suffixes, so that amazon.co.uk is amazon and not "co". */
const SECOND_LEVEL = new Set("co com org net gov ac edu or ne go".split(" "));
/** Top levels a display name written as a web address plausibly ends in. */
const NAME_TLDS = new Set("com net org fr de uk io co us eu info biz ch be nl es it ca au jp ru br se no dk fi pl pt gov edu me tv app dev ai".split(" "));

/** { sld, tld, domain } of a host: the registered name, what follows it, and both. */
export function registrable(host) {
  const labels = String(host || "").toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length < 2) return { sld: labels[0] || "", tld: "", domain: labels[0] || "" };
  const long = labels.length >= 3 && labels.at(-1).length === 2 && SECOND_LEVEL.has(labels.at(-2));
  const cut = long ? 3 : 2;
  const tail = labels.slice(-cut);
  return { sld: tail[0], tld: tail.slice(1).join("."), domain: tail.join(".") };
}

/** The word letters look alike in, with what is put in to disguise it taken out. */
const collapse = (s) =>
  s.replace(/rn/g, "m").replace(/vv/g, "w").replace(/-/g, "").replace(/[il]/g, "l");
const LEET = { 0: "o", 1: "l", 3: "e", 4: "a", 5: "s", 7: "t" };
const skeletons = (s) => [
  collapse(s.replace(/[013457]/g, (d) => LEET[d]).replace(/\d/g, "")),
  collapse(s.replace(/\d/g, "")),
];

/** One edit apart: a letter inserted, deleted, substituted or two swapped. `kinds` limits which. */
function oneEdit(a, b, substitution) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let i = 0;
    while (a[i] === b[i]) i++;
    if (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)) return true;
    return substitution && a.slice(i + 1) === b.slice(i + 1);
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < s.length && s[i] === l[i]) i++;
  return s.slice(i) === l.slice(i + 1);
}

const words = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** The brand a display name is, if it is one and nothing else. */
function brandNamed(name) {
  const w = words(name);
  if (!w.length || / via /i.test(` ${name} `)) return null;
  const body = w[0] === "the" ? w.slice(1) : w;
  let best = null;
  for (const b of BRANDS) {
    for (const alias of b.names) {
      const a = alias.split(" ");
      if (a.length <= body.length && a.every((x, i) => body[i] === x) && body.slice(a.length).every((x) => ROLE_WORDS.has(x))) {
        if (!best || a.length > best.len) best = { brand: b, len: a.length };
      }
    }
  }
  return best && best.brand;
}

const atBrand = (b, host) => {
  const r = registrable(host);
  return b.slds.includes(r.sld) && !RISKY_TLDS.has(r.tld.split(".").pop());
};

/** The brand a domain is dressed up as, if it is, and how. */
function lookalikeOf(host) {
  const r = registrable(host);
  if (!r.sld) return null;
  for (const b of BRANDS) {
    if (atBrand(b, host)) continue;
    const real = b.slds[0];
    // The brand's own name under a top level that is mostly spam.
    if (b.slds.includes(r.sld)) return { brand: b, real: `${real}.com`, how: "tld" };
    const mine = skeletons(r.sld);
    const theirs = collapse(real);
    if (r.sld.length >= 3 && mine.includes(theirs)) {
      return { brand: b, real: `${real}.com`, how: "disguised" };
    }
    // One edit. Short names (apple, zoom) take no substitution and no plural,
    // because ample, zoos and apples are words with sites of their own.
    if (real.length >= 5 && r.sld !== `${real}s` && oneEdit(r.sld, real, real.length >= 6)) {
      return { brand: b, real: `${real}.com`, how: "typo" };
    }
  }
  return null;
}

const ADDRESS = /^[^\s@<>"']+@([^\s@<>"']+\.[a-z]{2,})$/i;
const WEBADDR = /^(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9-]+\.)+([a-z]{2,}))\/?$/i;

/** What the display name claims to be an address of, or "". */
function nameAsHost(name) {
  const n = String(name || "").trim().replace(/^["']+|["']+$/g, "");
  const a = ADDRESS.exec(n);
  if (a && NAME_TLDS.has(a[1].split(".").pop().toLowerCase())) return a[1].toLowerCase();
  const w = WEBADDR.exec(n);
  return w && NAME_TLDS.has(w[2].toLowerCase()) ? w[1].toLowerCase() : "";
}

/**
 * What to say about this sender, as [{ kind, text }]; empty when there is
 * nothing to say. `text` is a sentence, with the real address in it.
 */
export function senderWarnings(fromName, fromEmail) {
  const email = String(fromEmail || "").trim().toLowerCase();
  const host = email.includes("@") ? email.split("@").pop() : "";
  if (!host) return [];
  const out = [];

  const named = brandNamed(fromName);
  if (named && !atBrand(named, host)) {
    out.push({ kind: "brand-name", text: `The sender's name says ${named.brand}, but the message came from ${email}, which is not one of ${named.brand}'s addresses.` });
  }

  const like = lookalikeOf(host);
  if (like) {
    const what =
      like.how === "tld"
        ? `${registrable(host).domain} borrows the name of ${like.brand.brand} on a domain it does not use`
        : `${registrable(host).domain} looks like ${like.real}, which belongs to ${like.brand.brand}, but is not it`;
    out.push({ kind: "lookalike-domain", text: `The address ${email} is at a look-alike domain: ${what}.` });
  }

  const claimed = nameAsHost(fromName);
  if (claimed && registrable(claimed).domain !== registrable(host).domain) {
    out.push({ kind: "name-is-address", text: `The sender's name shows ${String(fromName).trim()}, but the message came from ${email}.` });
  }
  return out;
}

// The reader reaches it from the page's own script.
if (typeof window !== "undefined") window.SenderGuard = { senderWarnings };
