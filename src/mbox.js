/**
 * Reading and writing mbox files: the pure part, no network and no storage.
 *
 * An mbox is every message of a mailbox one after another, each introduced by
 * a line that starts "From " (the separator) and each body line that would
 * look like one quoted so it cannot be mistaken for it. A Worker must never
 * hold a whole archive, so the reader takes bytes in chunks and gives whole
 * messages out, keeping only the message it is in the middle of. The page
 * runs the same code (scripts/sync-mbox.mjs copies this file into
 * public/index.html, and the tests fail when the copy is stale), so what is
 * tested is what runs.
 *
 * Only whole-line, byte-level work happens here. A message stays the bytes it
 * was: nothing is decoded, re-wrapped or normalised, which is what lets a file
 * written by writeEntry come back through MboxSplitter byte for byte.
 *
 * Because the page copy is wrapped in a function, this file imports nothing
 * and keeps every top-level name to itself.
 */

const LF = 10;
const CR = 13;
const GT = 62;
const FROM = [70, 114, 111, 109, 32]; // "From "

// A separator is "From " + a sender + an asctime date, and nothing looser: a
// body line that merely begins "From " (an exporter that did not quote it)
// must not cut a message in two. Gmail Takeout and Thunderbird both write a
// zone before the year, so that is allowed.
const SEPARATOR =
  /^From \S+ +\S{3},? +(\S{3}) +(\d{1,2}) +(\d{1,2}):(\d\d)(?::(\d\d))?(?: +([+-]\d{4}|[A-Z]{2,5}))? +(\d{4}) *\r?\n?$/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A header block longer than this is not one; reading it stops here.
const HEAD_LIMIT = 256 * 1024;

const latin1 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return s;
};

const unlatin1 = (s) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
  return out;
};

function concat(parts, size) {
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const startsFrom = (line, at) => FROM.every((b, i) => line[at + i] === b);

/** How many ">" begin the line, when they are followed by "From "; else -1. */
function quoteDepth(line) {
  let i = 0;
  while (line[i] === GT) i++;
  return startsFrom(line, i) ? i : -1;
}

/** The time a separator line names, in ms, or null when it is not a separator. */
export function separatorDate(line) {
  const m = SEPARATOR.exec(typeof line === "string" ? line : latin1(line));
  if (!m) return null;
  const mon = MONTHS.indexOf(m[1].toLowerCase());
  if (mon < 0) return null;
  let t = Date.UTC(Number(m[7]), mon, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5] || 0));
  const zone = /^([+-])(\d\d)(\d\d)$/.exec(m[6] || "");
  if (zone) t -= (zone[1] === "-" ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3])) * 60000;
  return Number.isNaN(t) ? null : t;
}

/**
 * The headers of one message, read from its bytes.
 *
 * Status and X-Status describe the copy of the message in one mailbox, not
 * the message, so they are taken out of the bytes and reported as flags: a
 * message that has been through a file comes out the way it went in. A
 * message with no Status header at all is taken as read, because old mail
 * brought in from an archive that does not say is far more often a record
 * than a thing to catch up on.
 */
