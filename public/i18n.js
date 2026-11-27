/**
 * The interface language.
 *
 * English is the key. The page, the service worker and the Worker's replies
 * all write English, and this file looks that English up in the dictionary of
 * the language in use; with no entry, or in English, it is the English that
 * shows. A language is one more file beside i18n-fr.js that calls define(),
 * and one more row in LANGUAGES below. Nothing else changes: the service
 * worker precaches the files named here, and the page loads the one it needs.
 *
 *   t("Moved to {folder}", { folder })
 *   t("{n, plural, one {# message} other {# messages}}", { n })
 *
 * A sentence is one key, so a language is free to put the words in its own
 * order. Counts use the language's own plural rule (French counts 0 and 1 as
 * singular, English only 1), which is why a plural is written inside the key
 * and never as `n === 1 ? "" : "s"` at the call site.
 *
 * The language is chosen per device and applies from the next load: switching
 * stores the choice and reloads. That keeps every render path simple, because
 * a string is looked up once, where it is written, and never has to be
 * redrawn into another language.
 *
 * This file is a classic script and a module at once: the page loads it from
 * <head>, the service worker with importScripts, and a test by importing it.
 * It runs once per realm; a second run keeps the first.
 */
(function () {
  "use strict";
  const root = globalThis;
  if (root.StratusI18n) return;

  /** English needs no file. `file` is what a language adds. */
  const LANGUAGES = [
    { code: "en", label: "English" },
    { code: "fr", label: "Français", file: "/i18n-fr.js" },
  ];

  const PREF_KEY = "dmzs-lang";
  /** Where the page leaves the language for the service worker, which cannot read localStorage. */
  const HANDOFF_CACHE = "stratus-prefs";
  const HANDOFF_URL = "/__lang";

  const defined = {};
  let code = "en";
  let locale = "en";
  let strings = {};
  let patterns = null;

  const known = (c) => LANGUAGES.some((l) => l.code === c);

  /** The dictionary and locale of a language, called by its file when it loads. */
  function define(lang, def) {
    defined[lang] = def;
    if (lang === code) use(lang);
  }

  /**
   * The language a stored choice means on this device: "system" is the first
   * language the browser lists that we have, English when none is.
   */
  function resolve(pref) {
    if (known(pref) && pref !== "system") return pref;
    const wanted = (root.navigator && (navigator.languages || [navigator.language])) || [];
    for (const tag of wanted) {
      const c = String(tag || "").slice(0, 2).toLowerCase();
      if (known(c)) return c;
    }
    return "en";
  }

  function localeFor(lang) {
    const own = root.navigator && navigator.language;
    // The browser's own regional variant when it is the same language: a
    // Canadian or Swiss French keeps its own dates and number format.
    if (own && String(own).slice(0, 2).toLowerCase() === lang) return own;
    return (defined[lang] && defined[lang].locale) || lang;
  }

  function use(lang) {
    code = known(lang) ? lang : "en";
    locale = localeFor(code);
    strings = (defined[code] && defined[code].strings) || {};
    patterns = null;
    plural = null;
    numberFormat = null;
  }

  let plural = null;
  let numberFormat = null;
  function pluralCategory(n) {
    if (!plural) {
      try { plural = new Intl.PluralRules(locale); } catch { plural = new Intl.PluralRules("en"); }
    }
    return plural.select(n);
  }

  function formatNumber(n) {
    if (!numberFormat) {
      try { numberFormat = new Intl.NumberFormat(locale); } catch { numberFormat = new Intl.NumberFormat("en"); }
    }
    return numberFormat.format(n);
  }

  /* ── messages ── */

  /** The index of the "}" that closes the "{" at `from`, or -1. */
  function closing(text, from) {
    let depth = 0;
    for (let i = from; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) return i;
    }
    return -1;
  }

  /** The first top-level comma of `s`, or -1. */
  function comma(s) {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "{") depth++;
      else if (s[i] === "}") depth--;
      else if (s[i] === "," && depth === 0) return i;
    }
    return -1;
  }

  /** `one {…} other {…}` as [selector, body] pairs. */
  function branches(s) {
    const out = [];
    let i = 0;
    while (i < s.length) {
      while (i < s.length && /\s/.test(s[i])) i++;
      const open = s.indexOf("{", i);
      if (open < 0) break;
      const end = closing(s, open);
      if (end < 0) break;
      out.push([s.slice(i, open).trim(), s.slice(open + 1, end)]);
      i = end + 1;
    }
    return out;
  }

  /**
   * One message with its values. A placeholder with no value stays as written,
   * "{name}", so a missing one is seen in the page and never printed as
   * "undefined".
   */
  function format(message, values, count) {
    let out = "";
    let i = 0;
    while (i < message.length) {
      const c = message[i];
      if (c === "#" && count !== undefined) { out += formatNumber(count); i++; continue; }
      if (c !== "{") { out += c; i++; continue; }
      const end = closing(message, i);
      if (end < 0) { out += message.slice(i); break; }
      const inner = message.slice(i + 1, end);
      const split = comma(inner);
      if (split < 0) {
        const v = values && values[inner.trim()];
        out += v === undefined || v === null ? message.slice(i, end + 1) : String(v);
      } else {
        const name = inner.slice(0, split).trim();
        const rest = inner.slice(split + 1);
        const kind = rest.slice(0, comma(rest) < 0 ? rest.length : comma(rest)).trim();
        const list = branches(comma(rest) < 0 ? "" : rest.slice(comma(rest) + 1));
        const n = values && Number(values[name]);
        if (kind !== "plural" || !list.length || values == null || values[name] == null || Number.isNaN(n)) {
          out += message.slice(i, end + 1);
        } else {
          const exact = list.find(([sel]) => sel === `=${n}`);
          const pick = exact || list.find(([sel]) => sel === pluralCategory(n)) || list.find(([sel]) => sel === "other");
          out += pick ? format(pick[1], values, n) : message.slice(i, end + 1);
        }
      }
      i = end + 1;
    }
    return out;
  }

  /** The English, or its translation, with the values put in. */
  function t(text, values) {
    const found = strings[text];
    const message = found === undefined ? text : found;
    return values === undefined || message.indexOf("{") < 0 ? message : format(message, values);
  }

  /* ── text the Worker wrote ── */

  /**
   * An entry whose English has placeholders, as the pattern that recognises
   * the English once its values are filled in. Plurals are skipped: the Worker
   * writes its own words for one and for many, and each is its own entry.
   */
  function compile() {
    patterns = [];
    for (const key of Object.keys(strings)) {
      if (key.indexOf("{") < 0 || /\{\s*\w+\s*,/.test(key)) continue;
      const names = [];
      const source = key
        .split(/\{(\w+)\}/)
        .map((part, i) => {
          if (i % 2 === 0) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          names.push(part);
          return "([\\s\\S]+?)";
        })
        .join("");
      const literal = key.replace(/\{\w+\}/g, "").length;
      patterns.push({ key, names, re: new RegExp(`^${source}$`), literal });
    }
    // The most specific first: more fixed words means fewer strings it can swallow.
    patterns.sort((a, b) => b.literal - a.literal);
  }

  /**
   * English text the Worker (or the page, from a value) already filled in,
   * through the dictionary: an exact entry, or an entry with placeholders that
   * the text matches. Anything else comes back as it was.
   */
  function tw(text) {
    if (typeof text !== "string" || code === "en" || !text) return text;
    const exact = strings[text];
    if (exact !== undefined) return exact.indexOf("{") < 0 ? exact : format(exact, {});
    if (!patterns) compile();
    for (const p of patterns) {
      const m = p.re.exec(text);
      if (!m) continue;
      const values = {};
      p.names.forEach((n, i) => { values[n] = m[i + 1]; });
      return format(strings[p.key], values);
    }
    return text;
  }

  /* ── the document ── */

  const ATTRS = ["aria-label", "title", "placeholder", "alt", "data-ph"];
  const done = typeof WeakSet === "function" ? new WeakSet() : null;
  const squash = (s) => s.replace(/\s+/g, " ").trim();

  /**
   * Static markup, through the same dictionary: every text node and the
   * aria-label, title, placeholder, alt and data-ph of every element, matched by its
   * text with whitespace squashed. An element with data-i18n is one phrase
   * with markup in it, matched by its whole inner HTML. translate="no" keeps a
   * subtree as it is.
   */
  function apply(scope) {
    if (code === "en" || !root.document) return;
    const top = scope || document;
    const skip = (el) => !!el.closest("[translate=no], script, style");
    for (const el of top.querySelectorAll("[data-i18n]")) {
      if (skip(el)) continue;
      const found = strings[squash(el.innerHTML)];
      if (found !== undefined) el.innerHTML = found;
    }
    const walker = document.createTreeWalker(top.nodeType === 9 ? top.body || top.documentElement : top, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    for (const node of nodes) {
      if (done && done.has(node)) continue;
      const raw = node.nodeValue;
      const key = squash(raw);
      if (!key) continue;
      const found = strings[key];
      if (found === undefined || (node.parentElement && skip(node.parentElement))) continue;
      node.nodeValue = raw.slice(0, raw.length - raw.trimStart().length) + found + raw.slice(raw.trimEnd().length);
      if (done) done.add(node);
    }
    const sel = ATTRS.map((a) => `[${a}]`).join(",");
    const els = top.nodeType === 1 && top.matches(sel) ? [top, ...top.querySelectorAll(sel)] : [...top.querySelectorAll(sel)];
    for (const el of els) {
      if (skip(el)) continue;
      for (const a of ATTRS) {
        if (!el.hasAttribute(a)) continue;
        const found = strings[squash(el.getAttribute(a))];
        if (found !== undefined) el.setAttribute(a, found);
      }
    }
    if (top.nodeType === 9) {
      const found = strings[squash(document.title)];
      if (found !== undefined) document.title = found;
    }
  }

  /* ── the choice ── */

  function preference() {
    try { return localStorage.getItem(PREF_KEY) || "system"; } catch { return "system"; }
  }

  /** Stores the choice. The caller reloads: nothing already drawn is redrawn. */
  function setPreference(pref) {
    try {
      if (pref === "system") localStorage.removeItem(PREF_KEY);
      else localStorage.setItem(PREF_KEY, pref);
    } catch {}
  }

  /** What the service worker reads, since localStorage is not open to it. */
  function handOff() {
    try {
      if (!root.caches) return;
      caches.open(HANDOFF_CACHE).then((c) => c.put(HANDOFF_URL, new Response(code))).catch(() => {});
    } catch {}
  }

  /** In the worker: the language the page last handed over, once. */
  async function adopt() {
    try {
      const hit = await caches.match(HANDOFF_URL);
      const lang = hit ? (await hit.text()).trim() : "en";
      if (lang !== code) use(lang);
    } catch {}
  }

  const api = {
    LANGUAGES, PREF_KEY, HANDOFF_CACHE,
    define, use, resolve, preference, setPreference, handOff, adopt,
    t, tw, apply, format,
    get code() { return code; },
    get locale() { return locale; },
  };
  root.StratusI18n = api;

  if (root.document && root.document.documentElement) {
    use(resolve(preference()));
    document.documentElement.lang = code;
    const lang = LANGUAGES.find((l) => l.code === code);
    // Written into the page rather than appended later, so the dictionary is
    // there before the page's own script asks for the first string.
    if (lang && lang.file && document.readyState === "loading") {
      document.write(`<script src="${lang.file}"><\/script>`);
    }
  }
})();
