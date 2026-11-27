/**
 * Is every word the interface can show in the dictionary, and does the
 * dictionary hold nothing else? Run before every deploy, and while translating
 * to find what is left.
 *
 *   node scripts/check-i18n.mjs            the check (exit 1 on any failure)
 *   node scripts/check-i18n.mjs --keys     every key and where it comes from, as JSON
 *   node scripts/check-i18n.mjs --missing  only the keys with no entry, as JSON
 *   node scripts/check-i18n.mjs --find     string literals that look like interface
 *                                          text and are not in t(): to review, not a failure
 *
 * Where a key comes from:
 *   - the static markup of public/index.html and of the pages in src/index.js:
 *     every text node and every aria-label, title, placeholder and alt, with
 *     whitespace squashed and entities decoded (an element marked data-i18n is
 *     one phrase, matched by its whole inner HTML);
 *   - the first argument of every t("…") in the page's scripts and in sw.js;
 *   - the argument of every ui("…") in src/: the English the Worker sends,
 *     which the device matches against the dictionary (see tw() in i18n.js).
 *
 * What it refuses, besides a missing, dead or mismatched entry:
 *   - a t() whose key is not a literal, so it could never be listed;
 *   - English handed straight to toast(), ask() and the other dialogs, put in
 *     a text slot of an element, or written between the tags of a template;
 *   - a t() called where a local `t` hides it;
 *   - and in French, a straight quote, three dots, or a ; : ! ? « » with an
 *     ordinary space or none where French wants a narrow no-break space.
 *
 * A line that carries `i18n-ok` in a comment is left alone by those scans.
 */
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8").replace(/\r\n/g, "\n");

/* ── a JavaScript tokenizer, as much as this needs ── */

const OPS = ["===", "!==", "...", "==", "!=", "=>", "&&", "||", "??", "?.", "<=", ">=", "++", "--", "+=", "-=", "*=", "/="];
const REGEX_AFTER = new Set(["return", "typeof", "case", "in", "of", "delete", "void", "throw", "new", "else", "do", "yield", "await"]);

