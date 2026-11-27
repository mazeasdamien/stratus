/**
 * Tests for the parts that rot silently: header decoding, addresses,
 * message building, HTML defusing, token sealing.
 * Run with: node test.mjs
 */
import {
  decodeWords,
  qpDecode,
  parseAddress,
  parseAddressList,
  normalizeSubject,
  encodeHeader,
  buildRfc822,
  sanitizeHtml,
  textToHtml,
  blockMatches,
  isBlockPattern,
  b64encode,
  b64decode,
  htmlToText,
} from "./src/mime.js";
import {
  parseSexp,
  flattenStructure,
  parseHeaders,
  parseParams,
  splitParts,
  decodePart,
  parseMessage,
} from "./src/rfc822.js";
import { seal, open } from "./src/crypto.js";
import { BODY_VERSION, bodyFromParts, unsubFromHeaders } from "./src/body.js";
import { MailAuthError, isAuthFailure } from "./src/errors.js";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { OPERATORS, parseSearch } from "./src/query.js";
import { SCHEMA } from "./src/schema.js";

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; }
  else { fail++; console.log(`  ✗ ${label}`); }
};
const eq = (a, b, label) =>
  ok(JSON.stringify(a) === JSON.stringify(b), `${label} — reçu ${JSON.stringify(a)}, attendu ${JSON.stringify(b)}`);

console.log("\n── en-têtes RFC 2047 ───────────────────────");
eq(decodeWords("=?UTF-8?B?w4l0w6k=?="), "Été", "B-encoding utf-8");
eq(decodeWords("=?utf-8?Q?caf=C3=A9_cr=C3=A8me?="), "café crème", "Q-encoding, _ = espace");
eq(decodeWords("=?ISO-8859-1?Q?d=E9j=E0?="), "déjà", "latin-1");
eq(decodeWords("=?UTF-8?B?QQ==?= =?UTF-8?B?Qg==?="), "AB", "l'espace entre deux mots encodés disparaît");
eq(decodeWords("Re: =?utf-8?B?ZMOpcGxvaWVtZW50?="), "Re: déploiement", "mélange brut + encodé");
eq(decodeWords("rien à décoder"), "rien à décoder", "texte simple inchangé");

console.log("\n── quoted-printable ────────────────────────");
eq(qpDecode("caf=C3=A9"), "café", "octets encodés");
eq(qpDecode("ligne =\r\ncoup=C3=A9e"), "ligne coupée", "retour souple absorbé");

console.log("\n── adresses ────────────────────────────────");
eq(parseAddress('"Jean Dupont" <jean@x.fr>'), { name: "Jean Dupont", email: "jean@x.fr" }, "guillemets + chevrons");
eq(parseAddress("jean@x.fr"), { name: "", email: "jean@x.fr" }, "adresse nue");
eq(parseAddress("Jean <JEAN@X.FR>"), { name: "Jean", email: "jean@x.fr" }, "casse normalisée");
eq(parseAddress("=?utf-8?B?SsOpcsO0bWU=?= <j@x.fr>").name, "Jérôme", "nom encodé décodé");
eq(parseAddressList('"Dupont, Jean" <j@x.fr>, b@y.fr').length, 2, "virgule entre guillemets ignorée");
eq(parseAddressList("a@x.fr, b@y.fr, pas-une-adresse").length, 2, "les déchets sont filtrés");
// Outlook écrit un destinataire non résolu 'comme@ceci.fr'. Gardées, ces
// apostrophes arrivent jusqu'au RCPT TO et Apple refuse tout le message.
eq(parseAddress("'jean@x.fr'"), { name: "", email: "jean@x.fr" }, "apostrophes d'Outlook retirées");
eq(parseAddress("<'jean@x.fr'>"), { name: "", email: "jean@x.fr" }, "apostrophes dans les chevrons");
eq(parseAddress("o'brien@x.fr").email, "o'brien@x.fr", "apostrophe interne conservée");
eq(
  parseAddressList("'a@x.fr', b@y.fr").map((a) => a.email),
  ["a@x.fr", "b@y.fr"],
  "liste : citée puis nue"
);

console.log("\n── sujets et fils ──────────────────────────");
eq(normalizeSubject("Re: Re: FWD: Hello"), "hello", "préfixes empilés retirés");
eq(normalizeSubject("RE : bonjour"), "bonjour", "variante française RE :");
eq(normalizeSubject("Hello"), "hello", "sans préfixe");

console.log("\n── message sortant ─────────────────────────");
const raw = buildRfc822({
  from: "damien@x.fr",
  to: "ami@y.fr",
  subject: "Été à Brest",
  text: "Salut — ça marche.",
  inReplyTo: "<abc@mx>",
});
ok(raw.includes("From: damien@x.fr"), "From présent");
ok(raw.includes("Subject: =?utf-8?B?"), "sujet non-ASCII encodé");
ok(raw.includes("In-Reply-To: <abc@mx>"), "In-Reply-To présent");
ok(raw.includes("References: <abc@mx>"), "References présent");
ok(/\r\n\r\n[A-Za-z0-9+/=\r\n]+\r\n$/.test(raw), "corps en base64");
eq(encodeHeader("plain ascii"), "plain ascii", "ASCII pur laissé tel quel");
{
  const body = raw.split("\r\n\r\n")[1].replace(/\r\n/g, "");
  const round = new TextDecoder().decode(b64decode(b64encode(new TextEncoder().encode("Salut — ça marche."))));
  eq(round, "Salut — ça marche.", "aller-retour base64 fidèle");
  ok(body.length > 0, "corps non vide");
}

console.log("\n── copies cachées ──────────────────────────");
{
  // buildRfc822 n'écrit JAMAIS de Bcc. Un tel en-tête partirait tel quel chez
  // tout le monde, ce qui est l'inverse de « caché » : les destinataires
  // invisibles ne vivent que dans l'enveloppe SMTP, jamais dans le message.
  ok(!raw.includes("Bcc:"), "pas de Bcc quand aucun n'est passé");

  const avec = buildRfc822({
    from: "d@x.fr", to: "a@y.fr", cc: "c@y.fr", subject: "Salut", text: "corps",
  });
  ok(avec.includes("Cc: c@y.fr"), "Cc présent");
  ok(!/^Bcc:/im.test(avec), "aucun en-tête Bcc");

  // Et même en le passant : le paramètre n'existe plus, donc rien ne doit
  // ressortir. C'est ce test qui garde le piège refermé pour la suite.
  const force = buildRfc822({
    from: "d@x.fr", to: "a@y.fr", bcc: "secret@y.fr", subject: "Salut", text: "corps",
  });
  ok(!force.includes("secret@y.fr"), "un bcc passé par erreur ne fuit pas");
  ok(!/^Bcc:/im.test(force), "un bcc passé par erreur n'écrit pas d'en-tête");

  // Le brouillon est le seul message qui n'est envoye a personne : son en-tete
  // Bcc est ce qui fait survivre le champ a la fermeture du compositeur. Il
  // porte un autre nom pour qu'on ne puisse pas l'obtenir par megarde.
  const brouillon = buildRfc822({
    from: "d@x.fr", to: "a@y.fr", draftBcc: "cache@y.fr", subject: "Salut", text: "corps",
  });
  ok(/^Bcc: cache@y\.fr$/im.test(brouillon), "un brouillon garde ses destinataires caches");
  const envoye = buildRfc822({
    from: "d@x.fr", to: "a@y.fr", bcc: "cache@y.fr", subject: "Salut", text: "corps",
  });
  ok(!envoye.includes("cache@y.fr"), "le meme champ sous le nom bcc reste ignore");

  // Idem en multipart, où l'en-tête se glisserait dans une autre section.
  const rich = buildRfc822({ from: "d@x.fr", to: "a@y.fr", html: "<p>x</p>", bcc: "secret@z.fr" });
  ok(!/^Bcc:/im.test(rich), "pas de Bcc fantôme en multipart");
  ok(!rich.includes("secret@z.fr"), "l'adresse cachée n'apparaît nulle part");
}

console.log("\n── message HTML sortant ────────────────────");
{
  const rich = buildRfc822({
    from: "d@x.fr",
    to: "a@y.fr",
    subject: "Salut",
    text: "version texte",
    html: "<p>version <b>riche</b></p>",
  });
  const bnd = /boundary="([^"]+)"/.exec(rich)[1];
  ok(rich.includes("Content-Type: multipart/alternative"), "multipart/alternative");
  const chunks = rich.split("--" + bnd);
  ok(chunks[1].includes("text/plain"), "part 1 = texte brut");
  ok(chunks[2].includes("text/html"), "part 2 = html (la plus riche en dernier)");
  ok(rich.trimEnd().endsWith("--" + bnd + "--"), "boundary de fermeture présent");

  // Le vrai test : ce qu'on écrit doit se relire avec notre propre analyseur.
  const back = parseMessage(rich);
  eq(back.text, "version texte", "aller-retour MIME : texte");
  eq(back.html, "<p>version <b>riche</b></p>", "aller-retour MIME : html");

  // Sans part texte fournie, elle est dérivée du HTML plutôt qu'omise.
  const derived = parseMessage(buildRfc822({ from: "d@x.fr", to: "a@y.fr", html: "<p>un</p><p>deux</p>" }));
  eq(derived.text, "un\ndeux", "part texte dérivée du HTML");

  eq(htmlToText("<ul><li>a</li><li>b</li></ul>"), "- a\n- b", "listes en texte");
  eq(htmlToText("a &amp; b &lt;c&gt;"), "a & b <c>", "entités décodées");
  eq(htmlToText("écrire &amp;lt;b&amp;gt; pour du gras"), "écrire &lt;b&gt; pour du gras", "une entité écrite en toutes lettres n'est décodée qu'une fois");
}

console.log("\n── pièces jointes ──────────────────────────");
{
  const pdf = b64encode(new TextEncoder().encode("%PDF-1.4 faux contenu"));
  const raw = buildRfc822({
    from: "d@x.fr",
    to: "a@y.fr",
    subject: "avec pièce jointe",
    html: "<p>voir ci-joint</p>",
    attachments: [{ filename: "état des lieux.pdf", type: "application/pdf", data: pdf }],
  });

  ok(raw.includes("Content-Type: multipart/mixed"), "enveloppe multipart/mixed");
  ok(raw.includes("multipart/alternative"), "le corps texte+html reste imbriqué dedans");
  ok(/Content-Disposition: attachment/.test(raw), "part marquée comme pièce jointe");
  ok(raw.includes("=?utf-8?B?"), "nom de fichier non-ASCII encodé");
  ok(raw.trimEnd().endsWith("--"), "boundary de fermeture");

  // Ce qu'on écrit doit se relire : structure, corps et fichier.
  const back = parseMessage(raw);
  eq(back.html, "<p>voir ci-joint</p>", "aller-retour : html intact malgré l'imbrication");
  eq(back.text, "voir ci-joint", "aller-retour : texte dérivé présent");
  eq(back.attachments.length, 1, "une pièce jointe retrouvée");
  eq(back.attachments[0].filename, "état des lieux.pdf", "nom de fichier décodé");
  eq(back.attachments[0].type, "application/pdf", "type conservé");
  eq(back.attachments[0].part, "2", "chemin de part IMAP (corps=1, fichier=2)");
  eq(decodePart(back.attachments[0].body, "base64", "utf-8"), "%PDF-1.4 faux contenu", "contenu exact");

  // Sans pièce jointe, pas d'enveloppe mixed inutile.
  ok(!buildRfc822({ from: "d@x.fr", to: "a@y.fr", text: "x" }).includes("multipart/mixed"),
     "pas de multipart/mixed quand il n'y a rien à joindre");
}

console.log("\n── HTML désamorcé ──────────────────────────");
{
  const { html, blocked } = sanitizeHtml(
    `<p onclick="x()">ok</p><script>evil()</script><img src="https://t.example/pixel.gif">` +
      `<a href="javascript:alert(1)">clic</a><iframe src="https://x"></iframe><img src="cid:inline1">`
  );
  ok(!/<script/i.test(html), "script supprimé");
  ok(!/onclick/i.test(html), "gestionnaire d'événement supprimé");
  ok(!/<iframe/i.test(html), "iframe supprimée");
  ok(!/javascript:/i.test(html), "href javascript: neutralisé");
  ok(/data-blocked-src="https:\/\/t\.example\/pixel\.gif"/.test(html), "image distante bloquée mais réversible");
  ok(/src="cid:inline1"/.test(html), "les images cid: ne comptent pas comme distantes");
  eq(blocked, 1, "une seule ressource distante comptée");
  ok(html.includes(">ok</p>"), "le contenu sain survit");
}
{
  const t = textToHtml("ligne 1\nvoir https://exemple.fr/x?a=1 <fin>");
  ok(t.includes("&lt;fin&gt;"), "texte échappé");
  ok(t.includes('<a href="https://exemple.fr/x?a=1"'), "lien cliquable");

  // Le lien s'arrête où le texte reprend : ni le chevron, ni le guillemet, ni
  // la ponctuation de la phrase n'en font partie.
  const bornes = textToHtml('voir <https://exemple.fr/a>, "https://exemple.fr/b" et (https://exemple.fr/c?x=1&y=2).');
  ok(bornes.includes('<a href="https://exemple.fr/a" '), `chevrons hors du lien — ${bornes}`);
  ok(bornes.includes('<a href="https://exemple.fr/b" '), `guillemets hors du lien — ${bornes}`);
  ok(bornes.includes('<a href="https://exemple.fr/c?x=1&amp;y=2" '), `parenthèse et point hors du lien, & gardé — ${bornes}`);
  ok(bornes.endsWith("</a>).</div>"), `ce qui suit le lien reste du texte — ${bornes}`);
  ok(
    textToHtml("https://fr.wikipedia.org/wiki/Paris_(homonymie)").includes('href="https://fr.wikipedia.org/wiki/Paris_(homonymie)"'),
    "une parenthèse ouverte dans l'URL s'y referme"
  );
}