function readHead(raw) {
  let end = 0;
  const stop = Math.min(raw.length, HEAD_LIMIT);
  for (let at = 0; at < stop; ) {
    const nl = raw.indexOf(LF, at);
    const to = nl < 0 ? raw.length : nl;
    if ((to > at && raw[to - 1] === CR ? to - 1 : to) === at) break; // the blank line
    at = nl < 0 ? raw.length : nl + 1;
    end = at;
  }
  const head = latin1(raw.subarray(0, end));
  const lines = head.match(/[^\n]*\n|[^\n]+$/g) || [];
  let status;
  let xStatus = "";
  let date = "";
  const kept = [];
  let dropping = false;
  let inDate = false;
  for (const line of lines) {
    const fold = /^[ \t]/.test(line);
    if (!fold) {
      dropping = false;
      inDate = false;
      const m = /^(status|x-status|date):(.*)$/i.exec(line.replace(/\r?\n$/, ""));
      if (m) {
        const name = m[1].toLowerCase();
        if (name === "date") {
          if (!date) {
            date = m[2];
            inDate = true;
          }
        } else {
          dropping = true;
          if (name === "status" && status === undefined) status = m[2];
          if (name === "x-status") xStatus += m[2];
        }
      }
    } else if (inDate) {
      date += line.replace(/\r?\n$/, "");
    }
    if (!dropping) kept.push(line);
  }
  const flags = {
    seen: status === undefined ? true : /R/i.test(status),
    flagged: /F/i.test(xStatus),
    answered: /A/i.test(xStatus),
    draft: /T/i.test(xStatus),
  };
  const parsed = Date.parse(date.trim());
  const top = unlatin1(kept.join(""));
  const cleaned = kept.length === lines.length ? raw : concat([top, raw.subarray(end)], top.length + raw.length - end);
  return { raw: cleaned, flags, date: Number.isNaN(parsed) ? null : parsed };
}

/**
 * Whole messages out of an mbox, fed in chunks.
 *
 *   const s = new MboxSplitter();
 *   for await (const chunk of stream) for (const msg of s.push(chunk)) ...
 *   for (const msg of s.end()) ...
 *
 * A message is { raw, size, date, flags, oversize }. `raw` is Uint8Array and
 * has the file's own line endings; `date` is the Date header when there is
 * one, else the date on the separator line, else null; `flags` is
 * { seen, flagged, answered, draft }. A message over `maxBytes` is not kept:
 * raw is null and oversize true, so the caller can count and report it
 * without the reader holding it.
 *
 * A file whose first line is not a separator is one message as it stands (an
 * .eml): nothing in it is split or unquoted, because a body line "From " in a
 * plain message is just text.
 *
 * `quoting` is "mboxrd" (">From " and ">>From " lose one ">"; what current
 * writers do) or "mboxo" (only a single ">From " is unquoted, which is all
 * the older format ever added). The chunk is only read, never changed.
 */
export class MboxSplitter {
  constructor({ quoting = "mboxrd", maxBytes = Infinity } = {}) {
    this.quoting = quoting;
    this.maxBytes = maxBytes;
    this.carry = [];
    this.carried = 0;
    this.mode = null; // null until the first line, then "mbox" or "single"
    this.started = false;
    this.parts = [];
    this.size = 0;
    this.pending = null;
    this.sepDate = null;
    this.over = false;
  }

  push(chunk) {
    const out = [];
    let from = 0;
    for (;;) {
      const nl = chunk.indexOf(LF, from);
      if (nl < 0) break;
      let line = chunk.subarray(from, nl + 1);
      if (this.carried) {
        this.carry.push(line);
        line = concat(this.carry, this.carried + line.length);
        this.carry = [];
        this.carried = 0;
      }
      this.line(line, out);
      from = nl + 1;
    }
    if (from < chunk.length) {
      // A copy: the caller may reuse the buffer it handed in.
      const rest = chunk.slice(from);
      this.carry.push(rest);
      this.carried += rest.length;
    }
    return out;
  }

  end() {
    const out = [];
    if (this.carried) {
      const line = concat(this.carry, this.carried);
      this.carry = [];
      this.carried = 0;
      this.line(line, out);
    }
    if (this.started) this.finish(out);
    return out;
  }

  line(line, out) {
    if (this.mode === null) {
      this.mode = SEPARATOR.test(startsFrom(line, 0) ? latin1(line.subarray(0, 300)) : "") ? "mbox" : "single";
    }
    if (this.mode === "single") {
      this.started = true;
      this.add(line);
      return;
    }
    if (startsFrom(line, 0) && line.length < 300) {
      const text = latin1(line);
      if (SEPARATOR.test(text)) {
        if (this.started) this.finish(out);
        this.started = true;
        this.sepDate = separatorDate(text);
        return;
      }
    }
    // The line before a separator is a blank one the writer put there; it is
    // held back one line so it can be left off the message it follows.
    if (line[0] === GT) {
      const depth = quoteDepth(line);
      if (depth > 0 && (this.quoting === "mboxrd" || depth === 1)) line = line.subarray(1);
    }
    this.add(line);
  }

