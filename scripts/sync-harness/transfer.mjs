/**
 * The import route (src/transfer.js) through the real Worker, against the
 * fake IMAP server: what is appended and with what, what shows locally, what
 * the next sync does with it, and what a second import does. Run from run.mjs
 * in each IMAP mode, with its helpers. Every message is invented.
 */
export async function checkTransfer({ ok, eq, env, imap, DB, MAIL, handleApi, pass1 }) {
  const BS = "\x5c";
  const call = async (method, path, body, headers = {}) => {
    const res = await handleApi(
      new Request("http://x" + path, { method, headers, body }),
      env,
      path.split("?")[0],
      { waitUntil() {} },
      { sub: "harness" }
    );
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const post = (folder, bytes, extra = "", headers) =>
    call("POST", `/api/transfer/import?folder=${encodeURIComponent(folder)}${extra}`, bytes, headers);
  const appends = () => imap.log.filter((l) => l.startsWith("APPEND")).length;
  const rowOf = (mid) => DB.raw.prepare("SELECT * FROM messages WHERE mid=?").get(mid);
  const text = (m) => Buffer.from(m.raw, "latin1");

  // ── one message, into a folder that does not exist yet ──
  const old = Buffer.from(
    "From: Zoé <zoe@x.fr>\r\nTo: me@example.com\r\nSubject: Souvenir de 2019\r\nDate: Tue, 05 Mar 2019 09:30:00 +0000\r\nMessage-ID: <imp1@x>\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nUn été à 20 € — “bien”\r\n",
    "utf8"
  );
  const before = appends();
  const first = await post("Imported", old, "&flags=flagged,seen,bogus&date=1");
  eq([first.status, first.body.ok, first.body.duplicate, first.body.local], [200, true, false, true], "the import is accepted and shown locally");
  const box = imap.boxes.get("Imported");
  ok(box && box.msgs.length === 1, "the missing folder was created at the server and the message is in it");
  eq(appends() - before, 1, "one APPEND was issued");
  const at = box?.msgs[0];
  ok(at && Buffer.compare(text(at), old) === 0, "the server holds the message byte for byte, 8-bit body included");
  eq([...(at?.flags || [])].sort(), [BS + "Flagged", BS + "Seen"], "with the flags asked for, and an unknown flag name ignored");
  eq(at?.internalDate, "05-Mar-2019 09:30:00 +0000", "and the date of the message as its internal date, taken from its Date header over the one passed");
  ok(imap.log.some((l) => /^APPEND "Imported" \(.*\) "05-Mar-2019 09:30:00 \+0000"$/.test(l) || l === 'APPEND "Imported"'), "the command was APPEND with flags, a date-time and the literal");

  const local = rowOf("<imp1@x>");
  eq([local?.folder, local?.unread, local?.starred, local?.subject], ["Imported", 0, 1, "Souvenir de 2019"], "it is in the folder locally, read and starred, before any sync");
  eq(local?.date, Date.UTC(2019, 2, 5, 9, 30), "with its own date");
  ok(MAIL.map.has(`body/${local?.id}.json`) && JSON.parse(MAIL.map.get(`body/${local.id}.json`)).html.includes("20 € — “bien”"), "and its body is stored, with the 8-bit text intact");
  const listed = await call("GET", "/api/messages?folder=Imported");
  eq(listed.body?.messages?.map((m) => m.subject), ["Souvenir de 2019"], "the folder lists it");

  // ── the sync that follows finds the same message, and does not double it ──
  const total = DB.raw.prepare("SELECT COUNT(*) n FROM messages").get().n;
  for (let i = 0; i < 3; i++) await pass1("after import " + i);
  eq(DB.raw.prepare("SELECT COUNT(*) n FROM messages WHERE mid='<imp1@x>'").get().n, 1, "after the sync it is still one row");
  eq(DB.raw.prepare("SELECT COUNT(*) n FROM messages").get().n, total, "and the sync added nothing else");
  const synced = rowOf("<imp1@x>");
  eq([synced?.id, synced?.mailbox, synced?.uid, synced?.folder], [local?.id, "Imported", at?.uid, "Imported"], "the row kept its id and was given the server's folder and UID");
  eq([synced?.unread, synced?.starred], [0, 1], "and its flags");

  // ── the same message again ──
  const n = appends();
  const again = await post("Imported", old);
  eq([again.status, again.body.ok, again.body.duplicate], [200, true, true], "importing it again is a duplicate");
  eq(appends(), n, "and appends nothing");
  // A probe asks without a body, and appends nothing either way.
  const probe = (mid) => call("POST", `/api/transfer/import?folder=Imported&probe=${encodeURIComponent(mid)}`);
  eq([(await probe("<imp1@x>")).body.duplicate, (await probe("<never-seen@x>")).body.duplicate, appends()], [true, false, n], "a probe says whether a message is known, and appends nothing");
  // The row not stored (the append went through and the request died before
  // the insert): the server has it, so a rerun is still a duplicate, and the
  // sync that has not yet seen it brings the row in.
  const second = Buffer.from(old.toString('utf8').replace('<imp1@x>', '<imp2@x>').replace('Souvenir de 2019', 'Deuxieme souvenir'), 'utf8');
  eq((await post('Imported', second)).body.duplicate, false, 'a second message is appended');
  DB.raw.prepare("DELETE FROM messages WHERE mid='<imp2@x>'").run();
  const n1 = appends();
  const lost = await post('Imported', second);
  eq([lost.body.duplicate, appends()], [true, n1], 'a duplicate is found at the server too when the local row is missing');
  await pass1('restore');
  eq(DB.raw.prepare("SELECT COUNT(*) n FROM messages WHERE mid='<imp2@x>'").get().n, 1, 'and the sync brings the row in, once');
  eq((await post("Archive", old)).body.duplicate, true, "a message already anywhere in the account is a duplicate for another folder too");

  // ── a Unix file's message, with no Message-ID ──
  const bare = Buffer.from("From: Max <max@x.fr>\nSubject: Sans identifiant\nDate: Mon, 01 Apr 2019 08:00:00 +0000\n\nligne un\nligne deux\n", "utf8");
  const made = await post("Imported", bare);
  eq([made.status, made.body.duplicate], [200, false], "a message with no Message-ID is taken");
  const stored = imap.boxes.get("Imported").msgs.find((m) => /Sans identifiant/.test(m.raw));
  ok(stored && /^Message-ID: <[0-9a-f]{32}@import\.invalid>\r\n/.test(stored.raw), "it is given a Message-ID derived from its bytes");
  ok(!/[^\r]\n/.test(stored?.raw || "x"), "and its lines end CRLF, not bare LF");
  const n2 = appends();
  eq((await post("Imported", bare)).body.duplicate, true, "importing it again finds it by that identifier");
  eq(appends(), n2, "and appends nothing");

  // ── refused, never thrown, nothing appended ──
  const n3 = appends();
  const refusals = [
    ["an empty body", await post("Imported", new Uint8Array(0)), 400, "empty"],
    ["blank bytes", await post("Imported", Buffer.from("  \r\n\r\n")), 400, "empty"],
    ["a file that is not a message", await post("Imported", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])), 400, "not-a-message"],
    ["plain prose", await post("Imported", Buffer.from("Hello there, this is just a note.\n")), 400, "not-a-message"],
    ["no folder", await call("POST", "/api/transfer/import", old), 400, "no-folder"],
    ["a folder name with a quote", await post('Bad"name', old), 400, "bad-folder"],
    ["a message over the limit", await post("Imported", old, "", { "Content-Length": String(26 * 1024 * 1024) }), 413, "too-large"],
  ];
  for (const [label, r, status, reason] of refusals) eq([label, r.status, r.body?.ok, r.body?.reason], [label, status, false, reason], `${label} is refused with a reason`);
  eq(appends(), n3, "none of them appended anything");

  // ── the ids export asks for ──
  const ids = await call("GET", "/api/transfer/ids?folder=Imported");
  eq(ids.body.ids.length, 3, "the ids route lists the folder");
  eq(ids.body.total, 3, "with its total on the first page");
  const sortedDates = ids.body.ids.map((i) => i.date);
  eq(sortedDates, [...sortedDates].sort((a, b) => a - b), "oldest first");
  const page1 = await call('GET', '/api/transfer/ids?folder=Imported&limit=2');
  ok(page1.body.next && page1.body.ids.length === 2, 'a page that is full says where the next one starts');
  const page2 = await call("GET", `/api/transfer/ids?folder=Imported&limit=2&after=${page1.body.next}`);
  eq([page2.body.ids.length, page2.body.next, page1.body.ids.some((i) => i.id === page2.body.ids[0]?.id)], [1, null, false], 'and the next page is the rest, with nothing twice');
}
