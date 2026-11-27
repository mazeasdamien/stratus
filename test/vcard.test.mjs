/**
 * The vCard parser and writer (src/vcard.js), by what comes out of files shaped
 * like the ones real programs write. Every person here is invented.
 */
import { eq, ok } from "./harness.mjs";
import { cleanContact, parseVcard, writeCard, writeVcard } from "../src/vcard.js";

const crlf = (s) => s.replace(/\n/g, "\r\n");
const bytes = (s) => new TextEncoder().encode(s);

// ── Apple Contacts: 3.0, grouped properties, a photo, Apple's custom labels ──
const apple = crlf(`BEGIN:VCARD
VERSION:3.0
PRODID:-//Apple Inc.//iOS 17.5//EN
N:Fontaine;Élodie;Marie;Dr.;
FN:Dr. Élodie Fontaine
ORG:Atelier Fontaine;Design
TITLE:Directrice
item1.EMAIL;type=INTERNET;type=pref:elodie@atelier-fontaine.example
item2.EMAIL;type=INTERNET:e.fontaine@perso.example
item2.X-ABLabel:_$!<Other>!$_
TEL;type=CELL;type=VOICE;type=pref:+33 6 12 34 56 78
item3.TEL:+33 1 23 45 67 89
item3.X-ABLabel:Standard
item4.ADR;type=WORK;type=pref:;;12 rue des Lilas;Lyon;;69003;France
item4.X-ABADR:fr
BDAY:1984-03-09
NOTE:Rencontrée au salon.\\nÀ rappeler en mai\\, avant le 10.
UID:A1B2C3D4-0000-4000-8000-0123456789AB
PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoH
 BwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQU
END:VCARD
`);
{
  const r = parseVcard(apple);
  eq([r.contacts.length, r.empty, r.tooMany], [1, 0, false], "Apple: one card, nothing dropped");
  const c = r.contacts[0];
  eq([c.name, c.given, c.family], ["Dr. Élodie Fontaine", "Élodie", "Fontaine"], "Apple: the display name is FN, the parts are N");
  eq([c.org, c.title], ["Atelier Fontaine, Design", "Directrice"], "Apple: organisation and title");
  eq(c.emails, [{ type: "", value: "elodie@atelier-fontaine.example" }, { type: "other", value: "e.fontaine@perso.example" }], "Apple: INTERNET and pref are not types, and the group's X-ABLabel names the second address");
  eq(c.phones, [{ type: "cell", value: "+33 6 12 34 56 78" }, { type: "standard", value: "+33 1 23 45 67 89" }], "Apple: a type, and a custom label from the group");
  eq(c.address, "12 rue des Lilas\n69003 Lyon\nFrance", "Apple: the address as lines");
  eq(c.birthday, "1984-03-09", "Apple: birthday");
  eq(c.notes, "Rencontrée au salon.\nÀ rappeler en mai, avant le 10.", "Apple: \\n is a line break and \\, a comma");
  eq(c.uid, "A1B2C3D4-0000-4000-8000-0123456789AB", "Apple: UID kept");
  ok(!JSON.stringify(c).includes("/9j/"), "Apple: the photo is read past, not kept");
}