  add(line) {
    if (this.pending) this.keep(this.pending);
    this.pending = line;
  }

  keep(line) {
    this.size += line.length;
    if (this.size > this.maxBytes) {
      this.over = true;
      this.parts = [];
    }
    if (!this.over) this.parts.push(line);
  }

  finish(out) {
    const last = this.pending;
    const blank = last && (last.length === 1 || (last.length === 2 && last[0] === CR)) && last[last.length - 1] === LF;
    if (last && !(this.mode === "mbox" && blank)) this.keep(last);
    if (this.over) {
      out.push({ raw: null, size: this.size, date: this.sepDate, flags: { seen: true, flagged: false, answered: false, draft: false }, oversize: true });
    } else if (this.size || this.mode === "mbox") {
      const head = readHead(concat(this.parts, this.size));
      out.push({ raw: head.raw, size: head.raw.length, date: head.date ?? this.sepDate, flags: head.flags, oversize: false });
    }
    this.parts = [];
    this.size = 0;
    this.pending = null;
    this.sepDate = null;
    this.over = false;
    this.started = false;
  }
}

/** Every message in a file already in memory. For small files and tests. */
export function splitMbox(bytes, opts) {
  const s = new MboxSplitter(opts);
  return [...s.push(bytes), ...s.end()];
}

/** "Thu Nov 27 10:00:00 2026", the date a separator line carries, in UTC. */
export function asctime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]} ${MONTH_NAMES[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

/**
 * One message as it goes into an mbox: the separator line, the message with
 * its "From " lines quoted, and the blank line that ends it.
 *
 * `flags` ({ seen, flagged, answered, draft }) are written as Status and
 * X-Status headers, replacing any the message had; leave it out and the
 * bytes go in untouched. Lines end the way the message's first line does, so
 * a message from IMAP (CRLF) stays CRLF and a file of LF stays LF. A message
 * that does not end in a newline is given one.
 */
export function writeEntry(raw, { date = Date.now(), flags, quoting = "mboxrd", sender = "MAILER-DAEMON" } = {}) {
  let body = raw;
  const first = body.indexOf(LF);
  const eol = first > 0 && body[first - 1] === CR ? "\r\n" : "\n";
  if (flags) {
    const status = `${flags.seen ? "RO" : "O"}`;
    const x = `${flags.flagged ? "F" : ""}${flags.answered ? "A" : ""}${flags.draft ? "T" : ""}`;
    const extra = unlatin1(`Status: ${status}${eol}${x ? `X-Status: ${x}${eol}` : ""}`);
    const clean = readHead(body).raw;
    body = concat([extra, clean], extra.length + clean.length);
  }
  const quote = [];
  for (let at = 0; at < body.length; ) {
    const depth = quoteDepth(body.subarray(at, at + 80 > body.length ? body.length : at + 80));
    if (depth === 0 || (depth > 0 && quoting === "mboxrd")) quote.push(at);
    const nl = body.indexOf(LF, at);
    if (nl < 0) break;
    at = nl + 1;
  }
  const head = unlatin1(`From ${sender} ${asctime(date)}${eol}`);
  const tail = unlatin1(body.length && body[body.length - 1] !== LF ? eol + eol : eol);
  const out = new Uint8Array(head.length + body.length + quote.length + tail.length);
  out.set(head, 0);
  let to = head.length;
  let from = 0;
  for (const at of quote) {
    out.set(body.subarray(from, at), to);
    to += at - from;
    out[to++] = GT;
    from = at;
  }
  out.set(body.subarray(from), to);
  to += body.length - from;
  out.set(tail, to);
  return out;
}
