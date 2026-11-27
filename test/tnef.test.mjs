/**
 * The TNEF reader (src/tnef.js) and what the message parser makes of a
 * winmail.dat. The container below is built by hand, byte by byte, from the
 * format's own description: no real Outlook mail was available, so what is
 * proven is the format as documented, not any one writer's quirks.
 */
import { eq, ok } from "./harness.mjs";
import { isTnef, parseTnef, TNEF_LIMITS } from "../src/tnef.js";
import { parseMessage } from "../src/rfc822.js";
import { b64encode } from "../src/mime.js";

const enc = new TextEncoder();
const u16 = (n) => [n & 255, (n >> 8) & 255];
const u32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const cat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));
const pad4 = (b) => cat(b, new Uint8Array((4 - (b.length % 4)) % 4));
const utf16 = (s) => Uint8Array.from([...s].flatMap((c) => u16(c.charCodeAt(0))).concat([0, 0]));

/** One attribute: level, id, length, data, and a checksum nobody reads. */
const attr = (level, id, data) => cat([level], u32(id), u32(data.length), data, u16(0));

/** A MAPI property block of string and binary properties. */
const mapi = (props) =>
  cat(
    u32(props.length),
    ...props.map(({ id, type, value }) =>
      cat(u32(((id << 16) | type) >>> 0), u32(1), u32(value.length), pad4(value))
    )
  );

const PT_UNICODE = 0x1f;
const PT_STRING8 = 0x1e;
const PT_BINARY = 0x102;

/** A file the way Outlook writes it: render data, title, data, then MAPI. */
const file = ({ title, long, mime, data, viaMapi }) =>
  cat(
    attr(2, 0x00069002, new Uint8Array(14)),
    title ? attr(2, 0x00018010, cat(enc.encode(title), [0])) : new Uint8Array(0),
    viaMapi ? new Uint8Array(0) : attr(2, 0x0006800f, data),
    attr(
      2,
      0x00069005,
      mapi([
        ...(long ? [{ id: 0x3707, type: PT_UNICODE, value: utf16(long) }] : []),
        ...(mime ? [{ id: 0x370e, type: PT_STRING8, value: cat(enc.encode(mime), [0]) }] : []),
        ...(viaMapi ? [{ id: 0x3701, type: PT_BINARY, value: data }] : []),
      ])
    )
  );

const tnef = (...parts) => cat(u32(0x223e9f78), u16(0x1234), ...parts);

const hello = enc.encode("Hello from inside.\n");
const pdf = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 255);

const sample = tnef(
  attr(1, 0x0002800c, cat(enc.encode("The body text.\r\n"), [0])),
  file({ title: "REPORT~1.TXT", long: "Quarterly report.txt", mime: "text/plain", data: hello }),
  file({ title: "scan.pdf", data: pdf }) // legacy name only, type from the extension
);

console.log("\n-- tnef : lecture d'un winmail.dat construit à la main ---------");
{
  ok(isTnef(sample), "la signature est reconnue");
  const r = parseTnef(sample);
  eq(r.files.length, 2, "deux fichiers");
  eq(r.files[0].name, "Quarterly report.txt", "nom long (propriété MAPI) préféré au nom hérité");
  eq(r.files[0].type, "text/plain", "type donné par la propriété MIME");
  eq(r.files[0].size, hello.length, "taille réelle");
  eq([...r.files[0].data], [...hello], "octets du premier fichier");
  eq(r.files[1].name, "scan.pdf", "nom hérité quand il n'y a pas de nom long");
  eq(r.files[1].type, "application/pdf", "type déduit de l'extension");
  eq([...r.files[1].data], [...pdf], "octets du second fichier");
  eq(r.text.trim(), "The body text.", "texte du message");

  // Newer writers carry the payload in a MAPI binary instead of attAttachData.
  const viaMapi = parseTnef(tnef(file({ long: "inside.bin", data: pdf, viaMapi: true })));
  eq([...(viaMapi.files[0]?.data ?? [])], [...pdf], "charge utile dans PR_ATTACH_DATA_BIN");

  // The message's text can also arrive as a MAPI property rather than attBody.
  const body = parseTnef(tnef(attr(1, 0x00069003, mapi([{ id: 0x1000, type: PT_UNICODE, value: utf16("Texte MAPI") }]))));
  eq(body.text, "Texte MAPI", "PR_BODY en UTF-16");

  // A name that tries to leave its folder, and one that is only control bytes.
  const hostile = parseTnef(tnef(file({ long: "..\\..\\etc/pass\u0001wd", data: hello }), file({ long: "\u0001\u0002", data: hello })));
  eq(hostile.files[0].name, "passwd", "dossiers et caractères de contrôle retirés du nom");
  eq(hostile.files[1].name, "attachment-2", "un nom vide devient un nom neutre");
}

console.log("\n-- tnef : tronqué à chaque octet ---------");
{
  let threw = 0;
  let partial = 0;
  for (let n = 0; n <= sample.length; n++) {
    try {
      const r = parseTnef(sample.subarray(0, n));
      // What comes back is whole: a file is either complete or absent.
      for (const f of r.files) {
        const want = f.name === "scan.pdf" ? pdf : hello;
        if (f.data.length !== want.length || f.data.some((b, i) => b !== want[i])) partial++;
      }
    } catch {
      threw++;
    }
  }
  eq(threw, 0, `aucune levée sur ${sample.length + 1} longueurs`);
  eq(partial, 0, "jamais de fichier incomplet");
  eq(parseTnef(sample.subarray(0, sample.length - 2)).files.length, 2, "seule la somme finale manque : les fichiers restent");
}