// ── Google: 3.0, quoted TYPE lists, escaped commas, two cards ──
const google = crlf(`BEGIN:VCARD
VERSION:3.0
FN:Samir Haddad
N:Haddad;Samir;;;
EMAIL;TYPE=INTERNET,HOME:Samir.Haddad@Mail.Example
EMAIL;TYPE=INTERNET,WORK:samir@haddad-conseil.example
TEL;TYPE=WORK:+44 20 7946 0000
TEL;TYPE=CELL:07700 900123
ADR;TYPE=HOME:;;4 Quay Street\\, Flat 2;Bristol;;BS1 4AA;United Kingdom
ORG:Haddad Conseil;
BDAY:19900214
END:VCARD
BEGIN:VCARD
VERSION:3.0
FN:Priya Raman
EMAIL;TYPE=INTERNET:priya@raman.example
END:VCARD
`);
{
  const r = parseVcard(google);
  eq(r.contacts.map((c) => c.name), ["Samir Haddad", "Priya Raman"], "Google: two cards in one file");
  const c = r.contacts[0];
  eq(c.emails, [{ type: "home", value: "samir.haddad@mail.example" }, { type: "work", value: "samir@haddad-conseil.example" }], "Google: TYPE=INTERNET,HOME is one list; addresses are lower-cased");
  eq(c.phones.map((p) => p.type), ["work", "cell"], "Google: phone types");
  eq(c.address, "4 Quay Street, Flat 2\nBS1 4AA Bristol\nUnited Kingdom", "Google: an escaped comma stays inside the street");
  eq([c.org, c.birthday], ["Haddad Conseil", "1990-02-14"], "Google: a trailing empty ORG component is dropped, and a compact birthday is normalised");
}

// ── Outlook: 2.1, bare types, quoted-printable in Windows-1252, soft breaks ──
const outlook = crlf(`BEGIN:VCARD
VERSION:2.1
N;CHARSET=Windows-1252;ENCODING=QUOTED-PRINTABLE:Gu=E9rin;Ren=E9e;;;
FN;CHARSET=Windows-1252;ENCODING=QUOTED-PRINTABLE:Ren=E9e Gu=E9rin
ORG;CHARSET=Windows-1252;ENCODING=QUOTED-PRINTABLE:Soci=E9t=E9 G=E9n=E9rale
TEL;WORK;VOICE:+33 4 00 00 00 00
TEL;CELL:+33 6 00 00 00 00
EMAIL;PREF;INTERNET:renee.guerin@societe.example
ADR;WORK;CHARSET=Windows-1252;ENCODING=QUOTED-PRINTABLE:;;3 all=E9e des Ch=EAnes;Nantes;;44000;France
NOTE;CHARSET=Windows-1252;ENCODING=QUOTED-PRINTABLE:Premi=E8re ligne=0D=0ADeuxi=E8me =
ligne
END:VCARD
`);
{
  const r = parseVcard(outlook);
  const c = r.contacts[0];
  eq([c.name, c.given, c.family, c.org], ["Renée Guérin", "Renée", "Guérin", "Société Générale"], "Outlook 2.1: quoted-printable in Windows-1252 decodes to the right letters");
  eq(c.phones, [{ type: "work", value: "+33 4 00 00 00 00" }, { type: "cell", value: "+33 6 00 00 00 00" }], "Outlook 2.1: bare TYPE words");
  eq(c.emails, [{ type: "", value: "renee.guerin@societe.example" }], "Outlook 2.1: PREF;INTERNET are not a type");
  eq(c.address, "3 allée des Chênes\n44000 Nantes\nFrance", "Outlook 2.1: quoted-printable address");
  eq(c.notes, "Première ligne\nDeuxième ligne", "Outlook 2.1: =0D=0A is a line break and a trailing = joins the next line");
}

// The same card with raw Windows-1252 bytes and no encoding at all.
{
  const latin1 = Uint8Array.from([...`BEGIN:VCARD\r\nVERSION:2.1\r\nFN:Ren`].map((ch) => ch.charCodeAt(0)).concat([0xe9], [...`e Gu`].map((ch) => ch.charCodeAt(0)), [0xe9], [...`rin\r\nEND:VCARD\r\n`].map((ch) => ch.charCodeAt(0))));
  eq(parseVcard(latin1).contacts[0].name, "Renée Guérin", "bytes that are not UTF-8 are read as Windows-1252");
  eq(parseVcard(bytes(apple)).contacts[0].family, "Fontaine", "bytes that are UTF-8 are read as UTF-8");
  eq(parseVcard(Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes(google)])).contacts.length, 2, "a UTF-8 byte order mark is ignored");
  const u16 = new Uint8Array([0xff, 0xfe, ...[...("BEGIN:VCARD\nFN:Ana Lima\nEND:VCARD\n")].flatMap((ch) => [ch.charCodeAt(0), 0])]);
  eq(parseVcard(u16).contacts[0].name, "Ana Lima", "UTF-16 with a byte order mark");
}

