/**
 * TNEF, the format of Outlook's winmail.dat.
 *
 * When Outlook sends rich text to a client it does not trust, it wraps the
 * message in one attachment, application/ms-tnef, and the real files travel
 * inside it. Without this the reader shows a single "winmail.dat" that
 * nothing can open.
 *
 * The bytes come from whoever sent the mail, so every read here is bounded
 * by the buffer and every count and length by a limit of its own. Nothing is
 * ever thrown at the caller: a damaged or cut-off container yields whatever
 * was whole before the damage. A file whose bytes were cut short is dropped
 * rather than offered half-complete, because a corrupt download that looks
 * fine is worse than a missing one.
 *
 * Nothing inside is interpreted. Names and types are strings to be shown,
 * and the bytes are handed back untouched.
 */

const SIGNATURE = 0x223e9f78;

// Attribute ids, type in the high word. Level 1 is the message, 2 a file.
const ATT_BODY = 0x0002800c;
const ATT_MAPI_PROPS = 0x00069003;
const ATT_ATTACH_RENDDATA = 0x00069002;
const ATT_ATTACH_TITLE = 0x00018010;
const ATT_ATTACH_DATA = 0x0006800f;
const ATT_ATTACHMENT = 0x00069005;

// MAPI property ids.
const PR_BODY = 0x1000;
const PR_ATTACH_DATA_BIN = 0x3701;
const PR_ATTACH_EXTENSION = 0x3703;
const PR_ATTACH_FILENAME = 0x3704;
const PR_ATTACH_LONG_FILENAME = 0x3707;
const PR_ATTACH_MIME_TAG = 0x370e;

// MAPI property types.
const PT_I2 = 0x02;
const PT_LONG = 0x03;
const PT_R4 = 0x04;
const PT_DOUBLE = 0x05;
const PT_CURRENCY = 0x06;
const PT_APPTIME = 0x07;
const PT_ERROR = 0x0a;
const PT_BOOLEAN = 0x0b;
const PT_OBJECT = 0x0d;
const PT_I8 = 0x14;
const PT_STRING8 = 0x1e;
const PT_UNICODE = 0x1f;
const PT_SYSTIME = 0x40;
const PT_CLSID = 0x48;
const PT_BINARY = 0x102;
const MULTI = 0x1000;

export const TNEF_LIMITS = {
  input: 48 * 1024 * 1024, // bytes read at all
  files: 200, // files kept
  props: 2048, // MAPI properties per block
  values: 4096, // values in one multi-valued property
  name: 255, // characters of a file name
  mime: 127, // characters of a type
  text: 1024 * 1024, // bytes of message text
  attributes: 20000, // attributes walked before giving up
};

const FIXED = {
  [PT_I2]: 4,
  [PT_LONG]: 4,
  [PT_R4]: 4,
  [PT_DOUBLE]: 8,
  [PT_CURRENCY]: 8,
  [PT_APPTIME]: 8,
  [PT_ERROR]: 4,
  [PT_BOOLEAN]: 4,
  [PT_I8]: 8,
  [PT_SYSTIME]: 8,
  [PT_CLSID]: 16,
};

/** True when a buffer opens with the TNEF signature. */
export function isTnef(bytes) {
  return bytes instanceof Uint8Array && bytes.length >= 6 && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === SIGNATURE;
}

const MIME_BY_EXT = {
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ics: "text/calendar",
  eml: "message/rfc822",
};

/**
 * A name that is safe to show and to put in a download header: no folders,
 * no control characters, a bounded length. What the sender wrote past that
 * is theirs to choose.
 */