function unescape(raw) {
  return raw.replace(/\\(u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|\n|[\s\S])/g, (m, c, u1, u2, x) => {
    if (u1) return String.fromCodePoint(parseInt(u1, 16));
    if (u2) return String.fromCharCode(parseInt(u2, 16));
    if (x) return String.fromCharCode(parseInt(x, 16));
    if (c === "\n") return "";
    return { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" }[c] ?? c;
  });
}

/**
 * Tokens in source order. A template is one token (its text parts and the
 * source of each ${…}) followed by the tokens of its expressions between a
 * "${" and a "}", so a t() inside one is found like any other.
 */
function tokenize(src, base = 0, out = [], oks = new Set()) {
  const lineAt = (i) => src.slice(0, i).split("\n").length; // only used for comments; callers map offsets
  let i = 0;
  let prev = null;
  const push = (tok) => { tok.start += base; tok.end += base; out.push(tok); if (tok.type !== "comment") prev = tok; };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && src[i + 1] === "/") {
      let j = src.indexOf("\n", i); if (j < 0) j = src.length;
      if (src.slice(i, j).includes("i18n-ok")) oks.add(base + i);
      i = j; continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const j = src.indexOf("*/", i + 2);
      if (src.slice(i, j).includes("i18n-ok")) oks.add(base + i);
      i = j + 2; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === "\\") j++; j++; }
      push({ type: "str", v: unescape(src.slice(i + 1, j)), start: i, end: j + 1 });
      i = j + 1; continue;
    }
    if (c === "`") {
      const parts = []; const exprs = [];
      let j = i + 1, text = "";
      while (j < src.length && src[j] !== "`") {
        if (src[j] === "\\") { text += src.slice(j, j + 2); j += 2; continue; }
        if (src[j] === "$" && src[j + 1] === "{") {
          parts.push(unescape(text)); text = "";
          let depth = 1, k = j + 2;
          while (k < src.length && depth) {
            const d = src[k];
            if (d === "{") depth++;
            else if (d === "}") depth--;
            else if (d === '"' || d === "'") { k++; while (k < src.length && src[k] !== d) { if (src[k] === "\\") k++; k++; } }
            else if (d === "`") { // a nested template: skip it whole
              k++; let nest = 0;
              while (k < src.length && !(src[k] === "`" && nest === 0)) {
                if (src[k] === "\\") k++;
                else if (src[k] === "$" && src[k + 1] === "{") nest++;
                else if (src[k] === "}" && nest) nest--;
                k++;
              }
            }
            if (depth) k++;
          }
          exprs.push({ from: j + 2, to: k });
          j = k + 1; continue;
        }
        text += src[j]; j++;
      }
      parts.push(unescape(text));
      const tok = { type: "tpl", parts, exprs: exprs.map((e) => src.slice(e.from, e.to)), start: i, end: j + 1 };
      push(tok);
      exprs.forEach((e) => {
        push({ type: "punct", v: "${", start: e.from - 2, end: e.from });
        tokenize(src.slice(e.from, e.to), base + e.from, out, oks);
        push({ type: "punct", v: "}", start: e.to, end: e.to + 1 });
      });
      i = j + 1; continue;
    }
    if (c === "/") {
      const division = prev && (prev.type === "num" || prev.type === "str" || prev.type === "tpl" || (prev.type === "ident" && !REGEX_AFTER.has(prev.v)) || (prev.type === "punct" && [")", "]", "}"].includes(prev.v)));
      if (!division) {
        let j = i + 1, cls = false;
        while (j < src.length) {
          if (src[j] === "\\") j++;
          else if (src[j] === "[") cls = true;
          else if (src[j] === "]") cls = false;
          else if (src[j] === "/" && !cls) break;
          else if (src[j] === "\n") break;
          j++;
        }
        j++;
        while (/[a-z]/.test(src[j] || "")) j++;
        push({ type: "regex", v: src.slice(i, j), start: i, end: j });
        i = j; continue;
      }
    }
    if (/[\p{L}_$]/u.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\p{L}\p{N}_$]/u.test(src[j])) j++;
      push({ type: "ident", v: src.slice(i, j), start: i, end: j });
      i = j; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[0-9a-zA-Z_.]/.test(src[j])) j++;
      push({ type: "num", v: src.slice(i, j), start: i, end: j });
      i = j; continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    push({ type: "punct", v: op || c, start: i, end: i + (op ? op.length : 1) });
    i += op ? op.length : 1;
  }
  return out;
}

/** The index of the token that closes the bracket opened at `at`. */
function match(toks, at) {
  let depth = 0;
  for (let i = at; i < toks.length; i++) {
    const v = toks[i].type === "punct" ? toks[i].v : "";
    if (v === "(" || v === "[" || v === "{" || v === "${") depth++;
    else if (v === ")" || v === "]" || v === "}") { depth--; if (!depth) return i; }
  }
  return toks.length - 1;
}

/** The argument spans of the call whose "(" is at `open`: [[from, to], …] over token indexes. */
function callArgs(toks, open) {
  const close = match(toks, open);
  const args = [];
  let from = open + 1, depth = 0;
  for (let i = open + 1; i < close; i++) {
    const v = toks[i].type === "punct" ? toks[i].v : "";
    if (v === "(" || v === "[" || v === "{" || v === "${") depth++;
    else if (v === ")" || v === "]" || v === "}") depth--;
    else if (v === "," && !depth) { args.push([from, i]); from = i + 1; }
  }
  if (close > open + 1) args.push([from, close]);
  return { args, close };
}

/* ── markup ── */

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", middot: "·", rarr: "→", larr: "←", times: "×", laquo: "«", raquo: "»", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", bull: "•", copy: "©", check: "✓", thinsp: " ", ensp: " ", emsp: " ", uarr: "↑", darr: "↓", minus: "−" };
const decode = (s) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    if (!(e in NAMED)) throw new Error(`unknown entity &${e}; — add it to NAMED in scripts/check-i18n.mjs`);
    return NAMED[e];
  });
/** What a browser's innerHTML gives back for this text. */
const reescape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;");
const squash = (s) => s.replace(/\s+/g, " ").trim();
const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "source", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "use", "stop"]);
const ATTRS = ["aria-label", "title", "placeholder", "alt", "data-ph"];
const hasWords = (s) => /\p{L}{2}/u.test(s);