// ── 4.0: a tel: URI, a mailto:, a birthday with no year ──
{
  const v4 = crlf(`BEGIN:VCARD
VERSION:4.0
FN:Jonas Berg
TEL;VALUE=uri;TYPE="cell,voice":tel:+46-70-000-0000
EMAIL;TYPE=work:mailto:jonas@berg.example
BDAY:--0412
UID:urn:uuid:11111111-2222-4333-8444-555555555555
END:VCARD
`);
  const c = parseVcard(v4).contacts[0];
  eq([c.phones[0], c.emails[0].value, c.birthday, c.uid], [{ type: "cell", value: "+46-70-000-0000" }, "jonas@berg.example", "--04-12", "urn:uuid:11111111-2222-4333-8444-555555555555"], "4.0: tel: and mailto: prefixes go, a year-less birthday stays, the UID is kept whole");
}

// ── folded lines ──
{
  const folded = crlf(`BEGIN:VCARD
VERSION:3.0
FN:Nadia Okafor
NOTE:This note is long enough that the program writing it had to fold it onto
  a second line, and then a third line that carries on from there without any
  gap in the middle.
EMAIL:nadia.okafor
 @long-domain-name.example
END:VCARD
`);
  const c = parseVcard(folded).contacts[0];
  eq(c.notes, "This note is long enough that the program writing it had to fold it onto a second line, and then a third line that carries on from there without any gap in the middle.", "folded lines are unfolded, dropping the one fold space");
  eq(c.emails[0].value, "nadia.okafor@long-domain-name.example", "an address folded in the middle is whole again");
}

// ── escapes ──
{
  const c = parseVcard("BEGIN:VCARD\nFN:Tom \\\\ Jerry\\; Inc\nORG:Tom\\, Jerry\nNOTE:5\" pipe; no quotes problem\nEND:VCARD").contacts[0];
  eq([c.name, c.org, c.notes], ["Tom \\ Jerry; Inc", "Tom, Jerry", "5\" pipe; no quotes problem"], "escaped backslash, semicolon and comma; a bare quote mark is text");
}

// ── a card with no name ──
{
  const r = parseVcard("BEGIN:VCARD\nVERSION:3.0\nEMAIL:anon@nowhere.example\nTEL:+1 555 0100\nEND:VCARD\nBEGIN:VCARD\nVERSION:3.0\nORG:Boulangerie Dupuis\nEND:VCARD\n");
  eq(r.contacts.map((c) => [c.name, c.org, c.emails.length, c.phones.length]), [["", "", 1, 1], ["", "Boulangerie Dupuis", 0, 0]], "a card with no name is kept for its address, a company for its name");
  const none = parseVcard("BEGIN:VCARD\nVERSION:3.0\nPHOTO;ENCODING=b:AAAA\nURL:https://example.test\nEND:VCARD\n");
  eq([none.contacts.length, none.empty], [0, 1], "a card holding nothing we keep is counted, not imported");
}

