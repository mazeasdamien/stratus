/**
 * Right-to-left mail: what the sanitiser leaves of a sender's direction, and
 * which way the client lays out plain text. The Hebrew and Arabic below is
 * invented greeting text.
 */
import { eq, ok } from "./harness.mjs";
import { sanitizeHtml } from "../src/mime.js";
import { clientFns } from "./client-fns.mjs";

const { textDir, plainDir, quoteDir } = clientFns(["RTL_SCRIPT", "textDir", "plainDir", "quoteDir", "PLAIN_OPEN", "isPlainText"]);

console.log("\n-- rtl : le défuseur garde la direction de l'expéditeur ---------");
{
  const keep = (html) => sanitizeHtml(html).html;

  eq(keep('<div dir="rtl"><p dir="ltr">x</p></div>'), '<div dir="rtl"><p dir="ltr">x</p></div>', "dir sur les éléments");
  const css = '<p style="direction:rtl;unicode-bidi:embed;text-align:right">שלום</p>';
  eq(keep(css), css, "direction, unicode-bidi et text-align dans style");
  ok(/direction:\s*rtl/.test(keep("<style>.a{direction:rtl;unicode-bidi:bidi-override;text-align:right}</style><p class=a>x</p>")), "et dans un bloc <style>");
  ok(/dir="rtl"/.test(keep('<html dir="rtl"><body dir="rtl"><p>مرحبا</p></body></html>')), "dir sur html et body");

  // What still goes. The direction properties do not widen the door: a url()
  // next to them takes the whole attribute, as it always did.
  const bad = keep('<p style="direction:rtl;background:url(https://t.example/p.gif)">x</p>');
  ok(!/url\(/i.test(bad) && !/direction/.test(bad), "un style avec url() est retiré entier, direction comprise");
  ok(!/url\(/i.test(keep('<p style="background:u\\72l(https://t.example/p.gif)">x</p>')), "url() écrit avec un échappement");
  ok(!/\son\w+=/i.test(keep('<p dir="rtl" onclick="x()">x</p>')) && /dir="rtl"/.test(keep('<p dir="rtl" onclick="x()">x</p>')), "un gestionnaire d'événement part, dir reste");
}

console.log("\n-- rtl : direction d'un texte ---------");
{
  eq(textDir("שלום עולם"), "rtl", "hébreu d'abord");
  eq(textDir("مرحبا بالعالم"), "rtl", "arabe d'abord");
  eq(textDir("Hello עולם"), "ltr", "latin d'abord, même suivi d'hébreu");
  eq(textDir("שלום world"), "rtl", "hébreu d'abord, même suivi de latin");
  eq(textDir("123 — (45) שלום"), "rtl", "chiffres et ponctuation sans direction : la première lettre décide");
  eq(textDir("2026-11-27 Hello"), "ltr", "chiffres puis latin");
  eq(textDir("١٢٣ مرحبا"), "rtl", "chiffres arabes : sans direction non plus");
  eq(textDir(">> \"…\" שלום"), "rtl", "guillemets et chevrons ignorés");
  eq(textDir("‏abc"), "rtl", "une marque RLM décide");
  eq(textDir("‎שלום"), "ltr", "une marque LRM décide");
  eq(textDir("ܫܠܡܐ"), "rtl", "syriaque");
  eq(textDir(""), "ltr", "vide");
  eq(textDir("   \n 123 !?"), "ltr", "rien de fort : de gauche à droite");
  eq(textDir(undefined), "ltr", "undefined");
  eq(textDir(" ".repeat(5000) + "שלום"), "ltr", "au-delà des 2000 premiers caractères on ne cherche plus");

  // The plain-text wrapper the server writes: entities and links are not text.
  const wrap = (inner) => `<div style="white-space:pre-wrap;word-break:break-word">${inner}</div>`;
  eq(plainDir(wrap("&gt;&gt; שלום")), "rtl", "&gt; d'une ligne citée n'est pas un mot latin");
  eq(plainDir(wrap('<a href="https://x.example" target="_blank" rel="noopener noreferrer">https://x.example</a> שלום')), "ltr", "un lien qui ouvre le texte est du latin");
  eq(quoteDir(wrap("שלום")), "rtl", "citation d'un texte brut hébreu");
  eq(quoteDir(wrap("Hello")), "ltr", "citation d'un texte brut latin");
  eq(quoteDir('<div dir="rtl"><p>مرحبا</p></div>'), "rtl", "citation d'un HTML qui dit dir=rtl");
  eq(quoteDir("<p dir='ltr'>שלום</p>"), "ltr", "un dir=ltr de l'expéditeur l'emporte sur le texte");
  eq(quoteDir("<p>مرحبا</p>"), "ltr", "HTML sans dir : on ne devine pas");
}