/**
 * The phrases of a piece of markup: [{ key, line, kind }]. `mark` is the
 * placeholder a template left where an expression was.
 */
function markup(src, lineOf = () => 0, mark = "\u0001") {
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+)/g;
  const out = [];
  const stack = [];
  let m;
  const attrsOf = (raw) => {
    const list = [];
    for (const a of raw.matchAll(/([\w:@.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      list.push([a[1], a[2] ?? a[3] ?? a[4] ?? ""]);
    }
    return list;
  };
  const skipped = () => stack.some((e) => e.no || e.name === "kbd");
  while ((m = re.exec(src))) {
    if (m[4] !== undefined) {
      if (skipped() || stack.some((e) => e.phrase)) continue;
      const text = squash(decode(m[4]));
      if (hasWords(text.split(mark).join(""))) out.push({ key: text, line: lineOf(m.index), kind: "text" });
      continue;
    }
    if (!m[2]) continue;
    const name = m[2].toLowerCase();
    if (m[1]) {
      for (let k = stack.length - 1; k >= 0; k--) if (stack[k].name === name) { stack.length = k; break; }
      continue;
    }
    const attrs = attrsOf(m[3]);
    const has = (n) => attrs.some(([k]) => k === n);
    const el = { name, no: attrs.some(([k, v]) => k === "translate" && v === "no") || stack.some((e) => e.no) };
    if (name === "style" || name === "script") {
      const end = src.indexOf(`</${name}`, re.lastIndex);
      re.lastIndex = end < 0 ? src.length : end;
      continue;
    }
    if (!el.no) {
      for (const [k, v] of attrs) {
        if (!ATTRS.includes(k)) continue;
        const text = squash(decode(v));
        if (hasWords(text.split(mark).join(""))) out.push({ key: text, line: lineOf(m.index), kind: k });
      }
    }
    if (has("data-i18n") && !el.no) {
      // One phrase with markup in it: the inner HTML as a browser writes it back.
      const open = re.lastIndex;
      let depth = 1, j = open;
      const tag = new RegExp(`<(/?)${name}\\b[^>]*>`, "gi");
      tag.lastIndex = open;
      let t;
      while ((t = tag.exec(src))) { depth += t[1] ? -1 : 1; if (!depth) { j = t.index; break; } }
      out.push({ key: innerHtml(src.slice(open, j), mark), line: lineOf(m.index), kind: "html" });
      re.lastIndex = j;
      continue;
    }
    if (!VOID.has(name) && !m[0].endsWith("/>")) stack.push(el);
  }
  return out;
}

/** The serialisation a browser gives innerHTML, for the small subset the page uses. */
function innerHtml(src, mark) {
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+)/g;
  let out = "", m;
  while ((m = re.exec(src))) {
    if (m[4] !== undefined) { out += reescape(decode(m[4])); continue; }
    if (!m[2]) continue;
    const name = m[2].toLowerCase();
    if (m[1]) { out += `</${name}>`; continue; }
    let attrs = "";
    for (const a of m[3].matchAll(/([\w:@.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attrs += ` ${a[1]}="${decode(a[2] ?? a[3] ?? a[4] ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/ /g, "&nbsp;")}"`;
    }
    out += `<${name}${attrs}>`;
  }
  return squash(out);
}

/* ── placeholders and plurals of a message ── */

/** Placeholder names, and the names that are plural, of a message. */
function shape(msg) {
  const names = new Set(), plurals = new Set(), problems = [];
  const walk = (s) => {
    let i = 0;
    while (i < s.length) {
      if (s[i] === "}") { problems.push("a } with no {"); i++; continue; }
      if (s[i] !== "{") { i++; continue; }
      let depth = 0, j = i;
      for (; j < s.length; j++) { if (s[j] === "{") depth++; else if (s[j] === "}" && !--depth) break; }
      if (j >= s.length) { problems.push("a { never closed"); break; }
      const inner = s.slice(i + 1, j);
      const c = inner.indexOf(",");
      if (c < 0) {
        if (/^\s*\w+\s*$/.test(inner)) names.add(inner.trim()); else problems.push(`odd braces {${inner}}`);
      } else {
        const name = inner.slice(0, c).trim();
        names.add(name);
        const rest = inner.slice(c + 1);
        if (!/^\s*plural\s*,/.test(rest)) problems.push(`only plural is understood: {${name}, …}`);
        else {
          plurals.add(name);
          const body = rest.slice(rest.indexOf(",") + 1);
          let k = 0, other = false;
          while (k < body.length) {
            const o = body.indexOf("{", k);
            if (o < 0) break;
            let d = 0, e = o;
            for (; e < body.length; e++) { if (body[e] === "{") d++; else if (body[e] === "}" && !--d) break; }
            const sel = body.slice(k, o).trim();
            if (!/^(zero|one|two|few|many|other|=\d+)$/.test(sel)) problems.push(`unknown plural form "${sel}"`);
            if (sel === "other") other = true;
            const sub = shape(body.slice(o + 1, e));
            sub.names.forEach((n) => names.add(n));
            sub.plurals.forEach((n) => plurals.add(n));
            sub.problems.forEach((p) => problems.push(p));
            k = e + 1;
          }
          if (!other) problems.push(`{${name}, plural, …} has no "other"`);
        }
      }
      i = j + 1;
    }
  };
  walk(msg);
  return { names, plurals, problems };
}

/* ── sources ── */

const lineIndex = (text) => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return (off) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; } return lo + 1; };
};

const html = read("public/index.html");
const scriptAt = html.indexOf("<script>") + 8;
const pageScript = html.slice(scriptAt, html.indexOf("</script>", scriptAt));
const htmlLine = lineIndex(html);
const markupEnd = html.indexOf('<script type="module"');

const keys = new Map(); // key -> [{ file, line, kind }]
const problems = [];
const note = (key, file, line, kind) => {
  if (!keys.has(key)) keys.set(key, []);
  keys.get(key).push({ file, line, kind });
};
const fail = (file, line, msg) => problems.push(`${file}:${line}  ${msg}`);

/** Everything a tokenized script says: t() keys and the lints. */
function scanScript(file, text, base = 0, lineOf, region = null) {
  const oks = new Set();
  const toks = tokenize(text, base, [], oks);
  const okLines = new Set([...oks].map((o) => lineOf(o)));
  const exempt = (tok) => okLines.has(lineOf(tok.start)) || okLines.has(lineOf(tok.start) - 1);
  const inT = new Array(toks.length).fill(false); // inside the argument list of t(), tw(), ui()
  const sinks = [];

  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.type !== "ident") continue;
    const before = toks[i - 1];
    const dotted = before && before.type === "punct" && (before.v === "." || before.v === "?.");
    const call = toks[i + 1] && toks[i + 1].type === "punct" && toks[i + 1].v === "(";
    if (!call || dotted) continue;
    if (before && before.type === "ident" && (before.v === "function" || before.v === "get" || before.v === "set")) continue;

    if (tk.v === "t" || tk.v === "ui") {
      const { args, close } = callArgs(toks, i + 1);
      for (let k = i + 2; k < close; k++) inT[k] = true;
      const first = args[0] && toks.slice(args[0][0], args[0][1]);
      const lit =
        first && first.length === 1 && first[0].type === "str" ? { text: first[0].v } :
        first && first.length === 1 && first[0].type === "tpl" ? { text: placeholdered(first[0], tk.v === "ui"), tpl: first[0] } : null;
      const line = lineOf(tk.start);
      if (!lit) { if (!exempt(tk)) fail(file, line, `${tk.v}() needs a string literal as its key, or the key cannot be listed`); continue; }
      if (tk.v === "t" && lit.tpl && lit.tpl.exprs.length) { fail(file, line, `t(\`…\${…}…\`): write the placeholder, t("… {name}", { name })`); continue; }
      if (!hasWords(lit.text) && !/\p{L}/u.test(lit.text)) continue;
      note(lit.text, file, line, tk.v);
    } else if (tk.v === "tw") {
      const { close } = callArgs(toks, i + 1);
      for (let k = i + 2; k < close; k++) inT[k] = true;
    } else if (/^(toast|ask|askText|askChoice|openModal|say|confirmRecipients)$/.test(tk.v)) {
      sinks.push(i);
    }
  }

  const looksText = (v) => /\p{L}{2}/u.test(v) && (/\s/.test(v.trim()) || /^[A-Z\p{Lu}]/u.test(v)) && !/^[#.\[]/.test(v) && !/^[a-z]+[A-Z][A-Za-z]*$/.test(v);
  const loneText = (tok) => tok.type === "str" ? tok.v : tok.type === "tpl" ? tok.parts.join("\u0001") : "";
  const opNear = (i) => ["===", "!==", "==", "!="].some((o) => (toks[i - 1] && toks[i - 1].v === o) || (toks[i + 1] && toks[i + 1].v === o));
  const keyProp = (i) => toks[i + 1] && toks[i + 1].type === "punct" && toks[i + 1].v === ":" && toks[i - 1] && toks[i - 1].type === "punct" && [",", "{"].includes(toks[i - 1].v);

  // 1. English handed to a dialog or a toast.
  for (const at of sinks) {
    const { close } = callArgs(toks, at + 1);
    for (let k = at + 2; k < close; k++) {
      const tok = toks[k];
      if (inT[k] || exempt(tok) || (tok.type !== "str" && tok.type !== "tpl") || opNear(k) || keyProp(k)) continue;
      const text = loneText(tok);
      if (!looksText(text.split("\u0001").join("")) ) continue;
      fail(file, lineOf(tok.start), `${toks[at].v}(…) is given English directly: ${JSON.stringify(text.slice(0, 60))} — put it in t()`);
    }
  }

  // 2. English put in a text slot.
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    const prop = toks[i - 1] && toks[i - 1].v === "." && tk.type === "ident" && /^(textContent|innerText|title|placeholder|alt|ariaLabel|label)$/.test(tk.v) && toks[i + 1] && toks[i + 1].v === "=";
    const attr = tk.type === "ident" && tk.v === "setAttribute" && toks[i - 1] && toks[i - 1].v === "." && toks[i + 1] && toks[i + 1].v === "(" && toks[i + 2] && toks[i + 2].type === "str" && ATTRS.includes(toks[i + 2].v) && toks[i + 3] && toks[i + 3].v === ",";
    if (!prop && !attr) continue;
    let j = i + (prop ? 2 : 4);
    for (let depth = 0; j < toks.length; j++) {
      const v = toks[j].type === "punct" ? toks[j].v : "";
      if (v === "(" || v === "[" || v === "{" || v === "${") depth++;
      else if (v === ")" || v === "]" || v === "}") { if (!depth) break; depth--; }
      else if ((v === ";" || v === ",") && !depth) break;
      if (inT[j] || exempt(toks[j]) || (toks[j].type !== "str" && toks[j].type !== "tpl")) continue;
      if (opNear(j)) continue;
      const text = loneText(toks[j]).split("\u0001").join("");
      if (toks[j].type === "tpl" && /</.test(text)) continue; // markup: scanned below
      if (looksText(text)) fail(file, lineOf(toks[j].start), `${tk.v} is given English directly: ${JSON.stringify(text.slice(0, 60))} — put it in t()`);
    }
  }

  // 3. English between the tags of a template or a string of markup.
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if ((tk.type !== "tpl" && tk.type !== "str") || inT[i] || exempt(tk)) continue;
    const text = tk.type === "str" ? tk.v : tk.parts.join("\u0001");
    if (!/<[a-zA-Z][^>]*>/.test(text) || /<(style|script|meta|!doctype)/i.test(text)) continue;
    let found;
    try { found = markup(text, () => lineOf(tk.start)); } catch { continue; }
    for (const f of found) {
      const bare = f.key.split("\u0001").join("");
      if (!hasWords(bare)) continue;
      fail(file, lineOf(tk.start), `markup in a template carries English (${f.kind}): ${JSON.stringify(f.key.slice(0, 60))} — put it in \${t("…")}`);
    }
  }

  // 4. A local `t` that hides the translator where it is called.
  const scopes = [];
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.type !== "ident" || tk.v !== "t") continue;
    const before = toks[i - 1], after = toks[i + 1];
    if (before && before.v === ".") continue;
    let from = -1, to = -1;
    if (before && before.type === "ident" && /^(const|let|var)$/.test(before.v)) {
      // to the end of the block that holds it
      let depth = 0;
      from = i; to = toks.length;
      for (let j = i; j < toks.length; j++) { const v = toks[j].type === "punct" ? toks[j].v : ""; if (v === "{" || v === "${") depth++; else if (v === "}") { if (!depth) { to = j; break; } depth--; } }
    } else if (after && after.v === "=>") {
      from = i; to = arrowEnd(toks, i + 2);
    } else if (before && (before.v === "(" || before.v === ",") && after && (after.v === ")" || after.v === "," || after.v === "=")) {
      // a parameter: it is one when the ")" that closes this list is followed by => or {
      const open = (() => { let d = 0; for (let j = i - 1; j >= 0; j--) { const v = toks[j].v; if (toks[j].type === "punct") { if (v === ")") d++; else if (v === "(") { if (!d) return j; d--; } } } return -1; })();
      if (open < 0) continue;
      const close = match(toks, open);
      const next = toks[close + 1];
      if (next && next.v === "=>") { from = i; to = arrowEnd(toks, close + 2); }
      else if (next && next.v === "{" && toks[open - 1] && (toks[open - 1].type === "ident" || toks[open - 1].v === ")")) { from = i; to = match(toks, close + 1); }
      else continue;
    } else if (before && before.type === "ident" && before.v === "of" || (before && before.v === "(" && toks[i - 2] && /^(for)$/.test(toks[i - 2].v))) continue;
    if (from >= 0) scopes.push([from, to, tk]);
  }
  for (const [from, to, decl] of scopes) {
    for (let j = from + 1; j < to; j++) {
      if (toks[j].type === "ident" && toks[j].v === "t" && toks[j + 1] && toks[j + 1].v === "(" && !(toks[j - 1] && toks[j - 1].v === ".")) {
        if (!exempt(toks[j])) fail(file, lineOf(toks[j].start), `t() is called where the local t declared on line ${lineOf(decl.start)} hides it`);
      }
    }
  }

  if (region) return { toks, lineOf, inT, exempt };
  return { toks, lineOf, inT, exempt };
}