console.log("\n── pixels espions, formes non guillemetées ──");
{
  // Le bloc au-dessus ne testait que la valeur entre guillemets doubles.
  // `src=https://…` sans guillemets est du HTML valide : le pixel partait à
  // l'ouverture et `blocked` restait à 0, donc le bouton Images n'apparaissait
  // même pas pour le signaler. Une régression ici se paie en traçage.
  const fuite = /(?<!data-blocked-)(src|srcset|background|poster)\s*=/i;
  for (const [html, label] of [
    ["<img src=https://t.example/p.gif>", "src nu"],
    ["<img src='https://t.example/p.gif'>", "apostrophes"],
    ["<img src=//t.example/p.gif>", "protocole-relatif nu"],
    ['<img src=" https://t.example/p.gif">', "espace avant l'URL"],
    ["<img/src=https://t.example/p.gif>", "slash comme séparateur"],
    ["<table background=https://t.example/p.png>", "background nu"],
    ['<img srcset="a.png 1x, https://t.example/p.png 2x">', "srcset, 2e candidat distant"],
  ]) {
    const out = sanitizeHtml(html);
    ok(out.blocked === 1 && !fuite.test(out.html), `${label} — obtenu ${JSON.stringify(out)}`);
  }

  // Et l'inverse : ce qui ne sort pas sur le réseau doit rester intact.
  for (const [html, label] of [
    ['<img src="cid:inline1">', "cid: non compté"],
    ['<img src="/logo.png">', "chemin relatif non compté"],
    ['<img src="data:image/gif;base64,R0lGOD//">', "data: non compté"],
  ]) {
    ok(sanitizeHtml(html).blocked === 0, label);
  }

  ok(
    !/url\s*\(/i.test(sanitizeHtml("<div style=background:url(https://t.example/p.png)>x</div>").html),
    "style nu contenant url() retiré"
  );
}

console.log("\n-- expediteurs bloques ---------------------");
{
  // Une regle de domaine doit couvrir les sous-domaines : c'est de la que part
  // le courrier d'une entreprise, et changer de sous-domaine suffirait sinon a
  // passer au travers.
  ok(blockMatches("sellersupport@shop.tiktok.com", "tiktok.com"), "le domaine prend ses sous-domaines");
  ok(blockMatches("a@tiktok.com", "tiktok.com"), "le domaine prend le domaine nu");
  ok(blockMatches("a@TikTok.COM", "tiktok.com"), "insensible a la casse");
  ok(blockMatches("a@tiktok.com", "@tiktok.com"), "une regle ecrite avec @ vaut le domaine");

  // Le point est ce qui empeche la regle de deborder. Ces trois-la detruiraient
  // du courrier legitime, et il n'y a pas de retour en arriere.
  ok(!blockMatches("a@nottiktok.com", "tiktok.com"), "un suffixe colle ne correspond pas");
  ok(!blockMatches("a@tiktok.com.evil.net", "tiktok.com"), "un domaine parent usurpe ne correspond pas");
  ok(!blockMatches("tiktok.com@gmail.com", "tiktok.com"), "le nom local ne compte pas");

  // Une regle d'adresse ne vaut que pour elle-meme.
  ok(blockMatches("a@x.fr", "a@x.fr"), "l'adresse exacte correspond");
  ok(!blockMatches("b@x.fr", "a@x.fr"), "une autre adresse du meme domaine ne correspond pas");
  ok(!blockMatches("", "x.fr") && !blockMatches("a@x.fr", ""), "rien ne correspond a rien");

  ok(isBlockPattern("tiktok.com") && isBlockPattern("a@x.fr"), "domaine et adresse sont des motifs");
  ok(!isBlockPattern("com"), "un TLD nu n'est pas un motif");
  ok(!isBlockPattern("tiktok com") && !isBlockPattern(""), "ni un espace ni le vide");
}

console.log("\n-- feuilles de style conservees ------------");
{
  // Le motif qui rendait des messages entierement blancs : contenu masque en
  // ligne, revele par une regle dans <style>. En supprimant le <style>, le
  // texte restait dans la source, invisible pour toujours.
  const piege = `<html><head><style>.main{display:block !important}</style></head>
<body><div class="main" style="display:none"><p>le vrai message</p></div></body></html>`;
  const out = sanitizeHtml(piege).html;
  ok(/<style>/i.test(out), "le bloc <style> survit");
  ok(out.includes(".main{display:block !important}"), "la regle qui revele le contenu survit");
  ok(out.includes("le vrai message"), "le texte est toujours la");

  // Ce que le CSS ne doit plus pouvoir faire : aller chercher quelque chose.
  const traceur = sanitizeHtml(
    `<style>@import url("https://t.example/x.css");
     body{background:url(https://t.example/p.gif)}
     .a{background:url("//t.example/q.gif")}
     .b{background:url(data:image/gif;base64,AA)}</style>`
  );
  ok(!/@import/i.test(traceur.html), "@import retire");
  ok(!/t\.example/.test(traceur.html), "aucun chargement distant ne subsiste");
  ok(traceur.html.includes("url(data:image/gif;base64,AA)"), "les url() data: restent");
  eq(traceur.blocked, 3, "les trois chargements distants sont comptes");

  // <script> continue de disparaitre entierement, contenu compris.
  const js = sanitizeHtml(`<style>.x{color:red}</style><script>evil()</script><p>ok</p>`).html;
  ok(!/evil\(\)/.test(js), "le contenu de <script> ne survit pas");
  ok(js.includes(".x{color:red}"), "celui de <style> si");

  // Un <style> jamais referme : tout ce qui suit est du CSS pour un
  // navigateur, donc le supprimer est ce qui s'affiche vraiment.
  const casse = sanitizeHtml(`<p>avant</p><style>.y{color:red} <p>apres</p>`).html;
  ok(casse.includes("avant"), "ce qui precede un <style> non ferme reste");
  ok(!casse.includes("apres"), "ce qui suit est traite comme du CSS, donc retire");
  ok(!/\.y\{color:red\}/.test(casse), "et les regles orphelines ne fuient pas en texte");
}

console.log("\n── analyse MIME (rfc822) ───────────────────");
{
  // En-têtes repliés : un Content-Type long arrive coupé sur deux lignes, et
  // sans recollage le boundary est perdu — le message se réduit à une part.
  const h = parseHeaders("Subject: a\r\nX-Long: one\r\n\ttwo\r\nFrom: b\r\nSubject: ignoré");
  eq(h["x-long"], "one two", "ligne de continuation recollée");
  eq(h["subject"], "a", "premier en-tête gagne");
  eq(h["from"], "b", "nom en minuscules");

  // Un boundary entre guillemets a le droit de contenir un point-virgule.
  const ct = parseParams('multipart/mixed; boundary="a;b"; charset=utf-8');
  eq(ct.value, "multipart/mixed", "type extrait");
  eq(ct.params.boundary, "a;b", "point-virgule protégé par les guillemets");
  eq(ct.params.charset, "utf-8", "paramètre suivant intact");

  eq(splitParts("préambule\r\n--B\r\nun\r\n--B\r\ndeux\r\n--B--\r\népilogue", "B"),
     ["un", "deux"], "préambule et épilogue écartés");

  eq(decodePart("Bonjour =C3=A0 tous", "quoted-printable", "utf-8"), "Bonjour à tous", "QP + utf-8");
  eq(decodePart(b64encode(new TextEncoder().encode("Été")), "base64", "utf-8"), "Été", "base64 + utf-8");
  eq(decodePart("d\xE9j\xE0", "7bit", "iso-8859-1"), "déjà", "latin-1 non encodé");
}
{
  // Un vrai message : mixed > alternative, encodages différents par part,
  // en-tête replié, et une pièce jointe.
  const htmlB64 = b64encode(new TextEncoder().encode("<p>Bonjour</p>"));
  const raw =
    'From: =?utf-8?B?SsOpcsO0bWU=?= <j@x.fr>\r\n' +
    "Subject: Rapport\r\n" +
    'Content-Type: multipart/mixed;\r\n boundary="OUTER"\r\n' +
    "MIME-Version: 1.0\r\n" +
    "\r\n" +
    "ceci est un préambule\r\n" +
    "--OUTER\r\n" +
    'Content-Type: multipart/alternative; boundary="INNER"\r\n' +
    "\r\n" +
    "--INNER\r\n" +
    'Content-Type: text/plain; charset="utf-8"\r\n' +
    "Content-Transfer-Encoding: quoted-printable\r\n" +
    "\r\n" +
    "Bonjour =C3=A0 tous\r\n" +
    "--INNER\r\n" +
    'Content-Type: text/html; charset="utf-8"\r\n' +
    "Content-Transfer-Encoding: base64\r\n" +
    "\r\n" +
    htmlB64 + "\r\n" +
    "--INNER--\r\n" +
    "--OUTER\r\n" +
    'Content-Type: application/pdf; name="rapport.pdf"\r\n' +
    'Content-Disposition: attachment; filename="=?utf-8?B?w6l0w6kucGRm?="\r\n' +
    "Content-Transfer-Encoding: base64\r\n" +
    "\r\n" +
    "JVBERi0xLjQK\r\n" +
    "--OUTER--\r\n";

  const m = parseMessage(raw);
  eq(m.text, "Bonjour à tous", "part texte décodée (QP)");
  eq(m.html, "<p>Bonjour</p>", "part HTML décodée (base64)");
  eq(m.attachments.length, 1, "une pièce jointe");
  eq(m.attachments[0].filename, "été.pdf", "nom de fichier RFC 2047 décodé");
  eq(m.attachments[0].type, "application/pdf", "type de la pièce jointe");
  ok(!m.text.includes("préambule"), "le préambule ne fuit pas dans le corps");
  eq(parseAddress(m.headers["from"]).name, "Jérôme", "en-tête From exploitable");

  // Message trivial sans MIME du tout.
  const plain = parseMessage("Subject: x\r\n\r\nligne unique");
  eq(plain.text, "ligne unique", "message non-MIME lu comme texte");
  eq(plain.attachments.length, 0, "aucune pièce jointe inventée");
}

console.log("\n── scellement des jetons ───────────────────");
{
  const KEY = b64encode(crypto.getRandomValues(new Uint8Array(32)));
  const secret = { refresh_token: "1//abcd", access_token: "ya29.x", exp: 1234 };
  const blob = await seal(KEY, secret);
  eq(await open(KEY, blob), secret, "aller-retour fidèle");
  ok((await open(KEY, blob.slice(0, -4) + "AAAA")) === null, "blob altéré → null");
  const OTHER = b64encode(crypto.getRandomValues(new Uint8Array(32)));
  ok((await open(OTHER, blob)) === null, "mauvaise clé → null");
  ok(blob !== (await seal(KEY, secret)), "IV frais à chaque scellement");

  // Une clé 32 octets en base64 est utilisée telle quelle, comme avant : un
  // blob scellé avec la clé brute s'ouvre toujours.
  const raw = await crypto.subtle.importKey("raw", b64decode(KEY), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, raw, new TextEncoder().encode('{"a":1}')));
  eq(await open(KEY, b64encode(new Uint8Array([...iv, ...ct]))), { a: 1 }, "clé base64 de 32 octets : inchangée");

  // Une phrase quelconque (formulaire Deploy to Cloudflare) marche aussi.
  const PHRASE = "une longue phrase tapée à la main, pas du base64 !";
  const sealed = await seal(PHRASE, secret);
  eq(await open(PHRASE, sealed), secret, "phrase de passe : aller-retour fidèle");
  ok((await open(PHRASE + "x", sealed)) === null, "autre phrase → null");
}

console.log("\n── extension : adresse de l'app ────────────");
{
  const { originOf, patternOf } = await import("./extension/app.js");
  eq(originOf("stratus.you.workers.dev"), "https://stratus.you.workers.dev", "sans schéma : https");
  eq(originOf(" https://Mail.Example.com/inbox?x=1 "), "https://mail.example.com", "chemin et casse retirés");
  eq(originOf("http://localhost:8787/"), "http://localhost:8787", "http accepté en local");
  eq(originOf("http://mail.example.com"), null, "http refusé hors local");
  eq(originOf("javascript:alert(1)"), null, "pas d'autre schéma");
  eq(originOf("stratus"), null, "un mot seul n'est pas une adresse");
  eq(originOf(""), null, "vide → null");
  eq(patternOf("https://mail.example.com"), "https://mail.example.com/*", "motif de permission");
  const manifest = JSON.parse(readFileSync(new URL("./extension/manifest.json", import.meta.url), "utf8"));
  ok(!manifest.host_permissions && !manifest.content_scripts, "le manifeste ne nomme aucune adresse");
  ok(!/agentxr/.test(readFileSync(new URL("./extension/background.js", import.meta.url), "utf8") + readFileSync(new URL("./extension/options.js", import.meta.url), "utf8")), "aucune adresse en dur dans l'extension");
}

