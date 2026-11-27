/**
 * The mbox reader and writer (src/mbox.js), judged by what comes out of them.
 * Every message here is invented.
 */
import { readFileSync } from "node:fs";
import { eq, ok } from "./harness.mjs";
import { MboxSplitter, asctime, separatorDate, splitMbox, writeEntry } from "../src/mbox.js";

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const texts = (msgs) => msgs.map((m) => dec(m.raw));
const sep = (when = "Thu Nov 27 10:00:00 2026") => `From sender@example.test ${when}`;

// ── the page runs a copy of this file; it must not drift ──
{
  const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const src = readFileSync(new URL("../src/mbox.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const body = src.replace(/^export /gm, "");
  ok(page.includes(body), "the copy of src/mbox.js inside public/index.html is current (node scripts/sync-mbox.mjs updates it)");
}

// ── a plain file, LF and CRLF ──
{
  const lf = `${sep()}\nSubject: one\n\nfirst\n\n${sep("Fri Nov 28 11:30:00 2026")}\nSubject: two\n\nsecond\n\n${sep("Sat Nov 29 12:00:00 2026")}\nSubject: three\n\nthird\n`;
  eq(texts(splitMbox(enc(lf))), ["Subject: one\n\nfirst\n", "Subject: two\n\nsecond\n", "Subject: three\n\nthird\n"], "an LF file splits into its three messages, the blank line before a separator left off");
  const crlf = lf.replace(/\n/g, "\r\n");
  eq(texts(splitMbox(enc(crlf))), ["Subject: one\r\n\r\nfirst\r\n", "Subject: two\r\n\r\nsecond\r\n", "Subject: three\r\n\r\nthird\r\n"], "a CRLF file keeps its CRLF in each message");

  // The same three messages fed a byte at a time, and in odd lumps.
  for (const [label, file] of [["LF", lf], ["CRLF", crlf]]) {
    const bytes = enc(file);
    const whole = texts(splitMbox(bytes));
    for (const step of [1, 2, 7, 64]) {
      const s = new MboxSplitter();
      const got = [];
      for (let i = 0; i < bytes.length; i += step) got.push(...s.push(bytes.subarray(i, i + step)));
      got.push(...s.end());
      eq(texts(got), whole, `${label} fed ${step} byte(s) at a time gives the same messages as fed whole`);
    }
  }

  eq(texts(splitMbox(enc(lf.trimEnd()))), ["Subject: one\n\nfirst\n", "Subject: two\n\nsecond\n", "Subject: three\n\nthird"], "a missing final newline leaves the last message as it ends");
  eq(texts(splitMbox(enc(`${sep()}\nSubject: x\n\nbody\n`))), ["Subject: x\n\nbody\n"], "a last message with no blank line after it is whole");
}

// ── quoting, both ways ──
{
  const file = `${sep()}\nSubject: q\n\nFrom the top\n>From one\n>>From two\nFrom\n\n`;
  const rd = splitMbox(enc(file.replace("From the top\n>From one\n>>From two\n", ">From the top\n>>From one\n>>>From two\n")))[0];
  eq(dec(rd.raw), "Subject: q\n\nFrom the top\n>From one\n>>From two\nFrom\n", "mboxrd gives back every quoted line, one level shallower");
  const ro = splitMbox(enc(file.replace("From the top\n", ">From the top\n")), { quoting: "mboxo" })[0];
  eq(dec(ro.raw), "Subject: q\n\nFrom the top\nFrom one\n>>From two\nFrom\n", "mboxo unquotes only a single > and leaves a deeper one alone");

  const msg = enc("Subject: q\n\nFrom the top\n>From one\nFrom\nnot From here\n");
  const out = dec(writeEntry(msg, { date: 0 }));
  ok(out.endsWith("\nSubject: q\n\n>From the top\n>>From one\nFrom\nnot From here\n\n"), "mboxrd writing quotes a From line and deepens an already quoted one: " + JSON.stringify(out));
  const oldStyle = dec(writeEntry(msg, { date: 0, quoting: "mboxo" }));
  ok(oldStyle.endsWith("\nSubject: q\n\n>From the top\n>From one\nFrom\nnot From here\n\n"), "mboxo writing quotes only a line that begins From: " + JSON.stringify(oldStyle));
  eq(dec(splitMbox(writeEntry(msg, { date: 0 }))[0].raw), dec(msg), "what mboxrd wrote reads back the same");
  eq(dec(splitMbox(writeEntry(msg, { date: 0, quoting: "mboxo" }), { quoting: "mboxo" })[0].raw), "Subject: q\n\nFrom the top\nFrom one\nFrom\nnot From here\n", "mboxo cannot tell a line that began >From from one it quoted (the format's flaw), and that is all it loses");
}

// ── a body line "From " split across chunks ──
{
  const file = enc(`${sep()}\nSubject: edge\n\nbefore\n>From inside\nFrom MAILER nothing like a separator\nafter\n\n${sep("Fri Nov 28 11:30:00 2026")}\nSubject: next\n\nz\n`);
  const want = ["Subject: edge\n\nbefore\nFrom inside\nFrom MAILER nothing like a separator\nafter\n", "Subject: next\n\nz\n"];
  eq(texts(splitMbox(file)), want, "a quoted line is unquoted and an unquoted From line that is not a separator stays text");
  // Cut at every position, including inside the word From and inside the second separator.
  let bad = 0;
  for (let cut = 1; cut < file.length; cut++) {
    const s = new MboxSplitter();
    const got = [...s.push(file.subarray(0, cut)), ...s.push(file.subarray(cut)), ...s.end()];
    if (JSON.stringify(texts(got)) !== JSON.stringify(want)) bad++;
  }
  eq(bad, 0, "cut at every byte position in two chunks, the result never changes");
}

// ── flags and the date ──
{
  const file =
    `${sep("Thu Nov 27 10:00:00 2026")}\nStatus: RO\nX-Status: AF\nSubject: a\n\nA\n\n` +
    `${sep("Thu Nov 27 11:00:00 2026")}\nStatus: O\nSubject: b\n\nB\n\n` +
    `${sep("Thu Nov 27 12:00:00 2026")}\nSubject: c\n\nC\n\n` +
    `${sep("Thu Nov 27 13:00:00 2026")}\nDate: Mon, 02 Mar 2026 09:30:00 +0100\nX-Status: T\nStatus: R\nSubject: d\n\nD\n`;
  const [a, b, c, d] = splitMbox(enc(file));
  eq(a.flags, { seen: true, flagged: true, answered: true, draft: false }, "Status RO and X-Status AF are read as seen, flagged, answered");
  eq(b.flags, { seen: false, flagged: false, answered: false, draft: false }, "Status O, with no R, is unread");
  eq(c.flags.seen, true, "no Status header at all is taken as read");
  eq(d.flags, { seen: true, flagged: false, answered: false, draft: true }, "X-Status T is a draft, whichever order the two headers come in");
  eq(texts([a, b]), ["Subject: a\n\nA\n", "Subject: b\n\nB\n"], "the Status lines are not part of the message that comes out");
  eq(a.date, Date.UTC(2026, 10, 27, 10), "the separator line's date is used when the headers have none");
  eq(d.date, Date.UTC(2026, 2, 2, 8, 30), "a Date header wins over the separator's");
  eq(separatorDate("From x@y Thu Nov 27 10:00:00 +0200 2026"), Date.UTC(2026, 10, 27, 8), "a zone on the separator line is applied");
  eq(separatorDate("From x@y Thu Nov 27 10:00 2026"), Date.UTC(2026, 10, 27, 10), "and so is a time with no seconds");
  eq(separatorDate("From the top of the page"), null, "a line that only begins From is not a separator");
  eq(asctime(Date.UTC(2026, 10, 7, 9, 5, 3)), "Sat Nov  7 09:05:03 2026", "the writer's date is the form the reader takes");
}

// ── empty, and no separator at all ──
{
  eq(splitMbox(new Uint8Array(0)), [], "an empty file has no messages");
  const eml = "From: ann@example.test\r\nSubject: plain\r\n\r\nFrom the heart\r\n>From nobody\r\n";
  const one = splitMbox(enc(eml));
  eq(one.length, 1, "a file with no separator is one message");
  eq(dec(one[0].raw), eml, "and is returned as it stands, no unquoting, no lines dropped");
  const s = new MboxSplitter();
  const got = [];
  for (const b of enc(eml)) got.push(...s.push(Uint8Array.of(b)));
  got.push(...s.end());
  eq(texts(got), [eml], "even fed one byte at a time");
  eq(texts(splitMbox(enc("Subject: no newline"))), ["Subject: no newline"], "a single line with no newline is one message");
}

// ── size limit: counted, not kept ──
{
  const big = "x".repeat(5000);
  const file = `${sep()}\nSubject: big\n\n${big}\n\n${sep("Fri Nov 28 11:30:00 2026")}\nSubject: small\n\nok\n`;
  const got = splitMbox(enc(file), { maxBytes: 1000 });
  eq(got.map((m) => [m.oversize, m.raw === null]), [[true, true], [false, false]], "a message over maxBytes is reported, not held, and the next one is read normally");
  ok(got[0].size > 5000, "with its size");
}

// ── writing and reading back ──
{
  const msgs = [
    "From: a@example.test\r\nSubject: one\r\n\r\nhello\r\nFrom the start of a line\r\n",
    "From: b@example.test\nSubject: two\n\n>>From deep\nbye\n",
    "Subject: three\r\n\r\n\r\n\r\n",
    "Subject: four\r\n\r\n=C3=A9t=C3=A9 \xff\xfe 8-bit\r\n",
  ];
  const latin = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  const parts = msgs.map((m, i) => writeEntry(latin(m), { date: Date.UTC(2026, 0, 1 + i) }));
  const file = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (file.set(p, at), (at += p.length));
  const back = splitMbox(file);
  eq(back.map((m) => Buffer.from(m.raw).toString("latin1")), msgs, "write then split gives back the same bytes for each message, CRLF, LF and 8-bit alike");
  eq(back.map((m) => m.date), [0, 1, 2, 3].map((i) => Date.UTC(2026, 0, 1 + i)), "and each message's date");
  eq(dec(parts[0].subarray(0, 60)).split("\r\n")[0], "From MAILER-DAEMON Thu Jan  1 00:00:00 2026", "a CRLF message gets a separator line that ends CRLF too");

  const flagged = writeEntry(latin(msgs[0]), { date: 0, flags: { seen: false, flagged: true, answered: false, draft: false } });
  const [f] = splitMbox(flagged);
  eq([f.flags, Buffer.from(f.raw).toString("latin1")], [{ seen: false, flagged: true, answered: false, draft: false }, msgs[0]], "flags written as Status and X-Status come back as flags, and the message is still its own bytes");
  const swapped = splitMbox(writeEntry(Uint8Array.from(Buffer.from("Status: O\nSubject: s\n\nb\n")), { date: 0, flags: { seen: true, flagged: false, answered: false, draft: false } }))[0];
  eq([swapped.flags.seen, dec(swapped.raw)], [true, "Subject: s\n\nb\n"], "writing flags replaces a Status header the message already had");
  eq(dec(writeEntry(enc("Subject: x\n\nno end"), { date: 0 })).endsWith("no end\n\n"), true, "a message with no final newline is given one");
}