/** Where an arrow function's body ends: the closing brace, or the end of the expression. */
function arrowEnd(toks, at) {
  if (toks[at] && toks[at].v === "{") return match(toks, at);
  let depth = 0;
  for (let j = at; j < toks.length; j++) {
    const v = toks[j].type === "punct" ? toks[j].v : "";
    if (v === "(" || v === "[" || v === "{" || v === "${") depth++;
    else if (v === ")" || v === "]" || v === "}") { if (!depth) return j; depth--; }
    else if ((v === "," || v === ";") && !depth) return j;
  }
  return toks.length;
}

/**
 * A template's text with each ${…} written as {name}. For t() there are none
 * (it refuses them). For ui(), the Worker's own template: a plain identifier or
 * dotted path keeps its last name, any other expression is n1, n2…
 */
function placeholdered(tok, naming) {
  let out = tok.parts[0], n = 0;
  const seen = new Map();
  tok.exprs.forEach((e, i) => {
    n++;
    let name = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(e.trim()) ? e.trim().split(".").pop() : `n${n}`;
    if (naming) {
      const c = (seen.get(name) || 0) + 1;
      seen.set(name, c);
      if (c > 1) name += c;
    }
    out += `{${name}}` + tok.parts[i + 1];
  });
  return out;
}

/* the page: markup, then the scripts */
const pageMarkup = markup(html.slice(0, markupEnd), htmlLine);
for (const m of pageMarkup) note(m.key, "public/index.html", m.line, m.kind);

