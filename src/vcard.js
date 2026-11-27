/**
 * Reading and writing vCards. Pure: bytes or text in, plain objects out, no
 * database and no Worker API.
 *
 * A contact here is the part of a card this app keeps:
 *
 *   { uid, name, given, family, org, title,
 *     emails: [{ type, value }], phones: [{ type, value }],
 *     address, birthday, notes }
 *
 * Everything else a card can carry (photos, URLs, categories, X- properties)
 * is read past and dropped. A vCard file is somebody else's bytes, so nothing
 * in here throws on a malformed one: a line that makes no sense is skipped, a
 * card with nothing usable is counted, and every field is capped.
 *
 * Read: 2.1, 3.0 and 4.0, many cards to a file, folded lines, escapes,
 * quoted-printable with a CHARSET, and grouped properties (item1.EMAIL).
 * Written: 3.0, which is what Apple Contacts, Google and Outlook all take.
 */

const LIMIT = { name: 200, org: 200, title: 200, address: 1000, notes: 5000, email: 200, phone: 60, label: 24, uid: 200 };

/** Per card. Past this the rest are ignored, not an error. */
const MAX_LIST = 20;

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** One line, no control characters, capped. */
const line = (v, n) => String(v ?? "").replace(CONTROL, "").replace(/\s+/g, " ").trim().slice(0, n);

/** Several lines allowed: an address or a note. */
const block = (v, n) =>
  String(v ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim()
    .slice(0, n);

export const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s ?? "").trim());

/** What a person calls the number or the address: work, home, mobile. */
function cleanLabel(t) {
  return String(t ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .trim()
    .slice(0, LIMIT.label);
}

/** YYYY-MM-DD, or --MM-DD for a birthday with no year, or nothing. */
export function cleanBirthday(v) {
  const s = String(v ?? "").trim();
  const full = /^(\d{4})-?(\d{2})-?(\d{2})(?:$|[T ])/.exec(s);
  if (full) return validDay(full[2], full[3]) ? `${full[1]}-${full[2]}-${full[3]}` : "";
  const bare = /^--(\d{2})-?(\d{2})$/.exec(s);
  return bare && validDay(bare[1], bare[2]) ? `--${bare[1]}-${bare[2]}` : "";
}
const validDay = (m, d) => +m >= 1 && +m <= 12 && +d >= 1 && +d <= 31;

function cleanList(list, kind) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    let value = line(item && typeof item === "object" ? item.value : item, kind === "email" ? LIMIT.email : LIMIT.phone);
    if (kind === "email") {
      value = value.toLowerCase();
      if (!isEmail(value)) continue;
    } else if (!/\d/.test(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({ type: cleanLabel(item && typeof item === "object" ? item.type : ""), value });
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

/**
 * The one place a contact is shaped, for a card out of a file and for JSON out
 * of the editor alike: the same caps and the same idea of what is valid.
 */
export function cleanContact(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const given = line(r.given, LIMIT.name);
  const family = line(r.family, LIMIT.name);
  return {
    uid: line(r.uid, LIMIT.uid),
    name: line(r.name, LIMIT.name) || line(`${given} ${family}`, LIMIT.name),
    given,
    family,
    org: line(r.org, LIMIT.org),
    title: line(r.title, LIMIT.title),
    emails: cleanList(r.emails, "email"),
    phones: cleanList(r.phones, "phone"),
    address: block(r.address, LIMIT.address),
    birthday: cleanBirthday(r.birthday),
    notes: block(r.notes, LIMIT.notes),
  };
}

/** A card that says nothing is not a contact. */
export const hasContent = (c) => Boolean(c.name || c.org || c.emails.length || c.phones.length);

/* ── reading ── */

/**
 * Text out of a file's bytes. A BOM names its encoding; without one the bytes
 * are UTF-8 if they are valid UTF-8, and otherwise Windows-1252, which is what
 * an Outlook export written on a Western machine is.
 */
export function decodeBytes(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return new TextDecoder("windows-1252").decode(b);
  }
}

/** A charset name a TextDecoder knows, or UTF-8. */
function decoderFor(charset) {
  try {
    return new TextDecoder(String(charset || "utf-8").trim().replace(/^"|"$/g, ""));
  } catch {
    return new TextDecoder("utf-8");
  }
}

/** Quoted-printable to text, the bytes read as `charset`. */
function qpDecode(s, charset) {
  const bytes = [];
  const enc = new TextEncoder();
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "=" && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...enc.encode(c));
  }
  const raw = new Uint8Array(bytes);
  // No CHARSET on a 2.1 card means whatever the sender's machine used: UTF-8
  // when it is valid as that, Windows-1252 when it is not.
  if (!charset) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      return new TextDecoder("windows-1252").decode(raw);
    }
  }
  return decoderFor(charset).decode(raw);
}

/**
 * Splits on `sep`, but not after a backslash and, for a property header, not
 * inside double quotes. A value is split with `quotes` off: a quote mark in a
 * name (5" pipe) is text there, not the start of a quoted string.
 */
