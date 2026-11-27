/**
 * Demo-only: the address book's routes for scripts/demo-server.mjs, over an
 * in-memory list of invented people. Not part of the deployed app, and not the
 * real routes (src/contacts.js): just enough for the People view to be shot.
 */

const person = (id, name, given, family, org, title, emails, phones, address = "", birthday = "", notes = "") => ({
  id, uid: `demo-${id}`, name, given, family, org, title,
  emails: emails.map(([type, value]) => ({ type, value })),
  phones: phones.map(([type, value]) => ({ type, value })),
  address, birthday, notes, created_at: 1, updated_at: 1,
});

const book = [
  person("0000000000000001", "Camille Roux", "Camille", "Roux", "Atelier Roux", "Directrice", [["work", "camille@atelier-roux.example"], ["home", "c.roux@perso.example"]], [["cell", "+33 6 00 00 00 01"], ["work", "+33 4 00 00 00 02"]], "12 rue des Lilas\n69003 Lyon\nFrance", "1984-03-09", "Met at the Lyon fair.\nPrefers mail to calls."),
  person("0000000000000002", "Léa Martin", "Léa", "Martin", "Studio Martin", "Designer", [["work", "lea@studio-martin.example"]], [["cell", "+33 6 00 00 00 03"]], "", "--04-12"),
  person("0000000000000003", "Samir Haddad", "Samir", "Haddad", "", "", [["", "samir@haddad.example"]], []),
  person("0000000000000004", "Priya Raman", "Priya", "Raman", "Raman & Co", "Accountant", [["work", "priya@raman.example"]], [["work", "+44 20 7946 0000"]]),
  person("0000000000000005", "Jonas Berg", "Jonas", "Berg", "Berg Bakery", "", [["", "jonas@berg.example"]], [["cell", "+46 70 000 00 00"]]),
  person("0000000000000006", "Nadia Okafor", "Nadia", "Okafor", "", "", [["home", "nadia.okafor@mail.example"]], []),
  person("0000000000000007", "", "", "", "Boulangerie Dupuis", "", [["work", "contact@dupuis.example"]], [["work", "+33 2 00 00 00 04"]]),
  person("0000000000000008", "Élodie Fontaine", "Élodie", "Fontaine", "Atelier Fontaine", "Architect", [["work", "elodie@atelier-fontaine.example"]], []),
  person("0000000000000009", "Tom Hale", "Tom", "Hale", "", "", [["", "tom@hale.example"]], []),
];

const send = (res, data, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json", "X-Shell": "v78" });
  res.end(JSON.stringify(data));
};

const body = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

/** True when the request was answered. */
export async function demoContacts(req, res, p) {
  if (!p.startsWith("/api/contacts")) return false;
  if (p === "/api/contacts/suggest") return send(res, { contacts: book.flatMap((c) => c.emails.map((e) => ({ email: e.value, name: c.name, n: 0, added: 1 }))) }), true;
  if (p === "/api/contacts/import") {
    await body(req);
    return send(res, { ok: true, found: 6, added: 3, updated: 1, skipped: 2 }), true;
  }
  if (p === "/api/contacts/export" || /\/export$/.test(p)) {
    res.writeHead(200, { "Content-Type": "text/vcard", "Content-Disposition": 'attachment; filename="demo.vcf"' });
    res.end("BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Demo\r\nEND:VCARD\r\n");
    return true;
  }
  const one = p.match(/^\/api\/contacts\/([a-f0-9]{16})$/);
  const data = JSON.parse((await body(req)).toString() || "{}");
  if (req.method === "GET") return send(res, { contacts: book }), true;
  if (req.method === "POST") {
    const c = { ...data, id: String(Date.now()).padStart(16, "0"), uid: "demo-new", created_at: 1, updated_at: 1 };
    book.push(c);
    return send(res, { ok: true, contact: c }), true;
  }
  const at = one ? book.findIndex((c) => c.id === one[1]) : -1;
  if (req.method === "PUT" && at >= 0) {
    book[at] = { ...book[at], ...data };
    return send(res, { ok: true, contact: book[at] }), true;
  }
  if (req.method === "DELETE" && at >= 0) book.splice(at, 1);
  return send(res, { ok: true }), true;
}