console.log("\n── hôte de l'app sans APP_URL ──────────────");
{
  const util = await import("./src/util.js");
  util.learnHost({}, new Request("https://Stratus.Someone.workers.dev/api/folders"));
  eq(util.ownHost, "stratus.someone.workers.dev", "l'hôte de la requête, sans APP_URL");
  util.learnHost({ APP_URL: "https://mail.example.com" }, new Request("https://other.example/"));
  eq(util.ownHost, "mail.example.com", "APP_URL l'emporte sur la requête");
  const writes = [];
  const DB = { prepare: (sql) => ({ bind: (v) => ({ run: async () => writes.push([sql, v]) }) }) };
  const waits = [];
  util.learnHost({}, new Request("https://a.example/"));
  util.keepHost({ DB }, { waitUntil: (p) => waits.push(p) });
  util.keepHost({ DB }, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  eq(writes.length, 1, "l'hôte est écrit une seule fois par isolat");
  eq(writes[0][1], "a.example", "c'est l'hôte de la requête qui est gardé");
  util.keepHost({ DB, APP_URL: "https://a.example" }, { waitUntil: (p) => waits.push(p) });
  eq(waits.length, 1, "avec APP_URL, rien n'est écrit");
}

console.log("");
console.log("-- BODYSTRUCTURE --------------------------");
{
  // Ce qu'Apple renvoie pour texte+html plus une piece jointe de 26 Mo. Lire
  // cette structure evite de telecharger 26 Mo pour afficher 2 Ko de HTML.
  const bs =
    '((("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "QUOTED-PRINTABLE" 401 9)' +
    '("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "QUOTED-PRINTABLE" 2118 41) "ALTERNATIVE")' +
    '("APPLICATION" "PDF" ("NAME" "rapport.pdf") NIL NIL "BASE64" 27891234 NIL ' +
    '("attachment" ("FILENAME" "rapport.pdf")) NIL) "MIXED")';

  const parts = flattenStructure(parseSexp(bs));
  eq(parts.length, 3, "trois parts feuilles");
  eq(parts[0].part, "1.1", "chemin de la part texte");
  eq(parts[1].part, "1.2", "chemin de la part html");
  eq(parts[1].type, "text/html", "type html");
  eq(parts[1].encoding, "quoted-printable", "encodage lu");
  eq(parts[1].size, 2118, "taille de la part html : 2 Ko, pas 26 Mo");
  eq(parts[2].part, "2", "chemin de la piece jointe");
  eq(parts[2].filename, "rapport.pdf", "nom de fichier");
  eq(parts[2].disposition, "attachment", "disposition");

  const flat = flattenStructure(parseSexp('("TEXT" "PLAIN" ("CHARSET" "us-ascii") NIL NIL "7BIT" 12 1)'));
  eq(flat.length, 1, "message non-multipart : une seule part");
  eq(flat[0].part, "1", "chemin 1 par defaut");
  eq(parseSexp('("a" NIL 3)'), ["a", null, "3"], "NIL devient null");
}

console.log("\n-- identite du message sortant -------------");
{
  // Sans Message-ID, un message envoye est introuvable par la suite : c'est par
  // lui qu'on retrouve le message en IMAP pour l'etoiler, le deplacer ou le
  // lire. Pire, l'id local en derive, donc deux envois sans Message-ID se
  // hachent pareil et s'ecrasent l'un l'autre dans Envoyes.
  const raw = buildRfc822({ from: "d@x.fr", to: "a@y.fr", subject: "s", text: "corps" });
  ok(/^Message-ID: <[^<>@]+@x\.fr>$/m.test(raw), "Message-ID present, sur le domaine de l'expediteur");
  ok(/^Date: \w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000$/m.test(raw), "Date au format RFC 5322");

  const a = buildRfc822({ from: "d@x.fr", to: "a@y.fr", text: "x" });
  const b = buildRfc822({ from: "d@x.fr", to: "a@y.fr", text: "x" });
  const idOf = (s) => /^Message-ID: (.+)$/m.exec(s)[1];
  ok(idOf(a) !== idOf(b), "deux messages identiques ont des Message-ID distincts");

  // Impose de l'exterieur : c'est ainsi que l'appelant sait sous quel id
  // classer sa propre copie dans Envoyes.
  const fixe = buildRfc822({ from: "d@x.fr", to: "a@y.fr", text: "x", messageId: "<abc@x.fr>" });
  ok(fixe.includes("Message-ID: <abc@x.fr>"), "Message-ID fourni respecte");

  // Aller-retour : le message qu'on APPEND dans Envoyes est relu par
  // parseMessage pour construire la ligne affichee.
  const back = parseMessage(fixe);
  eq(back.headers["message-id"], "<abc@x.fr>", "Message-ID relu a l'identique");
  ok(!!Date.parse(back.headers.date), "Date relue et analysable");
}

console.log("\n-- message imbrique (transfert, rapport) ---");
{
  // Un transfert : le message d'origine voyage en message/rfc822. Sans
  // recursion dedans, walk() ne trouvait ni html ni texte et le lecteur
  // affichait une page blanche — le contenu etait pourtant la.
  const inner =
    "From: exp@y.fr\r\nSubject: original\r\nContent-Type: text/plain; charset=utf-8\r\n\r\ncontenu d'origine";
  const raw =
    "From: a@x.fr\r\nSubject: Fwd: original\r\n" +
    'Content-Type: multipart/mixed; boundary="B"\r\n\r\n' +
    "--B\r\nContent-Type: message/rfc822\r\n\r\n" +
    inner +
    "\r\n--B--\r\n";

  const m = parseMessage(raw);
  ok(m.text.includes("contenu d'origine"), "le corps du message transfere est lu");
  eq(m.attachments.length, 0, "il n'est pas classe comme piece jointe opaque");

  // Mais un message joint volontairement — avec un nom de fichier — reste une
  // piece jointe : c'est ce que l'expediteur a voulu dire.
  const joint =
    "From: a@x.fr\r\n" +
    'Content-Type: multipart/mixed; boundary="B"\r\n\r\n' +
    "--B\r\nContent-Type: message/rfc822; name=\"vieux.eml\"\r\n" +
    'Content-Disposition: attachment; filename="vieux.eml"\r\n\r\n' +
    inner +
    "\r\n--B--\r\n";
  eq(parseMessage(joint).attachments.length, 1, "message joint nomme : reste une piece jointe");
}

/* ── le client, éprouvé comme le reste ──────────────────────────
 *
 * public/index.html porte quatre mille lignes de script qu'aucun test n'avait
 * jamais exécutées : check-client.mjs vérifie qu'elles s'analysent, pas ce
 * qu'elles font. Les trois bugs de la semaine — les destinataires d'un reply
 * all, les apostrophes qu'Outlook met autour d'une adresse, le texte tapé qui
 * finissait dans la citation — étaient tous là.
 *
 * Les fonctions qui ne touchent pas au DOM sont découpées du script livré et
 * évaluées ici, leurs dépendances passées en paramètres. Rien à installer, et
 * c'est bien le code déployé qui est mis à l'épreuve, pas une copie qui
 * dériverait de son côté.
 */
// Fins de ligne ramenées à LF : un checkout Windows a des CRLF, et les
// découpes ci-dessous cherchent "\n}\n".
const clientScript = readFileSync(new URL("./public/index.html", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n")
  .split("<script>")[1]
  .split("</script>")[0];

/** Le Worker entier, tous modules confondus : les routes et les phrases
 * qu'on y cherche ne vivent plus toutes dans index.js. */
function workerSource() {
  const dir = new URL("./src/", import.meta.url);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(new URL(f, dir), "utf8"))
    .join("\n");
}

/** Une déclaration, découpée du script client par son nom. */
function decl(name) {
  const at = clientScript.search(new RegExp(`^(?:async )?(?:function ${name}\\b|const ${name} = )`, "m"));
  if (at < 0) throw new Error(`introuvable dans le client : ${name}`);
  const rest = clientScript.slice(at);
  // Une fonction se ferme sur une accolade en première colonne ; une constante
  // fléchée se termine au point-virgule suivi de la ligne vide qui la sépare
  // de la suivante. Le fichier est écrit comme ça de bout en bout.
  const end = rest.startsWith("const") ? rest.indexOf(";\n\n") + 1 : rest.indexOf("\n}\n") + 2;
  if (end <= 1) throw new Error(`fin de déclaration introuvable : ${name}`);
  return rest.slice(0, end);
}

/** Ces fonctions-là, avec ce qu'elles attendent autour d'elles. */
function clientFns(names, globals = {}) {
  const keys = Object.keys(globals);
  const src = names.map(decl).join("\n");
  return new Function(...keys, `${src}\nreturn { ${names.join(", ")} };`)(...keys.map((k) => globals[k]));
}

console.log("\n-- client : adresses d'une reponse ---------");
{
  const me = "moi@x.fr";
  const { addressesIn, replyTargets, replyFrom } = clientFns(["addressesIn", "identitiesOf", "replyFrom", "replyTargets"], {
    acctById: () => ({ email: me, aliases: ["alias@x.fr"] }),
  });
  const msg = (from, to, cc) => ({ account_id: "a", from_email: from, to_line: to, cc_line: cc });

  eq(addressesIn(`'${me}', b@y.fr`), [me, "b@y.fr"], "apostrophes d'Outlook retirées");
  eq(addressesIn("o'brien@y.fr"), ["o'brien@y.fr"], "apostrophe interne conservée");

  eq(
    replyTargets(msg("jean@y.fr", `'${me}'`, `'${me}', claire@z.fr`), true),
    { to: ["jean@y.fr"], cc: ["claire@z.fr"] },
    "reçu : l'expéditeur en To, soi-même retiré du Cc"
  );
  eq(
    replyTargets(msg(me, "jean@y.fr", "claire@z.fr"), true),
    { to: ["jean@y.fr"], cc: ["claire@z.fr"] },
    "envoyé : on réécrit aux mêmes, pas à soi"
  );
  eq(
    replyTargets(msg(me, "jean@y.fr", "claire@z.fr"), false),
    { to: ["jean@y.fr"], cc: [] },
    "envoyé, réponse simple : le Cc reste dehors"
  );
  eq(
    replyTargets(msg("jean@y.fr", "", `claire@z.fr, ${me}`), true),
    { to: ["jean@y.fr"], cc: ["claire@z.fr"] },
    "en copie seulement : l'expéditeur reste adressé"
  );
  eq(
    replyTargets(msg(me, "", "claire@z.fr"), true),
    { to: ["claire@z.fr"], cc: [] },
    "rien en To : le premier du Cc est promu"
  );

  // Répondre depuis l'adresse qui a reçu le message.
  eq(replyFrom(msg("jean@y.fr", "alias@x.fr", "")), "alias@x.fr", "reçu sur un alias : on répond depuis l'alias");
  eq(replyFrom(msg("jean@y.fr", me, "")), "", "reçu sur l'adresse principale : rien à changer");
  eq(replyFrom(msg("shop@y.fr", "rand-om.12@icloud.com", "")), "rand-om.12@icloud.com", "Hide My Email : on répond depuis lui");
  eq(replyFrom(msg("shop@y.fr", "a@icloud.com, b@icloud.com", "")), "", "deux adresses Apple : on ne devine pas");
  eq(
    replyTargets(msg("jean@y.fr", "alias@x.fr", "claire@z.fr"), true),
    { to: ["jean@y.fr"], cc: ["claire@z.fr"] },
    "répondre à tous n'écrit à aucune de ses propres adresses"
  );
  eq(
    replyTargets(msg("shop@y.fr", "rand-om.12@icloud.com", "claire@z.fr"), true),
    { to: ["shop@y.fr"], cc: ["claire@z.fr"] },
    "ni à l'adresse Hide My Email qui a reçu le message"
  );
}

console.log("\n-- en-tête From : nom affiché --------------");
{
  const { formatFrom } = await import("./src/mime.js");
  eq(formatFrom("", "d@x.fr"), "d@x.fr", "sans nom : l'adresse seule");
  eq(formatFrom("d@x.fr", "d@x.fr"), "d@x.fr", "le nom qui répète l'adresse est omis");
  eq(formatFrom("Damien", "d@x.fr"), "Damien <d@x.fr>", "nom simple");
  eq(formatFrom("Mazeas, Damien", "d@x.fr"), '"Mazeas, Damien" <d@x.fr>', "une virgule impose les guillemets");
  ok(/^=\?utf-8\?B\?.+\?= <d@x\.fr>$/.test(formatFrom("Éloïse", "d@x.fr")), "non-ASCII encodé");
  eq(formatFrom('A"\r\nBcc: z@z.fr', "d@x.fr"), "ABcc: z@z.fr <d@x.fr>".replace("ABcc: z@z.fr", '"ABcc: z@z.fr"'), "ni guillemet ni saut de ligne ne passent");
}

/* Les deux bouts d'une même phrase, dans deux fonctions qui ne se voient pas :
 * icloudAct annonce qu'il n'a trouvé le message dans aucune boîte, et purge
 * doit reconnaître cette annonce-là pour effacer quand même la ligne ici. Si
 * l'un des deux est reformulé un jour, un brouillon redevient indélébile, et
 * personne ne s'en apercevra avant d'essayer de le supprimer. */
console.log("\n-- purge : ce qui est deja perdu ----------");
{
  const worker = workerSource();
  const thrown = (/throw new Error\("([^"]*not found[^"]*)"\)/.exec(worker) || [])[1] || "";
  const tolerated = (/if \(!\/([^/]+)\/i\.test\(String\(e\.message/.exec(worker) || [])[1] || "";
  ok(!!thrown, "icloudAct dit toujours qu'il n'a rien trouvé");
  ok(!!tolerated, "purge tolère toujours une de ces phrases");
  ok(
    !!thrown && !!tolerated && new RegExp(tolerated, "i").test(thrown),
    `purge reconnaît la phrase d'icloudAct — "${tolerated}" contre "${thrown}"`
  );
}

console.log("\n-- client : bascules Cc / Bcc ---------------");
{
  // La paire a cinq cases : bouton, champ, input, chips, libellé. Une
  // destructuration a trois trous sautait deux cases au lieu d'une, et le
  // bouton s'intitulait « + #cCcChips » — le texte de Cc et Bcc devenait
  // illisible à l'ouverture du composeur.
  const m = /const CC_TOGGLES = (\[[\s\S]*?\n\]);/.exec(clientScript);
  ok(!!m, "CC_TOGGLES présent");
  const list = m ? new Function(`return ${m[1]}`)() : [];
  eq(list.map((t) => t[4]), ["Cc", "Bcc"], "le libellé est la 5e case");
  eq(list.map((t) => t.length), [5, 5], "cinq cases, pas quatre");
  ok(
    /for \(const \[btn, wrap, , , name\] of CC_TOGGLES\) markToggle/.test(clientScript),
    "init lit le libellé au 5e rang"
  );
  ok(
    /for \(const \[btn, wrap, input, chips, name\] of CC_TOGGLES\)/.test(clientScript),
    "le gestionnaire de clic lit les cinq cases"
  );
}

console.log("\n-- client : signature de l'assistant -------");
{
  const sig = (email, label = "") =>
    clientFns(["signature"], { acctById: () => ({ email, label }), composeAcct: "a" }).signature();
  eq(sig("jean.dupont@x.fr"), "Jean", "prénom tiré de l'adresse");
  eq(sig("jean-luc.picard@x.fr"), "Jean-Luc", "prénom composé gardé entier");
  eq(sig("contact@x.fr"), "", "une boîte nommée contact ne signe rien");
  eq(sig("x@y.fr", "Jean Dupont"), "Jean Dupont", "le libellé du compte l'emporte");
}

console.log("\n── corps stockés : une seule forme ----------");
{
  // Trois endroits assemblaient ce document à la main et n'étaient pas d'accord
  // sur quels champs étaient optionnels. `tooLarge` est passé entre les deux.
  const base = bodyFromParts({ html: "<p>ok</p>", blocked: 1 });
  eq(base.v, BODY_VERSION, "le corps porte sa version de défense");
  eq(base.html, "<p>ok</p>", "html passé tel quel");
  eq(base.blocked, 1, "blocages comptés");
  eq(base.attachments, [], "pièces jointes : liste vide, jamais absente");
  eq(base.unsubscribe, "", "désabonnement : chaîne vide, jamais absent");
  eq(base.unsubscribeOneClick, false, "one-click faux par défaut");
  ok(!("tooLarge" in base) && !("empty" in base) && !("missing" in base),
     "aucun drapeau quand tout va bien");

  // Trop gros : le drapeau est la vérité, le texte de remplacement est un
  // pis-aller pour le client d'avant, et le texte du message sert de note
  // quand il y en a un — mieux qu'une phrase inventée.
  const grand = bodyFromParts({ text: "résumé lisible", tooLarge: true });
  eq(grand.tooLarge, true, "tooLarge posé");
  ok(grand.html.includes("résumé lisible"), "le texte du message sert de note");
  ok(!/[<>]/.test(grand.html.replace(/<\/?p>/g, "")), "la note est échappée");

  const sansTexte = bodyFromParts({ tooLarge: true });
  ok(sansTexte.html.length > 0, "sans texte, un message de repli tout de même");
  ok(sansTexte.html.startsWith("<p>"), "le repli est un paragraphe, pas du HTML cru");
  eq(sansTexte.tooLarge, true, "le drapeau survit au repli");

  // Ces deux-là ne sont pas des corps factices : le client parle à sa voix.
  const vide = bodyFromParts({ html: "", empty: true });
  eq(vide.empty, true, "empty posé");
  eq(vide.html, "", "empty n'injecte pas de faux message");
  const perdu = bodyFromParts({ missing: true });
  eq(perdu.missing, true, "missing posé");
  eq(perdu.html, "", "missing n'injecte pas de faux message");

  // En-têtes de liste : RFC 2369 et 8058, presque jamais exposés ailleurs.
  const unsub = unsubFromHeaders({
    "list-unsubscribe": "<https://x.fr/unsub>, <mailto:u@x.fr>",
    "list-unsubscribe-post": "List-Unsubscribe=One-Click",
  });
  eq(unsub.unsubscribe, "<https://x.fr/unsub>, <mailto:u@x.fr>", "List-Unsubscribe conservé");
  eq(unsub.unsubscribeOneClick, true, "one-click reconnu");
  eq(unsubFromHeaders({ "list-unsubscribe": "x".repeat(700) }).unsubscribe.length, 600,
     "l'en-tête est borné");
  eq(unsubFromHeaders({}).unsubscribe, "", "en-têtes absents : champs vides");

  // Reply-To : l'adresse où l'expéditeur veut qu'on réponde. Rien ne la
  // gardait, et une réponse partait vers From:, la liste ou le no-reply.
  eq(base.replyTo, "", "Reply-To : chaîne vide, jamais absent");
  const repondre = bodyFromParts({ html: "<p>ok</p>", replyTo: decodeWords("=?UTF-8?Q?Zo=C3=A9?= <zoe@x.fr>") });
  eq(repondre.replyTo, "Zoé <zoe@x.fr>", "Reply-To conservé, décodé par l'appelant");
  eq(bodyFromParts({ replyTo: "x".repeat(700) }).replyTo.length, 500, "Reply-To borné à 500 caractères");
  eq(bodyFromParts({ ...repondre, empty: true }).replyTo, "Zoé <zoe@x.fr>", "il survit à un corps réassemblé");
}

console.log("\n── échec d'authentification : une seule voix -");
{
  // Le drapeau `e.reauth` bricolé sur n'importe quelle Error est ce que
  // MailAuthError remplace. Les deux formes doivent rester reconnues, sinon un
  // ancien chemin se met à répondre 502 là où l'utilisateur doit se reconnecter.
  ok(isAuthFailure(new MailAuthError()), "MailAuthError est un échec d'auth");
  ok(isAuthFailure(new MailAuthError("refusé")), "le message ne change rien");
  ok(isAuthFailure({ reauth: true }), "l'ancien drapeau est toujours lu");
  ok(!isAuthFailure(new Error("pas de réseau")), "une erreur réseau n'en est pas une");
  ok(!isAuthFailure(null) && !isAuthFailure(undefined), "null n'en est pas un");
  ok(new MailAuthError().name === "MailAuthError", "le nom porte le type");
}

console.log("\n── audit 2026-10-17 : failles fermées ──────");
{
  // Un attribut collé au guillemet fermant du précédent est un second
  // attribut pour un navigateur. Le filtre exigeait un espace avant « on… ».
  const colle = sanitizeHtml(`<img src="cid:x"onerror="alert(1)"><p title='a'onclick='b()'>t</p>`).html;
  ok(!/onerror|onclick/i.test(colle), `gestionnaire collé au guillemet supprimé — ${colle}`);
  ok(/src="cid:x"/.test(colle), "l'attribut précédent garde son guillemet fermant");
  const pixel = sanitizeHtml(`<img alt="a"src="https://t.example/p.gif">`);
  ok(pixel.blocked === 1 && !/(?<!data-blocked-)src="https/.test(pixel.html), `pixel collé bloqué — ${pixel.html}`);
  ok(!/javascript/i.test(sanitizeHtml(`<a href=" javascript:alert(1)">x</a>`).html), "javascript: précédé d'un espace neutralisé");
  ok(!/image-set/i.test(sanitizeHtml(`<div style="background:image-set('https://t.example/p.png' 1x)">x</div>`).html),
     "image-set() retiré comme url()");

  // Un nom affiché encodé ne doit pas pouvoir fournir l'adresse.
  const nom = Buffer.from("PayPal <service@paypal.com>").toString("base64");
  const usurpe = parseAddress(`=?utf-8?B?${nom}?= <attaquant@evil.example>`);
  eq(usurpe.email, "attaquant@evil.example", "l'adresse réelle l'emporte sur celle du nom encodé");
  eq(parseAddress("=?utf-8?Q?Ren=C3=A9?= <rene@x.fr>").name, "René", "le nom est toujours décodé");
  eq(parseAddress("rene@x.fr").email, "rene@x.fr", "adresse nue");

  // Une base64 abîmée ne doit plus jamais lever d'exception.
  const dec = (s) => new TextDecoder().decode(b64decode(s));
  eq(dec("aGVsbG8=aGVsbG8="), "hellohello", "rembourrage au milieu : deux morceaux");
  eq(dec("aGVsbG8gd29ybGQ"), "hello world", "rembourrage absent");
  eq(dec("aGVs\r\nbG8=\r\n"), "hello", "retours à la ligne ignorés");
  ok((() => { try { b64decode("aGVsbG8gd"); return true; } catch { return false; } })(), "base64 tronquée : pas d'exception");
}
{
  const { sameOriginWrite } = await import("./src/auth.js");
  const req = (method, headers = {}) => new Request("https://mail.agentxr.app/api/send", { method, headers });
  ok(sameOriginWrite(req("GET", { "Sec-Fetch-Site": "cross-site" })), "une lecture passe toujours");
  ok(sameOriginWrite(req("POST", { "Sec-Fetch-Site": "same-origin" })), "l'app elle-même passe");
  ok(!sameOriginWrite(req("POST", { "Sec-Fetch-Site": "same-site" })), "un autre *.agentxr.app est refusé");
  ok(!sameOriginWrite(req("POST", { "Sec-Fetch-Site": "cross-site" })), "un site tiers est refusé");
  ok(!sameOriginWrite(req("POST", { Origin: "https://save.agentxr.app" })), "Origin étrangère refusée");
  ok(sameOriginWrite(req("POST", { Origin: "https://mail.agentxr.app" })), "Origin identique acceptée");
  ok(sameOriginWrite(req("POST", { "X-Session": "t", "Sec-Fetch-Site": "cross-site" })), "l'extension (X-Session) passe");
  ok(sameOriginWrite(req("POST")), "sans en-tête de navigateur : pas une page piégée");
}

console.log("\n-- octets 8 bits (0x80-0x9F) ---------------");
{
  const { bytesToLatin1, latin1ToBytes } = await import("./src/rfc822.js");
  const utf8 = (s) => new TextEncoder().encode(s);
  const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  };

  const tous = Uint8Array.from({ length: 256 }, (_, i) => i);
  eq([...latin1ToBytes(bytesToLatin1(tous))], [...tous], "les 256 octets survivent à l'aller-retour");
  eq(bytesToLatin1(new Uint8Array([0x80])).charCodeAt(0), 0x80, "0x80 reste 0x80, pas U+20AC (windows-1252)");
  const gros = new Uint8Array(100_000).fill(0x9c);
  eq(bytesToLatin1(gros).length, 100_000, "un gros tampon passe sans faire sauter la pile");

  // €, tiret cadratin et guillemets courbes : E2 82 AC, E2 80 94, E2 80 9C —
  // exactement les octets que windows-1252 réécrivait.
  const texte = "Prix : 20 € — “ok” …";
  const simple = concat(
    utf8("Subject: x\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n"),
    utf8(texte)
  );
  eq(parseMessage(simple).text, texte, "corps UTF-8 en 8bit intact");

  const binaire = new Uint8Array([0x00, 0x80, 0x81, 0x8d, 0x90, 0x9d, 0x9f, 0xff]);
  const mixte = concat(
    utf8('Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'),
    utf8(texte),
    utf8('\r\n--b\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="x.bin"\r\nContent-Transfer-Encoding: binary\r\n\r\n'),
    binaire,
    utf8("\r\n--b--\r\n")
  );
  const lu = parseMessage(mixte);
  eq(lu.text, texte, "texte 8bit intact dans un multipart");
  eq([...latin1ToBytes(lu.attachments[0].body)], [...binaire], "pièce jointe 8bit/binaire intacte, octet pour octet");
}

console.log("\n-- en-têtes UTF-8 bruts (RFC 6532) ---------");
{
  const { bytesToLatin1 } = await import("./src/rfc822.js");
  const fil = (s) => bytesToLatin1(new TextEncoder().encode(s)); // comme reçu d'IMAP
  eq(decodeWords(fil("café")), "café", "UTF-8 brut décodé");
  eq(decodeWords("caf\xe9"), "café", "latin1 brut laissé tel quel");
  eq(decodeWords(fil("Re: été ") + "=?utf-8?Q?=C3=A0_Brest?="), "Re: été à Brest", "brut et encodé mélangés");
  eq(decodeWords("=?utf-8?Q?=C3=A0?= " + fil("ça")), "à ça", "l'espace avant un passage brut est gardé");
  eq(decodeWords("日本語"), "日本語", "texte déjà décodé non retouché");
  eq(decodeWords("plain ascii"), "plain ascii", "ASCII intact");
  const h = parseMessage(fil("Subject: Réunion à 14 h\r\nFrom: Zoé Durand <zoe@x.fr>\r\n\r\nx")).headers;
  eq(decodeWords(h.subject), "Réunion à 14 h", "sujet UTF-8 brut d'un vrai message");
  eq(parseAddress(h.from).name, "Zoé Durand", "nom d'expéditeur UTF-8 brut");
}

console.log("\n-- noms de fichiers RFC 2231 ---------------");
{
  eq(parseParams("attachment; filename*=utf-8''r%C3%A9sum%C3%A9.pdf").params.filename, "résumé.pdf", "filename* encodé");
  eq(
    parseParams("attachment; filename*0*=utf-8''r%C3%A9; filename*1*=sum%C3%A9; filename*2=\".pdf\"").params.filename,
    "résumé.pdf",
    "suites filename*0* / *1* / *2"
  );
  eq(parseParams("application/pdf; name*=iso-8859-1'fr'r%E9sum%E9.pdf").params.name, "résumé.pdf", "name* en iso-8859-1, avec langue");
  eq(
    parseParams("attachment; filename=\"repli.pdf\"; filename*=utf-8''vrai.pdf").params.filename,
    "vrai.pdf",
    "la forme étendue l'emporte sur le repli"
  );
  eq(parseParams("attachment; filename*0=\"long\"; filename*1=\"nom.txt\"").params.filename, "longnom.txt", "suites non encodées");
  eq(parseParams("attachment; filename=\"simple.pdf\"").params.filename, "simple.pdf", "nom ordinaire inchangé");

  const msg = parseMessage(
    'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nhi\r\n' +
      "--b\r\nContent-Type: application/pdf; name*=utf-8''CV%20r%C3%A9sum%C3%A9.pdf\r\n" +
      "Content-Disposition: attachment;\r\n filename*0*=utf-8''CV%20r%C3%A9;\r\n filename*1*=sum%C3%A9.pdf\r\n" +
      "Content-Transfer-Encoding: base64\r\n\r\nAAAA\r\n--b--\r\n"
  );
  eq(msg.attachments[0]?.filename, "CV résumé.pdf", "pièce jointe nommée de bout en bout");

  const parts = flattenStructure(
    parseSexp(
      '(("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 2 1)' +
        "(\"APPLICATION\" \"PDF\" (\"NAME*\" \"utf-8''r%C3%A9sum%C3%A9.pdf\") NIL NIL \"BASE64\" 100 NIL " +
        "(\"ATTACHMENT\" (\"FILENAME*\" \"utf-8''r%C3%A9sum%C3%A9.pdf\")) NIL) \"MIXED\")"
    )
  );
  eq(parts[1]?.filename, "résumé.pdf", "BODYSTRUCTURE : FILENAME* décodé");
}

console.log("\n-- fils et References -----------------------");
{
  const { threadKeyOf, replyReferences, trimReferences, messageIds } = await import("./src/mime.js");
  const { splitMessage } = await import("./src/rfc822.js");
  const racine = { "message-id": "<root@x>", subject: "Dîner" };
  const reponse = { "message-id": "<b@x>", "in-reply-to": "<root@x>", references: "<root@x>", subject: "Re: Dîner" };
  const suite = { "message-id": "<c@x>", "in-reply-to": "<b@x>", references: "<root@x>\r\n <b@x>", subject: "Re: Re: Dîner" };
  eq(threadKeyOf(racine), "<root@x>", "une racine est rangée sous son propre Message-ID");
  eq(threadKeyOf(reponse), threadKeyOf(racine), "la réponse rejoint la racine");
  eq(threadKeyOf(suite), threadKeyOf(racine), "la réponse à la réponse aussi");
  eq(threadKeyOf({ "message-id": "<d@x>", "in-reply-to": "<root@x>" }), "<root@x>", "In-Reply-To seul suffit");
  eq(threadKeyOf({ subject: "Re: Sans id" }), "sans id", "sans aucun id : le sujet");
  eq(threadKeyOf({ references: "(commentaire) <root@x> <b@x>" }), "<root@x>", "commentaire ignoré dans References");

  eq(replyReferences({ mid: "<c@x>", refs: "<root@x> <b@x>" }), ["<root@x>", "<b@x>", "<c@x>"], "chaîne du parent + parent");
  eq(replyReferences({ mid: "<b@x>", refs: "", thread_key: "<root@x>" }), ["<root@x>", "<b@x>"], "ligne ancienne : la racine via thread_key");
  eq(replyReferences({ mid: "<root@x>", refs: "", thread_key: "<root@x>" }), ["<root@x>"], "répondre à la racine : pas de doublon");
  eq(replyReferences({ mid: "<b@x>", refs: "", thread_key: "dîner" }), ["<b@x>"], "clé de sujet ignorée");
  eq(replyReferences(null), [], "pas de parent, pas de chaîne");

  const ids = Array.from({ length: 30 }, (_, i) => `<m${i}@x>`);
  const court = trimReferences(ids);
  eq(court.length, 20, "chaîne bornée à 20");
  eq(court[0], "<m0@x>", "la racine est gardée");
  eq(court[19], "<m29@x>", "le plus récent est gardé");

  const parent = { mid: "<c@x>", refs: "<root@x> <b@x>" };
  const sortant = buildRfc822({
    from: "damien@x.fr", to: "ami@y.fr", subject: "Re: Dîner", text: "ok",
    inReplyTo: parent.mid, references: replyReferences(parent),
  });
  ok(/^References: <root@x> <b@x> <c@x>\r?$/m.test(sortant), "References = chaîne du parent + parent");
  const ancien = buildRfc822({
    from: "damien@x.fr", to: "ami@y.fr", subject: "Re", text: "ok", inReplyTo: "<p@x>", references: "<p@x>",
  });
  ok(/^References: <p@x>\r?$/m.test(ancien), "plus jamais <p> <p>");
  const longue = buildRfc822({
    from: "damien@x.fr", to: "ami@y.fr", subject: "Re", text: "ok",
    inReplyTo: "<fin@x>", references: ids.map((id) => id.replace("@x", "@" + "a".repeat(60) + ".example")),
  });
  ok(longue.split("\r\n").every((l) => l.length <= 998), "aucune ligne d'en-tête au-delà de 998 octets");
  eq(messageIds(parseHeaders(splitMessage(longue).head).references).length, 20, "chaîne repliée relue entière");
}

console.log("\n-- réconciliation (fenêtres, deux essais) --");
{
  const { planWindow, strikes, flagState, uidSet, inRanges } = await import("./src/reconcile.js");
  eq(uidSet([10, 9, 1, 2, 3, 7, 3]), "1:3,7,9:10", "jeu de UID compressé");
  eq(uidSet([]), "", "jeu vide");

  const all = Array.from({ length: 1000 }, (_, i) => i + 1);
  const p1 = planWindow({ all, first: 1, last: 1000, rc: 0 });
  eq(p1.ranges, [[901, 1000], [651, 900]], "premier passage : le haut, puis un bloc");
  eq(p1.nextRc, 651, "la rotation reprend sous ce bloc");
  eq(p1.uids.length, 350, "100 récents + 250 anciens");

  // Une rotation complète couvre first..last sans trou, même avec des UID
  // supprimés, et finit par revenir en haut.
  const trous = all.filter((u) => u % 7 && !(u > 300 && u < 420));
  const vus = new Set();
  let rc = 0;
  let tours = 0;
  for (;;) {
    const p = planWindow({ all: trous, first: 1, last: 1000, rc });
    for (const [a, b] of p.ranges) for (let u = a; u <= b; u++) vus.add(u);
    rc = p.nextRc;
    if (++tours > 20 || p.complete) break;
  }
  eq(vus.size, 1000, "une rotation couvre tout first..last");
  ok(tours < 10, `et se termine (${tours} passages)`);

  const fin = planWindow({ all: [50, 51, 60], first: 1, last: 60, rc: 0 });
  ok(inRanges(10, fin.ranges), "un UID sous le plus vieux survivant est quand même vérifié");
  eq(planWindow({ all: [], first: 1, last: 60, rc: 0 }).ranges, [[1, 60]], "boîte vidée ailleurs : tout est vérifié");

  const s = strikes([5, 7], [7, 900], [[1, 100]]);
  eq(s.doomed, [7], "deuxième absence : supprimé");
  eq(s.miss, [5, 900], "première absence notée, l'ancienne hors fenêtre attend");
  eq(strikes([], [7], [[1, 100]]).miss, [], "revenu entre-temps : oublié");

  eq(flagState("\x5cSeen \x5cFlagged"), { unread: 0, starred: 1 }, "lu et suivi");
  eq(flagState(""), { unread: 1, starred: 0 }, "ni lu ni suivi");
  eq(flagState("\x5cSeenX"), { unread: 1, starred: 0 }, "un mot-clé voisin ne compte pas");
}

console.log("\n── en-têtes sortants : longueur et pliage ───");
{
  const long = "Réunion de lancement du projet européen — ordre du jour, documents et décisions à prendre";
  const enc = encodeHeader(long);
  ok(enc.split(" ").every((w) => w.length <= 75), "aucun mot encodé au-delà de 75 caractères");
  eq(decodeWords(enc), long, "le sujet découpé se relit à l'identique");
  const many = Array.from({ length: 12 }, (_, i) => `personne${i}@exemple.fr`).join(", ");
  const raw = buildRfc822({ from: "d@x.fr", to: many, subject: long, text: "x" });
  const head = raw.split("\r\n\r\n")[0];
  ok(head.split("\r\n").every((l) => l.length <= 78), "chaque ligne d'en-tête tient en 78 colonnes");
  const toLine = head.match(/^To: [\s\S]*?(?=\r\n\S)/m)[0];
  eq(toLine.replace(/\r\n /g, " "), `To: ${many}`, "la ligne To: dépliée redonne les mêmes adresses");
  const pj = buildRfc822({
    from: "d@x.fr", to: "a@y.fr", text: "x",
    attachments: [{ filename: 'rapport "final".pdf', type: "application/pdf", data: "AA==" }, { filename: "résumé.pdf", type: "application/pdf", data: "AA==" }],
  });
  ok(pj.includes('filename="rapport \\"final\\".pdf"'), "un guillemet dans le nom est échappé");
  ok(pj.includes("filename*=utf-8''r%C3%A9sum%C3%A9.pdf"), "nom accentué en RFC 2231");
}

console.log("\n── noms de boîtes IMAP : UTF-7 modifié ──────");
{
  // RFC 3501 §5.1.3. « Réunions » voyage sous la forme « R&AOk-unions » ; rien
  // ne le décodait, et un nom tapé avec un accent partait en UTF-8 brut.
  const { encodeMailboxName, decodeMailboxName } = await import("./src/mime.js");
  eq(encodeMailboxName("Réunions"), "R&AOk-unions", "un accent : UTF-16 en base64 entre & et -");
  eq(decodeMailboxName("R&AOk-unions"), "Réunions", "et son décodage");
  eq(encodeMailboxName("INBOX/Receipts 2026"), "INBOX/Receipts 2026", "l'ASCII imprimable reste tel quel");
  eq(encodeMailboxName("Tom & Jerry"), "Tom &- Jerry", "& lui-même s'écrit &-");
  eq(decodeMailboxName("Tom &- Jerry"), "Tom & Jerry", "&- redevient &");
  // L'exemple de la RFC : « , » à la place de « / », pas de remplissage.
  eq(decodeMailboxName("~peter/mail/&U,BTFw-/&ZeVnLIqe-"), "~peter/mail/台北/日本語", "exemple de la RFC décodé");
  eq(encodeMailboxName("~peter/mail/台北/日本語"), "~peter/mail/&U,BTFw-/&ZeVnLIqe-", "exemple de la RFC encodé");
  eq(encodeMailboxName("😀"), "&2D3eAA-", "hors BMP : les deux demi-codets UTF-16");
  eq(decodeMailboxName("&2D3eAA-"), "😀", "hors BMP décodé");
  eq(encodeMailboxName("é&è"), "&AOk-&-&AOg-", "& entre deux séquences");
  for (const nom of ["", "Été", "Père & Fils", "Projets/Été 2026/À faire", "📎 Pièces jointes 😀", "a&-b", "日本語 mail", "Ça&là", "tab\tulation"]) {
    const code = encodeMailboxName(nom);
    ok(/^[\x20-\x7e]*$/.test(code), `« ${nom} » encodé en ASCII imprimable : ${code}`);
    eq(decodeMailboxName(code), nom, `aller-retour de « ${nom} »`);
  }
  // Ce qui ne se décode pas est laissé tel qu'écrit, jamais deviné.
  eq(decodeMailboxName("R&D-team"), "R&D-team", "séquence invalide laissée intacte");
  eq(decodeMailboxName("A&"), "A&", "& non terminé laissé intact");
  eq(decodeMailboxName("Archive"), "Archive", "rien à décoder");
}

console.log("\n── contrat : appels du client ↔ routes ──────");
{
  // Le bouton Disconnect a passé des mois à dire « Removed » sans jamais
  // appeler sa route, et personne ne l'a vu : rien ne comparait ce que le
  // client appelle à ce que le Worker sert. C'est ce que fait ce bloc, dans
  // les deux sens.
  const worker = workerSource();
  const exact = [...worker.matchAll(/path === "(\/api\/[^"]+)"/g)].map((m) => m[1]);
  const patterns = [...worker.matchAll(/path\.match\((\/\^\\\/api.*?\$\/)\)/g)].map((m) => new Function(`return ${m[1]}`)());

  const sources = ["public/index.html", "public/sw.js", ...["background.js", "content.js", "options.js"].map((f) => `extension/${f}`)]
    .map((f) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8"))
    .join("\n");
  const calls = [
    ...new Set(
      // Any string that starts a path with /api/: through api(), fetch(), an
      // href, or a helper such as folderCall() and a ternary between two.
      [...sources.matchAll(/[`"](?:\$\{APP\})?(\/api\/[^`"?\s]*)/g)].map((m) => m[1])
    ),
  ].filter((p) => p !== "/api/"); // the service worker's prefix test, not a call
  // Every ${…} tried as each kind of value a route takes: a message id, an
  // account id, an outbox id, an address, an action, a part number.
  const SAMPLES = ["0123456789abcdef", "01234567", "c1b38c5a-854a-4272-8345-ee4861a219dc", "a%40b.fr", "send", "0"];
  const expand = (tpl) => {
    let out = [tpl];
    while (out.some((t) => t.includes("${"))) {
      out = out.flatMap((t) => (t.includes("${") ? SAMPLES.map((s) => t.replace(/\$\{[^}]*\}/, s)) : [t]));
    }
    return out;
  };
  const served = (p) => exact.includes(p) || patterns.some((re) => re.test(p));
  const orphanCalls = calls.filter((tpl) => !expand(tpl).some(served));
  eq(orphanCalls, [], "chaque appel du client tombe sur une route du Worker");

  // Ce que personne n'appelle : diagnostic assumé, ou code mort.
  // /api/veille/feedback is called by the Veille page, which dmzs-digest serves (src/veille.js).
  const DIAGNOSTIC = ["/api/debug/mailboxes", "/api/extension/activate", "/api/veille/feedback"];
  const samples = calls.flatMap(expand);
  const unusedExact = exact.filter((p) => !DIAGNOSTIC.includes(p) && !samples.includes(p));
  const unusedPatterns = patterns
    .filter((re) => !/smtp-check/.test(re.source) && !samples.some((s) => re.test(s)))
    .map((re) => re.source);
  eq([...unusedExact, ...unusedPatterns], [], "aucune route sans appelant hors diagnostic");
  ok(calls.length > 40 && exact.length > 20, `le relevé a trouvé ${calls.length} appels et ${exact.length + patterns.length} routes`);
}

console.log("\n── invitations (iCalendar) ──────────────────");
{
  const { parseIcs, icsReply } = await import("./src/ics.js");
  const ics = [
    "BEGIN:VCALENDAR",
    "METHOD:REQUEST",
    "BEGIN:VTIMEZONE",
    "TZID:Romance Standard Time",
    "BEGIN:STANDARD",
    "TZOFFSETTO:+0100",
    "END:STANDARD",
    "BEGIN:DAYLIGHT",
    "TZOFFSETTO:+0200",
    "END:DAYLIGHT",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    "UID:abc-123@x.fr",
    "SEQUENCE:2",
    "SUMMARY:Point projet\\, revue",
    "LOCATION:Salle 4",
    "DTSTART;TZID=Romance Standard Time:20261020T100000",
    "DTEND;TZID=Romance Standard Time:20261020T110000",
    'ORGANIZER;CN="Jean Dupont":mailto:Jean@Y.fr',
    "ATTENDEE;PARTSTAT=NEEDS-ACTION;CN=Moi:mailto:moi@x.fr",
    "DESCRIPTION:Ordre du jour :\\n1. budget",
    " suite pliée",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const inv = parseIcs(ics);
  eq(inv.method, "REQUEST", "méthode lue");
  eq(inv.summary, "Point projet, revue", "échappements du texte retirés");
  eq(inv.start.ms, Date.UTC(2026, 9, 20, 8, 0), "fuseau Windows résolu par le VTIMEZONE (heure d'été)");
  eq(inv.end.ms - inv.start.ms, 3600_000, "durée d'une heure");
  // Changement d'heure fin octobre : le 26 octobre 2026 est en heure d'hiver (+0100 au lieu de +0200)
  const invHiver = parseIcs(ics.replace("20261020T100000", "20261026T140000").replace("20261020T110000", "20261026T150000"));
  eq(invHiver.start.ms, Date.UTC(2026, 9, 26, 13, 0), "fuseau Windows prend en compte le changement d'heure d'hiver (26 octobre)");
  eq(invHiver.end.ms, Date.UTC(2026, 9, 26, 14, 0), "fin d'événement correcte en heure d'hiver");
  eq(inv.organizer, { email: "jean@y.fr", name: "Jean Dupont" }, "organisateur, adresse en minuscules");
  ok(inv.description.includes("budgetsuite pliée"), "lignes pliées recollées");
  eq(parseIcs("DTSTART;TZID=Europe/Paris:20260115T090000\r\nBEGIN:VEVENT\r\nDTSTART;TZID=Europe/Paris:20260115T090000\r\nUID:u\r\nEND:VEVENT").start.ms,
     Date.UTC(2026, 0, 15, 8, 0), "fuseau IANA par Intl (heure d'hiver)");
  eq(parseIcs("BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261224\r\nUID:u\r\nEND:VEVENT").start.allDay, true, "journée entière");
  eq(parseIcs("rien du tout"), null, "pas d'événement, pas d'invitation");

  const rep = icsReply(inv, { email: "moi@x.fr", name: "Moi", status: "accepted", now: new Date(Date.UTC(2026, 9, 17)) });
  ok(/METHOD:REPLY/.test(rep) && /UID:abc-123@x\.fr/.test(rep) && /SEQUENCE:2/.test(rep), "réponse : même UID et séquence");
  ok(/ATTENDEE;PARTSTAT=ACCEPTED;CN="Moi":mailto:moi@x\.fr/.test(rep), "réponse : moi, accepté");
  ok(rep.includes('ORGANIZER;CN="Jean Dupont":mailto:Jean@Y.fr'), "organisateur recopié tel quel");
  ok(rep.split("\r\n").every((l) => l.length <= 75), "lignes pliées à 75");
  eq(icsReply(inv, { email: "moi@x.fr", status: "peut-être" }), null, "statut inconnu refusé");

  const raw = buildRfc822({ from: "moi@x.fr", to: "jean@y.fr", subject: "Accepted: Point", text: "Accepted", calendar: { method: "REPLY", text: rep } });
  ok(/Content-Type: text\/calendar; charset="utf-8"; method=REPLY/.test(raw), "le message porte la partie text/calendar");

  // Lien Teams / visio extrait
  const icsTeams = ics.replace("LOCATION:Salle 4", "LOCATION:Microsoft Teams Meeting").replace("Ordre du jour :", "Rejoindre https://teams.microsoft.com/l/meetup-join/19%3ameeting_xyz\\nOrdre du jour :");
  const invTeams = parseIcs(icsTeams);
  ok(invTeams.url.includes("teams.microsoft.com"), "lien de réunion Teams extrait");

  // La propriété URL est ce que l'expéditeur a écrit, et finit derrière un
  // lien : seul https en sort.
  const avecUrl = (u, base = ics) => parseIcs(base.replace("SEQUENCE:2", `SEQUENCE:2\r\nURL:${u}`)).url;
  eq(avecUrl("https://exemple.fr/reunion?id=4"), "https://exemple.fr/reunion?id=4", "une URL https est gardée");
  eq(avecUrl("javascript:alert(document.cookie)"), "", "javascript: refusé");
  eq(avecUrl("JaVaScRiPt:alert(1)"), "", "javascript: refusé quelle que soit la casse");
  eq(avecUrl("data:text/html,<script>alert(1)</script>"), "", "data: refusé");
  eq(avecUrl("http://exemple.fr/reunion"), "", "http en clair refusé");
  eq(avecUrl("/api/messages"), "", "une URL relative n'en est pas une");
  ok(avecUrl("javascript:alert(1)", icsTeams).startsWith("https://teams.microsoft.com/"), "une URL refusée laisse la place au lien de visio");
  eq(avecUrl("https://exemple.fr/a", icsTeams), "https://exemple.fr/a", "une URL https l'emporte sur le lien de visio");

  // Et le chemin inverse : une invitation reçue garde sa partie calendrier.
  const recu = parseMessage(
    "Content-Type: multipart/alternative; boundary=B\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nUne reunion\r\n" +
      `--B\r\nContent-Type: text/calendar; method=REQUEST\r\n\r\n${ics}\r\n--B--\r\n`
  );
  ok(recu.calendar && recu.calendar.includes("UID:abc-123"), "la partie calendrier n'est plus perdue");
  ok(recu.attachments.some((a) => a.type === "text/calendar"), "et reste téléchargeable comme fichier");
  eq(recu.text.trim(), "Une reunion", "le texte lisible est toujours celui d'avant");
}

console.log("\n── archive zip des pièces jointes ───────────");
{
  const { zipStream, crc32 } = await import("./src/zip.js");
  const zlib = await import("node:zlib");
  const enc = new TextEncoder();
  const files = { "a.txt": enc.encode("bonjour"), "b.txt": enc.encode("x".repeat(5000)) };
  let loads = 0;
  let closed = 0;
  const stream = zipStream(
    [{ name: "a.txt" }, { name: "b.txt" }, { name: "manquant" }],
    async (e) => { loads++; if (e.name === "manquant") throw new Error("absent"); return files[e.name]; },
    () => { closed++; }
  );
  const reader = stream.getReader();
  const first = await reader.read();
  eq(loads, 1, "un seul fichier lu avant que le lecteur en demande un autre");
  const parts = [first.value];
  for (;;) { const r = await reader.read(); if (r.done) break; parts.push(r.value); }
  const zip = Buffer.concat(parts.map((p) => Buffer.from(p)));
  eq(zip.readUInt32LE(zip.length - 22), 0x06054b50, "fin de répertoire central en place");
  eq(zip.readUInt16LE(zip.length - 12), 2, "deux entrées, le fichier manquant sauté");
  eq(crc32(files["b.txt"]), zlib.crc32(files["b.txt"]), "CRC-32 identique à zlib");
  eq(closed, 1, "onFinish appelé une fois, à la fin");
}

console.log("\n── transport IMAP, faux socket ──────────────");
{
  // imap.js importe cloudflare:sockets, que Node ne connaît pas : on en charge
  // une copie sans cet import, avec la classe exportée, et on lui donne un
  // socket qui livre les octets par morceaux arbitraires.
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const src = readFileSync(new URL("./src/imap.js", import.meta.url), "utf8")
    .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, "let connect = null;\nexport const setConnect = (f) => (connect = f);")
    .replace(/^import \{ MailAuthError, NoRouteError \} from "\.\/errors\.js";$/m, "class MailAuthError extends Error {}\nclass NoRouteError extends Error {}")
    .replace(/from "\.\/(rfc822|mime)\.js";/g, (_m, f) => `from ${JSON.stringify(new URL(`./src/${f}.js`, import.meta.url).href)};`);
  const dir = mkdtempSync(join(tmpdir(), "imap-"));
  writeFileSync(join(dir, "imap.mjs"), src + "\nexport { Imap, NoRouteError, MailAuthError };\n");
  const { Imap, NoRouteError, MailAuthError, imapOpen, setConnect } = await import("file://" + join(dir, "imap.mjs").replace(/\\/g, "/"));

  const fake = (chunks) => {
    const enc = new TextEncoder();
    let i = 0;
    return {
      readable: { getReader: () => ({ read: async () => (i < chunks.length ? { value: enc.encode(chunks[i++]), done: false } : { done: true }) }) },
      writable: { getWriter: () => ({ write: async () => {} }) },
      close() {},
    };
  };
  // Une prise qui meurt avant le bonjour du serveur (Paris, 2026-11-24 :
  // « Stream was cancelled. » en 3 ms vers n'importe quel hôte) : rien n'a
  // été dit, la requête peut être rejouée ailleurs. Après le bonjour, plus
  // question : un LOGIN refusé reste une affaire de mot de passe.
  const morte = () => ({
    readable: { getReader: () => ({ read: async () => { throw new Error("Stream was cancelled."); } }) },
    writable: { getWriter: () => ({ write: async () => {} }) },
    close: async () => {},
  });
  setConnect(() => morte());
  let perdu = null;
  try { await imapOpen({ user: "a@icloud.com", pass: "x" }); } catch (e) { perdu = e; }
  ok(perdu instanceof NoRouteError, "une prise morte avant le bonjour se rejoue ailleurs");
  ok(/Stream was cancelled/.test(perdu && perdu.message), "en gardant le message d'origine");
  setConnect(() => { throw new Error("proxy request failed"); });
  perdu = null;
  try { await imapOpen({ user: "a@icloud.com", pass: "x" }); } catch (e) { perdu = e; }
  ok(perdu instanceof NoRouteError, "une connexion impossible à ouvrir aussi");
  setConnect(() => fake(["* OK hello\r\n", "d0001 NO [AUTHENTICATIONFAILED] Authentication failed.\r\n"]));
  perdu = null;
  try { await imapOpen({ user: "a@icloud.com", pass: "x" }); } catch (e) { perdu = e; }
  ok(perdu instanceof MailAuthError && !(perdu instanceof NoRouteError), "un mot de passe refusé n'est pas rejoué");
  setConnect(null);

  const big = "x".repeat(200_000) + "\r\nfin";
  const flux = `* 1 FETCH (UID 7 BODY[] {${big.length}}\r\n${big})\r\nd0001 OK fait\r\n`;
  // Coupé tous les 997 octets : les fins de ligne et le littéral tombent au milieu.
  const morceaux = [];
  for (let k = 0; k < flux.length; k += 997) morceaux.push(flux.slice(k, k + 997));
  const im = new Imap(fake(morceaux));
  const r = await im.readResponse();
  eq(r.literals[0].length, big.length, "le littéral arrive entier malgré le découpage");
  ok(r.literals[0].endsWith("\r\nfin"), "ses CRLF internes ne coupent rien");
  ok(/UID 7/.test(r.line), "la ligne d'en-tête du FETCH est lue");
  eq(await im.readLine(), "d0001 OK fait", "la réponse suivante reste alignée");

  // Un envoi avec une pièce jointe de 9 Mo pèse ~12 Mo une fois encodé : sa
  // copie doit pouvoir partir dans Sent chez Apple (2026-11-15, le papier 2
  // n'y était pas), alors que la lecture reste plafonnée à 8 Mo.
  const sentBytes = [];
  const ack = fake(["+ go ahead\r\n", "d0001 OK APPEND completed\r\n"]);
  ack.writable.getWriter = () => ({ write: async (b) => sentBytes.push(typeof b === "string" ? b.length : b.length) });
  const ap = new Imap(ack);
  const lourd = "y".repeat(12 * 1024 * 1024);
  let refus = "";
  try { await ap.commandLiteral('APPEND "Sent Messages" (\\Seen)', lourd); } catch (e) { refus = e.message; }
  eq(refus, "", "une copie de 12 Mo part dans Sent");
  ok(sentBytes.includes(lourd.length), "le message part entier, en un littéral");
  let trop = "";
  try { await new Imap(fake([])).commandLiteral('APPEND "Sent Messages" (\\Seen)', "z".repeat(33 * 1024 * 1024)); } catch (e) { trop = e.message; }
  ok(/too large/.test(trop), "au-delà de 32 Mo, refus avant d'écrire quoi que ce soit");
  let lu = "";
  try { await new Imap(fake([])).readBytes(9 * 1024 * 1024); } catch (e) { lu = e.message; }
  ok(/too large/.test(lu), "la lecture reste plafonnée à 8 Mo");
}

console.log("\n── audit 2026-10-17 : images encodées, URL de l'app ──");
{
  // Le filtre lisait le texte brut ; le navigateur résout d'abord les
  // références et les échappements CSS. Chacune de ces formes chargeait le
  // pixel sans que `blocked` ne bouge.
  const fuite = /(?<!data-blocked-)(src|srcset|background|poster)\s*=\s*["']?[^"'\s>]*t\.example/i;
  for (const [html, label] of [
    [`<img src="&#104;ttps://t.example/p.gif">`, "référence décimale"],
    [`<img src="&#x68;ttps://t.example/p.gif">`, "référence hexadécimale"],
    [`<img src="https&colon;//t.example/p.gif">`, "référence nommée"],
    [`<img src="ht\ttps://t.example/p.gif">`, "tabulation dans le schéma"],
    [`<img src="\\\\t.example\\p.gif">`, "barres inverses pour //"],
  ]) {
    const out = sanitizeHtml(html);
    ok(out.blocked === 1 && !fuite.test(out.html), `${label} — obtenu ${JSON.stringify(out)}`);
  }
  const restaure = sanitizeHtml(`<img src="&#104;ttps://t.example/p.gif?a=1&amp;b=2">`).html;
  ok(restaure.includes('data-blocked-src="https://t.example/p.gif?a=1&amp;b=2"'), `valeur décodée puis réécrite proprement — ${restaure}`);

  for (const [html, label] of [
    [`<div style="background:url&#40;https://t.example/p.gif&#41;">x</div>`, "url&#40; dans style"],
    [`<div style="background:u\\72l(https://t.example/p.gif)">x</div>`, "échappement CSS dans style"],
  ]) {
    ok(!/t\.example/.test(sanitizeHtml(html).html), label);
  }
  for (const [css, label] of [
    [`@\\69mport "https://t.example/x.css";`, "@import échappé"],
    [`body{background:u\\72l(https://t.example/p.gif)}`, "url( échappé"],
    [`body{background:u\\000072l(https://t.example/p.gif)}`, "échappement à six chiffres"],
    [`body{background:image-set("https://t.example/p.gif" 1x)}`, "image-set à chaînes nues"],
    [`body{background:url(/api/messages/0123456789abcdef)}`, "url() relative"],
  ]) {
    const out = sanitizeHtml(`<style>${css}</style><p>t</p>`).html;
    ok(!/t\.example|\/api\//.test(out) && out.includes("<p>t</p>"), `${label} — ${out}`);
  }
  // Ce qui n'a rien d'échappé reste tel quel, sélecteurs échappés compris.
  const sel = sanitizeHtml(`<style>.a\\:b{color:red}</style>`).html;
  ok(sel.includes(".a\\:b{color:red}"), "un sélecteur échappé sans chargement n'est pas réécrit");

  // Le cadre d'impression partage l'origine de l'app : une URL qui y retombe
  // part avec le cookie. <img src="/api/messages/…"> marquait le message lu.
  const host = "mail.agentxr.app";
  for (const [html, label] of [
    [`<img src="/api/messages/0123456789abcdef">`, "racine relative"],
    [`<img src="api/messages/0123456789abcdef">`, "relative"],
    [`<img src="https:/api/messages/0123456789abcdef">`, "https: sans hôte"],
    [`<img src="https://mail.agentxr.app/api/messages/0123456789abcdef">`, "hôte de l'app"],
    [`<img src="//MAIL.agentxr.app/logout">`, "hôte de l'app, protocole relatif"],
    [`<img src="&#47;logout">`, "racine relative encodée"],
    [`<video poster="/x.png"></video>`, "poster relatif"],
  ]) {
    const out = sanitizeHtml(html, { host });
    ok(out.blocked === 0 && !/api\/messages|logout|x\.png/i.test(out.html), `${label} — ${JSON.stringify(out)}`);
  }
  const mix = sanitizeHtml(`<img srcset="/a.png 1x, https://t.example/b.png 2x">`, { host });
  ok(mix.blocked === 1 && !/a\.png/.test(mix.html) && mix.html.includes('data-blocked-srcset="https://t.example/b.png 2x"'),
     `srcset : le candidat de l'app retiré, le distant bloqué — ${mix.html}`);
  const dataSet = `<img srcset="data:image/png;base64,AAAA 1x, data:image/png;base64,BBBB 2x">`;
  eq(sanitizeHtml(dataSet, { host }).html, dataSet, "srcset data: intact malgré ses virgules");
  ok(sanitizeHtml(`<img src="https://other.example/p.gif">`, { host }).blocked === 1, "un autre hôte reste distant");
  ok(/src="cid:x"/.test(sanitizeHtml(`<img src="cid:x">`, { host }).html), "cid: intact");
  ok(!/javascript/i.test(sanitizeHtml(`<a href="java&#115;cript:alert(1)">x</a>`).html), "javascript: encodé neutralisé");
}

console.log("\n── sessions : révocation, portée de l'extension ──");
{
  const auth = await import("./src/auth.js");
  const secret = "s".repeat(32);
  const now = Math.floor(Date.now() / 1000);

  // Une base D1 réduite à la seule requête que requestSession pose.
  const fakeDb = ({ after = null, gone = [], broken = false } = {}) => ({
    prepare: () => ({
      bind(sid) { this.sid = sid; return this; },
      async first() {
        if (broken) throw new Error("no such table: revoked_sessions");
        return { after, gone: gone.includes(this.sid) ? 1 : null };
      },
      async run() {},
    }),
  });
  const reqWith = (token, { path = "/api/messages", method = "GET", header = false } = {}) =>
    new Request(`https://mail.agentxr.app${path}`, {
      method,
      headers: header ? { "X-Session": token } : { Cookie: `dmzs_session=${token}` },
    });
  // Signe une charge utile choisie : les jetons d'avant les sid, ou un kid faux.
  const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
  const mint = async (payload) => {
    const body = b64u(new TextEncoder().encode(JSON.stringify(payload)));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return `${body}.${b64u(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))}`;
  };

  const tok = await auth.issueSession(secret, { name: "Laptop" });
  const p = await auth.readSession(tok, secret);
  ok(/^[0-9a-f]{24}$/.test(p.sid), "un jeton neuf porte un sid");
  ok(p.exp - p.iat === auth.SESSION_TTL && auth.SESSION_TTL <= 400 * 86400, "durée bornée à 400 jours");
  ok(p.sid !== (await auth.readSession(await auth.issueSession(secret), secret)).sid, "deux sid différents");

  const env = (db) => ({ AUTH_SECRET: secret, DB: db });
  ok(await auth.requestSession(reqWith(tok), env(fakeDb())), "session valide acceptée");
  ok(!(await auth.requestSession(reqWith(tok), env(fakeDb({ gone: [p.sid] })))), "sid sur la liste noire refusé");
  ok(!(await auth.requestSession(reqWith(tok), env(fakeDb({ after: String(now + 5) })))), "émis avant la coupure : refusé");
  ok(await auth.requestSession(reqWith(tok), env(fakeDb({ after: String(now - 5) }))), "émis après la coupure : accepté");
  ok(await auth.requestSession(reqWith(tok), env(fakeDb({ broken: true }))), "table absente juste après un déploiement : pas de verrouillage");

  // Les jetons d'avant : pas de sid, parfois pas d'iat. Valides jusqu'à une
  // coupure, et échangés dès le premier passage.
  const legacy = await mint({ exp: now + 4 * 365 * 86400, iat: now - 86400, sub: "iOS" });
  const lp = await auth.requestSession(reqWith(legacy), env(fakeDb()));
  ok(lp && !lp.sid, "un ancien jeton sans sid reste valide");
  ok(!(await auth.requestSession(reqWith(legacy), env(fakeDb({ after: String(now) })))), "la coupure atteint les anciens jetons");
  const swapped = await auth.renewedCookie(lp, env(fakeDb()));
  ok(/^dmzs_session=/.test(swapped || ""), "un ancien jeton est réémis tout de suite");
  const sp = await auth.readSession(swapped.split(";")[0].split("=")[1], secret);
  ok(sp.sid && sp.sub === "iOS", "le jeton réémis a un sid et garde son nom");
  ok((await auth.renewedCookie(p, env(fakeDb()))) === null, "un jeton neuf n'est pas réémis");

  // kid : signé par ce secret mais annonçant une autre clé.
  const liar = await mint({ exp: now + 3600, iat: now, sub: "x", kid: "deadbeef", sid: "a".repeat(24) });
  ok(!(await auth.requestSession(reqWith(liar), env(fakeDb()))), "un kid qui ne correspond pas est refusé");
  ok(!(await auth.requestSession(reqWith(await mint({ exp: now + 3600, iat: now, scope: "admin" })), env(fakeDb()))),
     "une portée inconnue est refusée");

  // L'extension : le compteur, rien d'autre.
  const push = await auth.issueSession(secret, { scope: auth.PUSH_SCOPE });
  const H = { header: true };
  ok(await auth.requestSession(reqWith(push, { path: "/api/push/state", ...H }), env(fakeDb())), "jeton push : GET /api/push/state passe");
  ok(!(await auth.requestSession(reqWith(push, { path: "/api/messages", ...H }), env(fakeDb()))), "jeton push : la liste des messages refusée");
  ok(!(await auth.requestSession(reqWith(push, { path: "/api/push/state", method: "POST", ...H }), env(fakeDb()))), "jeton push : POST refusé");
  ok(!(await auth.requestSession(reqWith(push, { path: "/api/send", method: "POST", ...H }), env(fakeDb()))), "jeton push : envoi refusé");
  const pp = await auth.requestSession(reqWith(push, { path: "/api/push/state", ...H }), env(fakeDb()));
  ok((await auth.renewedHeaderToken(pp, env(fakeDb()))) === null, "un jeton push neuf n'est pas remplacé");
  ok((await auth.renewedCookie(pp, env(fakeDb()))) === null, "un jeton d'en-tête ne reçoit jamais de cookie");

  // L'ancien jeton complet de l'extension : remplacé par un jeton push.
  const oldExt = await auth.requestSession(reqWith(legacy, { path: "/api/push/state", ...H }), env(fakeDb()));
  const repl = await auth.readSession(await auth.renewedHeaderToken(oldExt, env(fakeDb())), secret);
  eq(repl && repl.scope, auth.PUSH_SCOPE, "l'ancien jeton de l'extension est échangé contre un jeton push");
  ok((await auth.renewedHeaderToken(p, env(fakeDb()))) === null, "un cookie n'est jamais remplacé par en-tête");

  // Se déconnecter : le sid va sur la liste, jusqu'à son expiration.
  const writes = [];
  await auth.revokeSession(p, { DB: { prepare: (sql) => ({ bind: (...a) => ({ run: async () => writes.push([sql, a]) }) }) } });
  ok(/INSERT/.test(writes[0][0]) && writes[0][1][0] === p.sid && writes[0][1][1] === p.exp, "revokeSession inscrit le sid et son exp");
  ok(writes.some(([sql]) => /DELETE FROM revoked_sessions WHERE exp </.test(sql)), "et balaie ceux déjà expirés");
  // Les autres appareils : une coupure, et un jeton pour celui qui demande.
  const set = [];
  const keep = await auth.revokeOthers(p, { AUTH_SECRET: secret, DB: { prepare: (sql) => ({ bind: (v) => ({ run: async () => set.push([sql, v]) }) }) } });
  const kp = await auth.readSession(keep, secret);
  ok(/sessions_after/.test(set[0][0]) && kp.iat >= Number(set[0][1]), "le jeton gardé est émis à la coupure, pas avant");
  ok(await auth.requestSession(reqWith(keep), env(fakeDb({ after: set[0][1] }))), "l'appareil qui demande reste connecté");
}

{
  // Envoi par Cloudflare Email Sending pour les adresses de vos domaines.
  const relay = await import("./src/relay.js");
  const sent = [];
  const EMAIL = { send: async (m) => (sent.push(m), { messageId: "abc123@agentxr.app" }) };
  const env = { EMAIL, RELAY_DOMAINS: "agentxr.app, Other.Example" };
  ok(relay.isRelayed(env, "damien.mazeas@agentxr.app"), "une adresse agentxr.app passe par Cloudflare");
  ok(relay.isRelayed(env, "X@OTHER.example"), "la casse du domaine ne compte pas");
  ok(!relay.isRelayed(env, "damien.mazeas@icloud.com"), "une adresse iCloud reste sur iCloud");
  ok(!relay.isRelayed(env, "evil@agentxr.app.attacker.com"), "un sous-domaine étranger n'est pas relayé");
  ok(!relay.isRelayed({ RELAY_DOMAINS: "agentxr.app" }, "a@agentxr.app"), "sans binding, rien n'est relayé");
  ok(!relay.isRelayed({ EMAIL }, "a@agentxr.app"), "sans RELAY_DOMAINS, rien n'est relayé");

  const m = relay.relayMessage({
    fromName: "Damien Mazeas",
    from: "damien.mazeas@agentxr.app",
    to: ["a@example.com"],
    cc: [],
    bcc: ["secret@example.com"],
    subject: "Re: Bonjour",
    text: "salut",
    html: "<p>salut</p>",
    attachments: [{ filename: "a.pdf", type: "application/pdf", data: "JVBER" }, { filename: "", data: "x" }],
    inReplyTo: "<p@x>",
    references: ["<r@x>", "<p@x>"],
  });
  eq(JSON.stringify(m.from), JSON.stringify({ email: "damien.mazeas@agentxr.app", name: "Damien Mazeas" }), "le nom va avec l'adresse");
  ok(!("cc" in m), "pas de Cc vide");
  eq(m.bcc.join(), "secret@example.com", "le Cci est un champ à part");
  ok(!JSON.stringify(m.headers).includes("secret@"), "et jamais un en-tête");
  eq(m.headers["In-Reply-To"], "<p@x>", "In-Reply-To pour le fil");
  eq(m.headers.References, "<r@x> <p@x>", "References pour le fil");
  ok(!Object.keys(m.headers).some((h) => /^(date|message-id|from|to)$/i.test(h)), "aucun en-tête que Cloudflare refuse");
  eq(m.attachments.length, 1, "les pièces sans nom sont écartées");
  eq(JSON.stringify(m.attachments[0]), JSON.stringify({ content: "JVBER", filename: "a.pdf", type: "application/pdf", disposition: "attachment" }), "pièce jointe au format Cloudflare");
  eq(relay.relayMessage({ fromName: "a@agentxr.app", from: "a@agentxr.app", to: ["b@x.y"], text: "t" }).from, "a@agentxr.app", "sans nom propre, l'adresse seule");
  ok(!("headers" in relay.relayMessage({ from: "a@agentxr.app", to: ["b@x.y"], text: "t" })), "pas d'en-têtes hors d'une réponse");

  eq(await relay.relaySend(env, m), "<abc123@agentxr.app>", "le Message-ID rendu par Cloudflare, entre chevrons");
  eq(sent.length, 1, "un seul envoi");
  eq(await relay.relaySend({ EMAIL: { send: async () => ({ messageId: "opaque" }) } }, m), "", "un identifiant qui n'en est pas un est ignoré");
  let err = "";
  try {
    await relay.relaySend({ EMAIL: { send: async () => { const e = new Error("nope"); e.code = "E_SENDER_DOMAIN_NOT_AVAILABLE"; throw e; } } }, m);
  } catch (e) {
    err = e.message;
  }
  ok(/E_SENDER_DOMAIN_NOT_AVAILABLE/.test(err) && /nope/.test(err), "le refus de Cloudflare remonte avec son code");
}

console.log("\n── recherche : opérateurs ──────────────────");
{
  // Le vrai schéma dans un vrai SQLite : une erreur de syntaxe FTS5 dans une
  // expression MATCH fait échouer ces tests, pas la production.
  const db = new DatabaseSync(":memory:");
  for (const s of SCHEMA) db.exec(s);
  const D = (iso) => Date.parse(iso);
  const MSGS = [
    // id, expéditeur, e-mail, to, cc, sujet, corps, non lu, étoile, couleur, pièces jointes, date
    ["m1", "Ada Lovelace", "ada@math.org", "me@x.fr", "bob@x.fr", "Budget 2027", "the numbers for the budget", 1, 0, 0, "budget.xlsx\nnotes.txt", "2026-10-15T12:00:00Z"],
    ["m2", "Bob", "bob@x.fr", "ada@math.org", "", "Lunch", "pizza on friday", 0, 1, 2, "", "2026-09-30T23:30:00Z"],
    ["m3", "Ada Lovelace", "ada@math.org", "me@x.fr", "", "Re: budget", "see attached", 1, 0, 5, null, "2026-10-01T09:00:00Z"],
    ["m4", "Zoé", "zoe@x.fr", "me@x.fr", "", "100% sure", "release the budget near and or not", 0, 0, 0, "", "2026-11-02T08:00:00Z"],
    ["m5", "Carol", "carol@x.fr", "me@x.fr", "", "Relevé", "a_b matches only itself", 0, 0, 3, "Relevé mars.pdf", "2026-10-31T23:30:00Z"],
  ];
  const ins = db.prepare(
    `INSERT INTO messages (id, account_id, pid, from_name, from_email, to_line, cc_line, subject, date, unread, starred, color, att_names, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`
  );
  const fts = db.prepare("INSERT INTO search (id, subject, sender, body) VALUES (?,?,?,?)");
  for (const [id, name, email, to, cc, subject, body, unread, starred, color, att, at] of MSGS) {
    ins.run(id, "a", id, name, email, to, cc, subject, D(at), unread, starred, color, att);
    fts.run(id, subject, `${name} ${email}`, body);
  }
  const search = (term, tz = 0) => {
    const q = parseSearch(term, { tzOffsetMin: tz });
    ok(q.values.length <= 80, `peu de valeurs liées pour « ${term} » (${q.values.length})`);
    const sql = `SELECT m.id FROM messages m WHERE 1=1${q.where.map((w) => " AND " + w).join("")} ORDER BY m.id`;
    return db.prepare(sql).all(...q.values).map((r) => r.id);
  };

  // Le cas de la demande, tel quel.
  eq(search("budget from:ada has:attachment after:2026-10-01 is:unread"), ["m1"], "la requête complète");

  console.log("  mots, -mot, « phrase »");
  eq(search("budget"), ["m1", "m3", "m4"], "des mots simples, comme avant");
  eq(search("budg"), ["m1", "m3", "m4"], "le dernier mot est un préfixe");
  eq(search("budg numbers"), [], "mais pas un mot du milieu : il est fini, donc entier");
  eq(search("budget numb"), ["m1"], "tout se combine par ET, le préfixe va au dernier");
  eq(search("releve"), ["m5"], "les accents sont repliés");
  eq(search('"near and or"'), ["m4"], "une phrase exacte");
  eq(search('"and near"'), [], "dans l'ordre");
  eq(search("budget -lunch"), ["m1", "m3", "m4"], "-mot écarte un mot absent");
  eq(search("budget -numbers"), ["m3", "m4"], "-mot écarte ce qui le contient");
  eq(search("-budget"), ["m2", "m5"], "une requête faite de négations seules");
  eq(search('budget -"near and"'), ["m1", "m3"], "-\"phrase\"");
  eq(search("zoe@x.fr"), ["m4"], "une adresse collée se cherche comme avant");
  eq(search("https://zoe.x.fr/a?b=c#d"), [], "une URL collée est une recherche, pas une erreur");
  eq(search("100%"), ["m4"], "100% se cherche par ses chiffres");
  eq(search("%%"), [], "« %% » retombe sur LIKE et ne vaut pas joker");
  eq(search("a_b"), ["m5"], "a_b par l'index");

  console.log("  from: to: cc:");
  eq(search("from:ada"), ["m1", "m3"], "from: par le nom ou l'adresse");
  eq(search("from:math.org"), ["m1", "m3"], "from: par un morceau d'adresse");
  eq(search('from:"ada lovelace"'), ["m1", "m3"], "une valeur entre guillemets");
  eq(search('from:"lovelace ada"'), [], "avec l'espace de la valeur");
  eq(search("FROM:Bob"), ["m2"], "clé et valeur insensibles à la casse");
  eq(search("to:ada"), ["m2"], "to:");
  eq(search("cc:bob"), ["m1"], "cc:");
  eq(search("from:a_b"), [], "_ n'est pas un joker dans from:");
  eq(search("from:%"), [], "% non plus");

  console.log("  subject: body:");
  eq(search("subject:budget"), ["m1", "m3"], "subject: ne regarde que le sujet");
  eq(search("body:budget"), ["m1", "m4"], "body: ne regarde que le corps");
  eq(search('subject:"budget 2027"'), ["m1"], "subject: avec une phrase");
  eq(search("subject:budg"), ["m1", "m3"], "subject: en cours de frappe est un préfixe");
  eq(search("subject:budget body:friday"), [], "deux colonnes se combinent par ET");
  eq(search("subject:lunch body:friday"), ["m2"], "deux colonnes qui s'accordent");
  eq(search("subject:budget -numbers"), ["m3"], "colonne et négation ensemble");

  console.log("  has: attachment:");
  eq(search("has:attachment"), ["m1", "m5"], "has:attachment — le NULL (pas encore lu) n'y est pas");
  eq(search("attachment:budget"), ["m1"], "attachment: par un morceau du nom");
  eq(search("attachment:RELEV"), ["m5"], "la casse ASCII ne compte pas");
  eq(search("attachment:relevé"), ["m5"], "les accents sont gardés tels quels");
  eq(search('attachment:"mars.pdf"'), ["m5"], "attachment: entre guillemets");
  eq(search("attachment:%"), [], "% n'est pas un joker dans attachment:");
  eq(search("has:everything"), [], "has: inconnu = mots simples");

  console.log("  is: category:");
  eq(search("is:unread"), ["m1", "m3"], "is:unread");
  eq(search("is:read"), ["m2", "m4", "m5"], "is:read");
  eq(search("is:flagged"), ["m2"], "is:flagged");
  eq(search("is:starred"), ["m2"], "is:starred est la même étoile");
  eq(search("category:orange"), ["m2"], "category:orange = couleur 2");
  eq(search("category:blue"), ["m3"], "category:blue = couleur 5");
  eq(search("category:yellow is:read"), ["m5"], "category: et is: ensemble");
  eq(search("category:green"), [], "personne n'est vert");
  eq(search("category:purple"), [], "category: inconnue = mots simples");

  console.log("  after: before: on:, dans le fuseau du lecteur");
  eq(search("after:2026-10-15"), ["m1", "m4", "m5"], "after: inclut le jour même");
  eq(search("before:2026-10-15"), ["m2", "m3"], "before: s'arrête avant ce jour");
  eq(search("on:2026-10-15"), ["m1"], "on:");
  eq(search("after:2026-10-01 before:2026-11-01"), ["m1", "m3", "m5"], "une plage");
  eq(search("on:2026-10-01"), ["m3"], "en UTC, m2 (30/09 23:30Z) est le 30 septembre");
  eq(search("on:2026-10-01", -120), ["m2", "m3"], "à Paris (-120), il est déjà le 1er octobre");
  eq(search("on:2026-09-30", -120), [], "et plus le 30");
  eq(search("on:2026-10-31", 0), ["m5"], "m5 (31/10 23:30Z) est le 31 en UTC");
  eq(search("on:2026-10-31", -120), [], "mais le 1er novembre à Paris");
  eq(search("on:2026-11-01", -120), ["m5"], "…");
  eq(search("on:2026-10-31", 300), ["m5"], "et à New York (+300) toujours le 31, à 18:30");
  eq(search("on:2026-10-15", "abc"), ["m1"], "un décalage inutilisable est lu comme UTC");
  eq(search("on:2026-10-01", 99999), ["m3"], "et un décalage absurde aussi");
  eq(search("after:2026/10/15"), ["m1", "m4", "m5"], "les / sont admis");

  console.log("  ce qui n'est pas compris se cherche comme des mots");
  eq(search("after:2026-13-45"), [], "une date impossible : mots « after 2026 13 45 »");
  eq(parseSearch("after:2026-02-30").where.length, 1, "le 30 février aussi");
  ok(parseSearch("after:2026-02-30").where[0].includes("MATCH"), "… et ce sont bien des mots");
  eq(search("after:tomorrow"), [], "after:tomorrow");
  eq(search("colour:red budget"), [], "clé inconnue : « colour red budget » ET");
  eq(search("colour:red"), [], "clé inconnue seule");
  eq(search("from:"), [], "from: sans valeur");
  eq(search("constructor:x __proto__:y toString:z"), [], "des noms d'Object ne sont pas des opérateurs");
  eq(search("is:constructor"), [], "ni des valeurs");
  ok(!Object.hasOwn(OPERATORS, "constructor"), "la table ne connaît que ses clés");
  eq(search("-from:ada"), ["m1", "m2", "m3", "m4", "m5"], "-clé:valeur écarte la phrase « from ada », il ne nie pas l'opérateur");

  console.log("  hostile : jamais d'erreur SQL ni FTS5");
  const hostile = [
    '"', '""', '"""', '*', '**', '^budget', '(budget', 'budget)', '(', ')', ':', '::', 'budget:', ':budget',
    '-', '--', '---budget', '- -', '-"', '-""', '"-', 'NEAR(a b)', 'NEAR/2', 'a OR b', 'a AND', 'NOT a', 'OR', 'AND', 'NOT', 'a NOT b',
    '{subject}: budget', 'subject: budget', 'subject:{a}', 'subject:"', 'subject:""', 'subject:*', 'subject:-', 'body:(', 'body:")',
    'from:"', 'from:""', "from:'", "from:'; DROP TABLE messages; --", "'; DROP TABLE messages; --", '" OR 1=1 --',
    'attachment:"', 'has:', 'has::', 'is:', 'category:', 'after:', 'after:"', 'on:"2026-10-01', 'before:-1', 'on:0000-01-01', 'on:9999-12-31',
    'on:2026-10-01 on:2026-10-02', 'a:b:c:d', '\\', '\\"', '%', '_', '\0', 'budget\0', '\n', '\t"a\tb"\n', '😀', '"😀"', 'subject:😀',
    '+', '+a', 'a+b', 'a.b', '@', '<script>', 'a"b"c', 'a""b', '"a""b"', '$', '[]', '{}', 'ΑΒΓ', 'ǅ', '١٢٣', '́', 'á',
  ];
  for (const term of hostile) {
    let threw = "";
    try { search(term); } catch (e) { threw = e.message; }
    ok(!threw, `« ${JSON.stringify(term)} » ne casse rien : ${threw}`);
  }
  eq(db.prepare("SELECT count(*) n FROM messages").get().n, MSGS.length, "et la table est intacte");

  console.log("  au plafond des 120 caractères");
  const capped = [
    "from:" + "x".repeat(115),
    "-" + "x".repeat(119),
    "x".repeat(120),
    ("from:\"ada lovelace\" ").repeat(7).slice(0, 120),
    ("-a ").repeat(40),
    ("from:a ").repeat(18).slice(0, 120),
    ("is:read ").repeat(15),
    ("subject:b body:c ").repeat(8).slice(0, 120),
    ("\"a b\" -\"c d\" ").repeat(10).slice(0, 120),
    "é".repeat(120),
    '"' + "a ".repeat(59),
  ];
  for (const term of capped) {
    eq(term.length <= 120, true, "le terme fait au plus 120 caractères : " + term.length);
    let threw = "";
    try { search(term); } catch (e) { threw = e.message; }
    ok(!threw, `« ${term.slice(0, 40)}… » (${term.length}) ne casse rien : ${threw}`);
  }
  // Le pire cas en valeurs liées : D1 en refuse plus de 100 par requête, et la
  // route en ajoute déjà jusqu'à 42 (dossier « envoyés » et compte).
  const most = Math.max(...capped.map((t) => parseSearch(t).values.length));
  ok(most + 42 <= 100, `au plus ${most} valeurs liées pour 120 caractères`);

  console.log("  la forme de ce qui est rendu");
  eq(parseSearch("budget"), { where: ["m.id IN (SELECT id FROM search WHERE search MATCH ?)"], values: ['"budget"*'] }, "un mot");
  eq(parseSearch("budget -zz").values, ['"budget"', '"zz"'], "un mot et une négation, chacun sa MATCH");
  eq(parseSearch("a b subject:c").values[0], '"a" AND "b" AND subject : "c"*', "mots et colonne dans une seule MATCH, le dernier en préfixe");
  eq(parseSearch("%%").values, ["%\\%\\%%", "%\\%\\%%", "%\\%\\%%"], "sans mot indexable : LIKE sur les en-têtes, échappé");
  eq(parseSearch("").where.length, 1, "le vide ne casse pas");
  eq(parseSearch("on:2026-10-01", { tzOffsetMin: -120 }).values, [Date.UTC(2026, 9, 1) - 120 * 60000, Date.UTC(2026, 9, 1) - 120 * 60000 + 86400000], "on: = minuit local, 24 h");
}

console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} assertions passées, ${fail} échec(s)\n`);
process.exit(fail ? 1 : 0);