function splitOutside(s, sep, quotes = true) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      cur += c + s[++i];
      continue;
    }
    if (quotes && c === '"') quoted = !quoted;
    if (c === sep && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const unquote = (s) => s.trim().replace(/^"(.*)"$/s, "$1");

/** \n and \N are a line break; \, \; \\ and \: are the character itself. */
const unescape = (s) =>
  s.replace(/\\(.)/gs, (m, c) => (c === "n" || c === "N" ? "\n" : /[,;\\:]/.test(c) ? c : m));

/** One unfolded line as { group, name, params, value }, or null if it is not a property. */
function parseProperty(text) {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') quoted = !quoted;
    else if (text[i] === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 1) return null;
  const [first, ...rest] = splitOutside(text.slice(0, colon), ";");
  const dot = first.lastIndexOf(".");
  const params = {};
  const add = (k, v) => (params[k] ||= []).push(v);
  for (const p of rest) {
    const eq = p.indexOf("=");
    if (eq < 0) {
      // vCard 2.1 writes TYPE and ENCODING values bare: `TEL;CELL;VOICE`.
      const bare = unquote(p).toUpperCase();
      if (!bare) continue;
      if (/^(QUOTED-PRINTABLE|BASE64|B|8BIT|7BIT)$/.test(bare)) add("ENCODING", bare);
      else add("TYPE", bare);
    } else {
      const key = p.slice(0, eq).trim().toUpperCase();
      for (const v of splitOutside(p.slice(eq + 1), ",")) {
        // 4.0 quotes the whole list: TYPE="cell,voice".
        for (const one of key === "TYPE" ? unquote(v).split(",") : [unquote(v)]) add(key, one.trim());
      }
    }
  }
  return {
    group: dot >= 0 ? first.slice(0, dot).toLowerCase() : "",
    name: first.slice(dot + 1).trim().toUpperCase(),
    params,
    value: text.slice(colon + 1),
  };
}

/** Apple writes a custom label as `_$!<Mobile>!$_` on the property's group. */
const groupLabel = (v) => /^_\$!<(.*)>!\$_$/.exec(v)?.[1] ?? v;

/** The first TYPE worth showing: not the ones that only say it is an address or a number. */
function typeOf(params) {
  const t = (params.TYPE || []).find((x) => !/^(INTERNET|PREF|VOICE|X400|MSG|PARCEL|POSTAL)$/i.test(x));
  return t ? cleanLabel(t) : "";
}

/** Decodes a property's raw value into text, honouring ENCODING and CHARSET. */
function valueOf(p) {
  const enc = (p.params.ENCODING || []).join(",");
  if (/QUOTED-PRINTABLE/.test(enc)) return qpDecode(p.value, (p.params.CHARSET || [])[0]);
  return p.value;
}

const comps = (v) => splitOutside(v, ";", false).map((x) => unescape(x).replace(/\r\n?/g, "\n").trim());

/** One card's properties into a contact. Never throws. */
function cardToContact(props) {
  const c = { uid: "", name: "", given: "", family: "", org: "", title: "", emails: [], phones: [], address: "", birthday: "", notes: "" };
  const labels = {};
  const lists = [];
  let nameParts = "";
  for (const p of props) {
    try {
      if (p.name === "X-ABLABEL") {
        labels[p.group] = groupLabel(unescape(valueOf(p)));
        continue;
      }
      const raw = valueOf(p);
      switch (p.name) {
        case "UID":
          c.uid ||= unescape(raw).trim();
          break;
        case "FN":
          c.name ||= unescape(raw);
          break;
        case "N": {
          const [family, given, middle, prefix, suffix] = comps(raw);
          c.family ||= family || "";
          c.given ||= given || "";
          nameParts ||= [prefix, given, middle, family, suffix].filter(Boolean).join(" ");
          break;
        }
        case "ORG":
          c.org ||= comps(raw).filter(Boolean).join(", ");
          break;
        case "TITLE":
          c.title ||= unescape(raw);
          break;
        case "NOTE":
          c.notes ||= unescape(raw);
          break;
        case "BDAY":
          c.birthday ||= unescape(raw);
          break;
        case "ADR": {
          if (c.address) break;
          const [pobox, ext, street, city, region, post, country] = comps(raw);
          c.address = [[pobox, ext, street].filter(Boolean).join(", "), [post, city].filter(Boolean).join(" "), region, country]
            .filter(Boolean)
            .join("\n");
          break;
        }
        case "EMAIL":
          lists.push({ kind: "emails", group: p.group, type: typeOf(p.params), value: unescape(raw).trim().replace(/^mailto:/i, "") });
          break;
        case "TEL":
          lists.push({ kind: "phones", group: p.group, type: typeOf(p.params), value: unescape(raw).trim().replace(/^tel:/i, "") });
          break;
        default:
          break; // PHOTO, URL, X- properties: not kept
      }
    } catch {
      /* a property that will not decode is dropped, the card is not */
    }
  }
  for (const l of lists) c[l.kind].push({ type: l.type || (l.group && labels[l.group]) || "", value: l.value });
  // A card with no name still has to carry an FN, so programs (this one among
  // them) fill it with the first thing they have: the company, an address, a
  // number. That is a stand-in, not somebody's name, and keeping it would turn
  // a nameless card into one named after its address.
  const standIn = [c.org, ...lists.map((l) => l.value)].map((v) => v.toLowerCase());
  if (!c.given && !c.family && standIn.includes(c.name.trim().toLowerCase())) c.name = "";
  if (!c.name) c.name = nameParts;
  return c;
}

/**
 * Every card in a file.
 *
 * Returns { contacts, empty, tooMany }. `empty` counts cards that held nothing
 * to keep. Past `maxCards` cards, reading stops and `tooMany` is set, so a
 * caller can refuse the whole file rather than half-import it.
 */
export function parseVcard(input, { maxCards = 2000 } = {}) {
  const result = { contacts: [], empty: 0, tooMany: false };
  try {
    const text = (typeof input === "string" ? input : decodeBytes(input)).replace(/^\uFEFF/, "");
    const lines = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
    let props = null;
    let seen = 0;
    const finish = () => {
      if (!props) return;
      const c = cleanContact(cardToContact(props));
      if (hasContent(c)) result.contacts.push(c);
      else result.empty++;
      props = null;
    };
    for (let i = 0; i < lines.length; i++) {
      let l = lines[i];
      if (!l.trim()) continue;
      const head = l.slice(0, Math.max(l.indexOf(":"), 0));
      // A quoted-printable value continues on the next line while this one ends
      // in "=". The pieces are joined once: rebuilding the line for each one
      // made a long value cost the square of its length.
      if (/QUOTED-PRINTABLE/i.test(head) && l.endsWith("=")) {
        const parts = [];
        while (l.endsWith("=") && i + 1 < lines.length) {
          parts.push(l.slice(0, -1));
          l = lines[++i];
        }
        parts.push(l);
        l = parts.join("");
      }
      const marker = /^\s*(BEGIN|END)\s*:\s*VCARD\s*$/i.exec(l);
      if (marker) {
        finish();
        if (marker[1].toUpperCase() === "BEGIN") {
          if (++seen > maxCards) {
            result.tooMany = true;
            return result;
          }
          props = [];
        }
        continue;
      }
      if (!props) continue;
      const p = parseProperty(l);
      if (p) props.push(p);
    }
    finish();
  } catch {
    /* what was read before the failure is still returned */
  }
  return result;
}

/* ── writing ── */

const encoder = new TextEncoder();

/** Lines of at most 75 octets, continued with a space, never inside a character. */
function fold(text) {
  if (encoder.encode(text).length <= 75) return text;
  const out = [];
  let cur = "";
  let size = 0;
  let room = 75;
  for (const ch of text) {
    const n = encoder.encode(ch).length;
    if (size + n > room) {
      out.push(cur);
      cur = "";
      size = 0;
      room = 74;
    }
    cur += ch;
    size += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const esc = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const oneLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " ");
const token = (t) => String(t ?? "").replace(/[^A-Za-z0-9-]/g, "").toUpperCase();

/** A phone label is free text for the person; the file wants a token, so the odd ones go in as X- types. */
function typeParam(type, base) {
  const t = token(type);
  return `;TYPE=${[base, t].filter(Boolean).join(",")}`.replace(/^;TYPE=$/, "");
}

/** One contact as a vCard 3.0 card, with CRLF line ends. */
export function writeCard(c) {
  const out = ["BEGIN:VCARD", "VERSION:3.0"];
  if (c.uid) out.push(`UID:${oneLine(c.uid)}`);
  // FN is required by 3.0, so a card with no name still gets one.
  out.push(`FN:${esc(c.name || c.org || c.emails?.[0]?.value || c.phones?.[0]?.value || "No name")}`);
  out.push(`N:${esc(c.family)};${esc(c.given)};;;`);
  if (c.org) out.push(`ORG:${esc(c.org)}`);
  if (c.title) out.push(`TITLE:${esc(c.title)}`);
  for (const e of c.emails || []) out.push(`EMAIL${typeParam(e.type, "INTERNET")}:${oneLine(e.value)}`);
  for (const p of c.phones || []) out.push(`TEL${typeParam(p.type, "")}:${oneLine(p.value)}`);
  if (c.address) out.push(`ADR:;;${esc(c.address)};;;;`);
  if (c.birthday) out.push(`BDAY:${c.birthday}`);
  if (c.notes) out.push(`NOTE:${esc(c.notes)}`);
  out.push("END:VCARD");
  return out.map(fold).join("\r\n") + "\r\n";
}

/** Any number of contacts as one .vcf file. */
export const writeVcard = (list) => list.map(writeCard).join("");