const pageLine = (off) => htmlLine(scriptAt + off);
const pageScan = scanScript("public/index.html", pageScript, 0, pageLine);

for (const f of ["public/sendguard.js", "public/senderguard.js", "public/reaction.js", "public/sw.js"]) {
  const text = read(f);
  scanScript(f, text, 0, lineIndex(text));
}

/* the Worker: its pages and its ui() texts */
const srcFiles = readdirSync(new URL("src/", root)).filter((f) => f.endsWith(".js")).map((f) => `src/${f}`);
for (const f of srcFiles) {
  const text = read(f);
  const lineOf = lineIndex(text);
  const { toks, inT, exempt } = scanScript(f, text, 0, lineOf);
  if (f === "src/index.js") {
    for (const tk of toks) {
      if (tk.type !== "tpl" || !/<!doctype html>/i.test(tk.parts[0] || "")) continue;
      for (const m of markup(tk.parts.join("\u0001"), () => lineOf(tk.start))) note(m.key, f, lineOf(tk.start), m.kind);
      // The page's own script is written to use t() through var t = StratusI18n.t.
      scanScript(f, tk.parts.join("\u0001"), tk.start, lineOf);
    }
  }
  // error: "…" and the like must be marked, or the device cannot know to translate them.
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.type !== "ident" || tk.v !== "error" || !toks[i + 1] || toks[i + 1].v !== ":") continue;
    const v = toks[i + 2];
    if (v && (v.type === "str" || v.type === "tpl") && !exempt(v) && /\p{L}{2}/u.test(v.type === "str" ? v.v : v.parts.join(""))) {
      fail(f, lineOf(v.start), `error: is given English directly: write error: ui(…) so the device can translate it`);
    }
  }
}