console.log("\n-- tnef : longueurs et comptes absurdes ---------");
{
  // An attribute that claims 4 GB.
  const huge = cat(u32(0x223e9f78), u16(1), [2], u32(0x0006800f), u32(0xffffffff), hello);
  eq(parseTnef(huge).files.length, 0, "longueur de 4 Go : rien, sans erreur");

  // A MAPI block that claims four billion properties, then a property that claims a huge value.
  const manyProps = tnef(attr(2, 0x00069005, cat(u32(0xffffffff), u32((0x3707 << 16) | PT_UNICODE), u32(1), u32(0xfffffff0))));
  ok(Array.isArray(parseTnef(manyProps).files), "compte de propriétés absurde : pas de levée");

  // A multi-valued property claiming a billion values.
  const manyValues = tnef(attr(2, 0x00069005, cat(u32(1), u32(((0x3707 << 16) | PT_UNICODE | 0x1000) >>> 0), u32(0x40000000))));
  ok(Array.isArray(parseTnef(manyValues).files), "valeurs multiples absurdes : pas de levée");

  // A named property with an absurd name length.
  const named = tnef(attr(2, 0x00069005, cat(u32(1), u32((0x8000 << 16) | PT_UNICODE), new Uint8Array(16), u32(1), u32(0xffffffff))));
  ok(Array.isArray(parseTnef(named).files), "nom de propriété absurde : pas de levée");

  // More files than the limit: only the limit is kept.
  const flood = tnef(...Array.from({ length: TNEF_LIMITS.files + 50 }, (_, i) => file({ long: `f${i}.txt`, data: hello })));
  eq(parseTnef(flood).files.length, TNEF_LIMITS.files, "le nombre de fichiers est borné");

  // A very long name is cut.
  const long = parseTnef(tnef(file({ long: "a".repeat(5000) + ".txt", data: hello })));
  ok(long.files[0].name.length <= TNEF_LIMITS.name, "nom borné");

  // A declared type that is not a type is ignored.
  const odd = parseTnef(tnef(file({ long: "x.bin", mime: "text/html; <script>", data: hello })));
  eq(odd.files[0].type, "application/octet-stream", "un type mal formé est écarté");
}

console.log("\n-- tnef : ce qui n'en est pas ---------");
{
  for (const [label, b] of [
    ["vide", new Uint8Array(0)],
    ["texte", enc.encode("just some text, definitely not TNEF")],
    ["signature seule", cat(u32(0x223e9f78))],
    ["zéros", new Uint8Array(500)],
  ]) {
    const r = parseTnef(b);
    eq([r.files.length, r.text], [0, ""], `${label} : ni fichier ni texte`);
  }
  ok(!isTnef(enc.encode("PK\u0003\u0004 nope")), "un zip n'est pas du TNEF");
  eq(parseTnef("not bytes").files.length, 0, "autre chose que des octets : pas de levée");

  // A payload that merely contains the signature later on does not count.
  eq(parseTnef(cat(new Uint8Array(8), sample)).files.length, 0, "signature qui n'est pas au début");
}

console.log("\n-- tnef : dans un message ---------");
{
  const wrapped = (parts, extra = "") =>
    [
      "From: a@example.com",
      "To: b@example.com",
      "Subject: Rapport",
      'Content-Type: multipart/mixed; boundary="B"',
      "",
      "--B",
      ...parts,
      "--B--",
      "",
    ]
      .join("\r\n")
      .concat(extra);
  const b64 = (b) => b64encode(b).replace(/(.{76})/g, "$1\r\n");
  const winmail = [
    'Content-Type: application/ms-tnef; name="winmail.dat"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="winmail.dat"',
    "",
    b64(sample),
  ];

  const m = parseMessage(wrapped(winmail));
  eq(m.attachments.map((a) => a.filename), ["winmail.dat", "Quarterly report.txt", "scan.pdf"], "le winmail.dat puis les fichiers qu'il contient");
  eq(m.attachments.slice(1).map((a) => a.tnef), [0, 1], "chaque fichier sait sa place dans le conteneur");
  ok(m.attachments.slice(1).every((a) => a.part === m.attachments[0].part), "même partie IMAP que le conteneur");
  eq(m.attachments[2].size, pdf.length, "la taille d'un fichier intérieur est sa taille réelle");
  eq(m.text.trim(), "The body text.", "sans texte propre, le texte intérieur devient le message");

  // A message that has its own text keeps it.
  const own = parseMessage(wrapped(["Content-Type: text/plain", "", "Mon propre texte", "--B", ...winmail]));
  eq(own.text.trim(), "Mon propre texte", "le texte du message l'emporte");

  // A winmail.dat that is not TNEF is just a file.
  const fake = parseMessage(wrapped(['Content-Type: application/octet-stream; name="winmail.dat"', "Content-Transfer-Encoding: base64", "", b64(enc.encode("nothing here"))]));
  eq(fake.attachments.map((a) => a.filename), ["winmail.dat"], "un winmail.dat qui n'en est pas un reste un fichier");
}