function cleanName(s) {
  const base = String(s || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .split(/[\\/]/)
    .pop()
    .trim()
    .slice(0, TNEF_LIMITS.name);
  return base === "." || base === ".." ? "" : base;
}

const cleanMime = (s) => {
  const v = String(s || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(v) && v.length <= TNEF_LIMITS.mime ? v : "";
};

/** Strings in a MAPI property end at the first NUL, whatever the length said. */
const cut = (s) => {
  const i = s.indexOf("\u0000");
  return i < 0 ? s : s.slice(0, i);
};

/** Single-byte text as windows-1252 would read it, which is what Outlook writes. */
const ansi = (b) => cut(new TextDecoder("windows-1252").decode(b));
const utf16 = (b) => cut(new TextDecoder("utf-16le").decode(b.subarray(0, b.length & ~1)));

/**
 * A byte reader that cannot leave its buffer. `take` returns null instead of
 * a short slice, so a caller never has to remember to check a length.
 */
function reader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  return {
    get pos() {
      return pos;
    },
    left: () => bytes.length - pos,
    u8: () => (pos + 1 <= bytes.length ? bytes[pos++] : null),
    u16: () => (pos + 2 <= bytes.length ? (pos += 2, view.getUint16(pos - 2, true)) : null),
    u32: () => (pos + 4 <= bytes.length ? (pos += 4, view.getUint32(pos - 4, true)) : null),
    take: (n) => (Number.isSafeInteger(n) && n >= 0 && n <= bytes.length - pos ? (pos += n, bytes.subarray(pos - n, pos)) : null),
    skip: (n) => (Number.isSafeInteger(n) && n >= 0 && n <= bytes.length - pos ? ((pos += n), true) : false),
  };
}

const pad4 = (n) => (n + 3) & ~3;

/**
 * One MAPI property block: the properties this module wants, by id, as
 * `{ type, value }` where value is bytes. Stops quietly at the first thing it
 * cannot size, since every later property is positioned by that size.
 */
function mapiProps(bytes, wanted) {
  const out = {};
  const r = reader(bytes);
  const count = r.u32();
  if (count === null) return out;
  for (let i = 0; i < Math.min(count, TNEF_LIMITS.props); i++) {
    const tag = r.u32();
    if (tag === null) break;
    const id = tag >>> 16;
    const type = tag & 0xffff;
    // A named property carries a GUID and a name or number ahead of its value.
    if (id >= 0x8000) {
      if (!r.skip(16)) break;
      const kind = r.u32();
      if (kind === null) break;
      if (kind === 0) {
        if (r.u32() === null) break;
      } else if (kind === 1) {
        const n = r.u32();
        if (n === null || !r.skip(pad4(n))) break;
      } else break;
    }

    const base = type & ~MULTI;
    const multi = (type & MULTI) !== 0;
    const fixed = FIXED[base];
    let value = null;

    if (fixed && !multi) {
      if (!r.skip(fixed)) break;
    } else if (fixed && multi) {
      const n = r.u32();
      if (n === null || n > TNEF_LIMITS.values || !r.skip(n * fixed)) break;
    } else if (base === PT_STRING8 || base === PT_UNICODE || base === PT_BINARY || base === PT_OBJECT) {
      const n = r.u32();
      if (n === null || n > TNEF_LIMITS.values) break;
      let ok = true;
      for (let k = 0; k < n; k++) {
        const len = r.u32();
        const raw = len === null ? null : r.take(len);
        if (raw === null || !r.skip(pad4(len) - len)) {
          ok = false;
          break;
        }
        if (k === 0 && !multi) value = raw;
      }
      if (!ok) break;
    } else break; // a type this module has no size for

    if (value && wanted.has(id)) out[id] = { type: base, value };
  }
  return out;
}

const mapiString = (p) => (p ? (p.type === PT_UNICODE ? utf16(p.value) : ansi(p.value)) : "");

/**
 * Reads a TNEF buffer.
 *
 * Returns `{ files, text }`: each file as `{ name, type, size, data }` with
 * `data` a view into the input, and `text` the message's own plain text when
 * it carries one. Not TNEF, or empty, gives no files and no text.
 */
export function parseTnef(input) {
  const result = { files: [], text: "" };
  if (!(input instanceof Uint8Array) || !isTnef(input)) return result;
  const bytes = input.length > TNEF_LIMITS.input ? input.subarray(0, TNEF_LIMITS.input) : input;

  const r = reader(bytes);
  r.u32(); // signature
  r.u16(); // key, which only ties attachments to a message

  let cur = null; // the file being assembled
  const files = [];
  const flush = () => {
    if (cur && cur.data && files.length < TNEF_LIMITS.files) files.push(cur);
    cur = null;
  };
  const fresh = () => ({ data: null, title: "", long: "", short: "", ext: "", mime: "" });
  const mine = () => (cur ||= fresh());

  for (let n = 0; n < TNEF_LIMITS.attributes; n++) {
    const level = r.u8();
    if (level === null) break;
    const id = r.u32();
    const len = r.u32();
    if (id === null || len === null) break;
    const data = r.take(len);
    if (data === null) {
      // A cut-off payload. A file whose data this was never completes.
      if (id === ATT_ATTACH_DATA) cur = null;
      break;
    }
    if (r.u16() === null) {
      // The checksum is missing, so the file ends here. The bytes before it
      // are whole, so they are kept.
      if (level === 2 && id === ATT_ATTACH_DATA) mine().data = data;
      break;
    }

    if (level === 1) {
      if (id === ATT_BODY && !result.text) result.text = ansi(data.subarray(0, TNEF_LIMITS.text));
      else if (id === ATT_MAPI_PROPS) {
        const p = mapiProps(data, new Set([PR_BODY]))[PR_BODY];
        if (p && !result.text) result.text = mapiString({ type: p.type, value: p.value.subarray(0, TNEF_LIMITS.text) });
      }
      continue;
    }
    if (level !== 2) continue;

    if (id === ATT_ATTACH_RENDDATA) {
      flush();
      cur = fresh();
    } else if (id === ATT_ATTACH_TITLE) mine().title = ansi(data);
    else if (id === ATT_ATTACH_DATA) mine().data = data;
    else if (id === ATT_ATTACHMENT) {
      const p = mapiProps(data, new Set([PR_ATTACH_LONG_FILENAME, PR_ATTACH_FILENAME, PR_ATTACH_EXTENSION, PR_ATTACH_MIME_TAG, PR_ATTACH_DATA_BIN]));
      const f = mine();
      f.long = mapiString(p[PR_ATTACH_LONG_FILENAME]);
      f.short = mapiString(p[PR_ATTACH_FILENAME]);
      f.ext = mapiString(p[PR_ATTACH_EXTENSION]);
      f.mime = mapiString(p[PR_ATTACH_MIME_TAG]);
      // Newer writers put the payload here instead of in attAttachData.
      if (!f.data && p[PR_ATTACH_DATA_BIN]?.type === PT_BINARY) f.data = p[PR_ATTACH_DATA_BIN].value;
    }
  }
  flush();

  files.forEach((f, i) => {
    const name = cleanName(f.long) || cleanName(f.title) || cleanName(f.short) || `attachment-${i + 1}${/^\.?\w{1,8}$/.test(f.ext) ? "." + f.ext.replace(/^\./, "") : ""}`;
    const ext = (name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] || "").toLowerCase();
    result.files.push({
      name,
      type: cleanMime(f.mime) || MIME_BY_EXT[ext] || "application/octet-stream",
      size: f.data.length,
      data: f.data,
    });
  });
  return result;
}