// ── nothing, garbage, damage ──
eq(parseVcard(""), { contacts: [], empty: 0, tooMany: false }, "an empty file");
eq(parseVcard(new Uint8Array(0)).contacts, [], "an empty byte array");
eq(parseVcard("just some text\nthat is not a card").contacts, [], "text that is not a card");
eq(parseVcard(bytes("a,b,c\n1,2,3\n")).contacts, [], "a CSV");
{
  const noise = new Uint8Array(4096).map((_, i) => (i * 131 + 7) & 0xff);
  let threw = false;
  try { parseVcard(noise); parseVcard(null); parseVcard(undefined); } catch { threw = true; }
  ok(!threw, "binary noise, null and undefined never throw");
  eq(parseVcard("BEGIN:VCARD\nFN:No End\nEMAIL:x@y.example").contacts.length, 1, "a card cut off before END:VCARD still counts");
  eq(parseVcard("BEGIN:VCARD\nFN:Half\nBEGIN:VCARD\nFN:Whole\nEND:VCARD").contacts.map((c) => c.name), ["Half", "Whole"], "a BEGIN inside a card starts the next one");
  eq(parseVcard('BEGIN:VCARD\nFN:Quote\nX-ODD;LABEL="unclosed:thing\nEMAIL:q@x.example\nEND:VCARD').contacts[0].emails.length, 1, "an odd line is skipped without taking the card");
}

// ── caps ──
{
  const many = Array.from({ length: 12 }, (_, i) => `BEGIN:VCARD\nFN:P${i}\nEND:VCARD\n`).join("");
  const r = parseVcard(many, { maxCards: 10 });
  eq([r.tooMany, r.contacts.length < 12], [true, true], "more cards than the cap stops the read and says so");
  const big = parseVcard(`BEGIN:VCARD\nFN:${"x".repeat(5000)}\nNOTE:${"n".repeat(20000)}\n${Array.from({ length: 60 }, (_, i) => `EMAIL:a${i}@b.example`).join("\n")}\nEND:VCARD`).contacts[0];
  eq([big.name.length, big.notes.length, big.emails.length], [200, 5000, 20], "name, note and the address list are capped");
}

// ── writing ──
{
  const c = {
    uid: "uid-1", name: "Élodie Fontaine", given: "Élodie", family: "Fontaine", org: "Atelier, Fontaine; Design", title: "Directrice",
    emails: [{ type: "work", value: "elodie@atelier.example" }, { type: "", value: "e@perso.example" }],
    phones: [{ type: "cell", value: "+33 6 12 34 56 78" }],
    address: "12 rue des Lilas\n69003 Lyon", birthday: "1984-03-09", notes: "Line one\nLine two, with a comma; and a semicolon \\ and a backslash.",
  };
  const text = writeCard(c);
  ok(text.startsWith("BEGIN:VCARD\r\nVERSION:3.0\r\n") && text.endsWith("END:VCARD\r\n"), "a card is 3.0 with CRLF line ends");
  ok(text.includes("EMAIL;TYPE=INTERNET,WORK:elodie@atelier.example\r\n") && text.includes("TEL;TYPE=CELL:+33 6 12 34 56 78\r\n"), "types are written as TYPE parameters");
  ok(text.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75), "no line is longer than 75 octets");
  eq(parseVcard(text).contacts[0], c, "write then read gives the same contact back");

  const long = { ...c, notes: "é".repeat(200) + " " + "word ".repeat(40) };
  const folded = writeCard(long);
  ok(folded.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75) && folded.includes("\r\n "), "a long note is folded, and never inside a two-byte letter");
  eq(parseVcard(folded).contacts[0].notes, cleanContact(long).notes, "and reads back whole");

  const nameless = { uid: "", name: "", given: "", family: "", org: "", title: "", emails: [{ type: "", value: "a@b.example" }], phones: [], address: "", birthday: "", notes: "" };
  ok(writeCard(nameless).includes("FN:a@b.example"), "a card with no name is still given the FN that 3.0 requires");
  eq(writeVcard([c, c]).split("BEGIN:VCARD").length - 1, 2, "several contacts are several cards in one file");
  eq(parseVcard(writeVcard([c, { ...c, uid: "uid-2", name: "Samir Haddad", given: "Samir", family: "Haddad" }])).contacts.map((x) => x.uid), ["uid-1", "uid-2"], "a whole file round-trips");
}