/* ── the dictionaries ── */

function loadLanguage(file) {
  const defined = {};
  const sandbox = { StratusI18n: { define: (code, def) => { defined[code] = def; } } };
  vm.runInNewContext(read(`public/${file}`), sandbox, { filename: file });
  return defined;
}

const i18n = (() => {
  const sandbox = {};
  vm.runInNewContext(read("public/i18n.js"), Object.assign(sandbox, { globalThis: sandbox }), { filename: "i18n.js" });
  return sandbox.StratusI18n;
})();
const languages = i18n.LANGUAGES.filter((l) => l.file);

/** Rules of a language's own typography, on top of the checks every language gets. */
const typography = {
  fr(key, text) {
    const out = [];
    const bare = text.replace(/\{[^{}]*\}/g, "").replace(/<[^>]*>/g, "");
    if (/[']/.test(bare)) out.push("straight apostrophe: use ’");
    if (/"/.test(bare)) out.push("straight quote: use « » or “ ”");
    if (/\.\.\./.test(bare)) out.push("three dots: use …");
    if (/[^ \s][;!?]($|[\s)”»])/.test(bare) || /[^ \s(][:](\s|$)/.test(bare)) out.push("a ; : ! ? needs a narrow no-break space (U+202F) before it");
    if (/[  ][;:!?]/.test(bare)) out.push("an ordinary space before ; : ! ? — use U+202F");
    if (/«(?! )/.test(bare) || /(?<! )»/.test(bare)) out.push("« » need a narrow no-break space (U+202F) inside");
    return out;
  },
};

/* ── the checks ── */

const argv = process.argv.slice(2);
if (argv.includes("--find")) {
  // Everything in the page's script that reads like a sentence and is not inside t(): to be looked at.
  const { toks, inT, lineOf } = pageScan;
  const seen = new Set();
  toks.forEach((tok, i) => {
    if (inT[i] || (tok.type !== "str" && tok.type !== "tpl")) return;
    const text = tok.type === "str" ? tok.v : tok.parts.join("{}");
    if (!/\p{L}{3}/u.test(text.replace(/<[^>]*>/g, "")) || /^[#.\[:*>~+-]/.test(text) || /^[\w./:@-]+$/.test(text)) return;
    if (/^[a-z-]+\s*:\s/.test(text) && /;/.test(text)) return; // css
    if (!/\s/.test(text.trim()) && !/^[A-Z]/.test(text)) return;
    const line = lineOf(tok.start);
    const k = line + text;
    if (seen.has(k)) return;
    seen.add(k);
    console.log(`${line}\t${text.replace(/\s+/g, " ").slice(0, 110)}`);
  });
  process.exit(0);
}

if (argv.includes("--keys")) {
  console.log(JSON.stringify([...keys].map(([key, where]) => ({ key, where: where.map((w) => `${w.file}:${w.line}`) })), null, 1));
  process.exit(0);
}

let ok = true;
const report = (label, list) => {
  if (!list.length) { console.log(`  ok    ${label}`); return; }
  ok = false;
  console.log(`  FAIL  ${label}`);
  for (const l of list.slice(0, 80)) console.log(`          ${l}`);
  if (list.length > 80) console.log(`          … and ${list.length - 80} more`);
};

for (const k of keys.keys()) {
  const s = shape(k);
  for (const p of s.problems) problems.push(`key ${JSON.stringify(k.slice(0, 50))}  ${p}`);
}

if (argv.includes("--missing")) {
  const dicts = languages.map((l) => loadLanguage(l.file.slice(1))[l.code].strings);
  console.log(JSON.stringify([...keys].filter(([k]) => dicts.some((d) => !(k in d))).map(([key, where]) => ({ key, where: where.map((w) => `${w.file}:${w.line}`) })), null, 1));
  process.exit(0);
}

console.log("\ninterface text checks");
console.log(`  ${keys.size} keys: ${[...keys.values()].reduce((n, w) => n + w.length, 0)} uses`);
report("text goes through t(), and every t() key is a literal", problems);

for (const lang of languages) {
  const def = loadLanguage(lang.file.slice(1))[lang.code];
  const strings = def && def.strings;
  if (!strings) { report(`${lang.label}: ${lang.file} defines "${lang.code}"`, [`${lang.file} does not call StratusI18n.define("${lang.code}", { strings })`]); continue; }
  const missing = [], dead = [], shapes = [], typo = [], twice = [];
  // An object literal keeps the last of two equal keys and says nothing, so the file is read as text.
  const seen = new Set();
  for (const m of read(`public/${lang.file.slice(1)}`).matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:/gm)) {
    const k = JSON.parse(`"${m[1]}"`);
    if (seen.has(k)) twice.push(JSON.stringify(k.slice(0, 90)));
    seen.add(k);
  }
  for (const k of keys.keys()) if (!(k in strings)) missing.push(`${JSON.stringify(k.slice(0, 90))}  ${keys.get(k)[0].file}:${keys.get(k)[0].line}`);
  for (const [k, v] of Object.entries(strings)) {
    if (!keys.has(k)) dead.push(JSON.stringify(k.slice(0, 90)));
    if (typeof v !== "string" || !v) { shapes.push(`${JSON.stringify(k.slice(0, 50))}  is empty`); continue; }
    const en = shape(k), tr = shape(v);
    const lost = [...en.names].filter((n) => !tr.names.has(n));
    const extra = [...tr.names].filter((n) => !en.names.has(n));
    if (lost.length) shapes.push(`${JSON.stringify(k.slice(0, 50))}  lacks {${lost.join("}, {")}}`);
    if (extra.length) shapes.push(`${JSON.stringify(k.slice(0, 50))}  has {${extra.join("}, {")}} which the English does not`);
    const flat = [...en.plurals].filter((n) => !tr.plurals.has(n));
    if (flat.length) shapes.push(`${JSON.stringify(k.slice(0, 50))}  does not count {${flat.join("}, {")}} as the English does`);
    // Text goes into the page as it is: markup in it would be markup there.
    if (!/[<>]/.test(k) && /[<>&"]/.test(v)) shapes.push(`${JSON.stringify(k.slice(0, 50))}  has markup characters (< > & ") the English does not`);
    for (const p of tr.problems) shapes.push(`${JSON.stringify(k.slice(0, 50))}  ${p}`);
    if (typography[lang.code]) for (const p of typography[lang.code](k, v)) typo.push(`${JSON.stringify(k.slice(0, 50))}  ${p}`);
    if (/\s{2,}|^\s|\s$/.test(v.replace(/ /g, "x")) && !/^\s|\s$/.test(k)) typo.push(`${JSON.stringify(k.slice(0, 50))}  stray spaces`);
  }
  console.log(`\n${lang.label} (${Object.keys(strings).length} entries)`);
  report("no string entered twice", twice);
  report("every string has an entry", missing);
  report("no entry without a string", dead);
  report("placeholders and plurals agree with the English", shapes);
  report("typography", typo);
}

// The service worker precaches the languages from the table, so only the page's own files are listed.
const sw = read("public/sw.js");
const listed = ["/i18n.js"].filter((f) => !sw.includes(`"${f}"`));
report("the service worker precaches i18n.js and the languages in its table", listed.concat(sw.includes("LANGUAGES.filter") ? [] : ["sw.js does not precache the language files from LANGUAGES"]));

console.log(ok ? "\ni18n OK" : "\ni18n FAILED");
process.exit(ok ? 0 : 1);
