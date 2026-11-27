/**
 * What the Chrome extension's push-only token can read, through the real
 * Worker entry point and its session check (src/index.js, src/auth.js), side
 * by side with a full session's cookie.
 *
 * The token may call GET /api/push/state and nothing else. It sits in
 * extension storage, so it is meant to cost a badge number if it leaks: the
 * unread count and the newest sender and subject, which is what it read
 * before reminders existed, and no reminder text.
 */
import { register } from "node:module";
import { eq, ok } from "./harness.mjs";

register("../scripts/sync-harness/hooks.mjs", import.meta.url);
const { makeD1 } = await import("../scripts/sync-harness/fake.mjs");
const { SCHEMA } = await import("../src/schema.js");
const { default: worker } = await import("../src/index.js");
const { issueSession, PUSH_SCOPE } = await import("../src/auth.js");
const { setReminder, fireDue } = await import("../src/reminders.js");

const DB = makeD1();
for (const s of SCHEMA) DB.raw.exec(s);
const env = { DB, AUTH_SECRET: "test-secret-not-a-real-one", ENC_KEY: "x", APP_URL: "http://x" };
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(null, { status: 201 }); // the ring fireDue sends

try {
  DB.raw.prepare("INSERT INTO messages (id, account_id, pid, folder, from_email, from_name, thread_key, subject, to_line, date, unread, created_at) VALUES ('00000000000000a1','a1','<p@x>','inbox','zoe@x.example','Zoe','t','Lunch?','me@x.example',?,1,0)").run(Date.now());
  await setReminder(env, { kind: "event", ref: "e1", title: "Appointment at the clinic", body: "12 Rue Neuve", at: Date.now() - 1000 });
  await setReminder(env, { kind: "followup", ref: "f1", title: "No reply yet: Offer", body: "Nobody has replied to your message to camille@x.example", at: Date.now() - 1000 });
  await fireDue(env);

  // X-Client as the extension sends it, so the stale-client log stays quiet.
  const ask = (headers) => worker.fetch(new Request("http://x/api/push/state", { headers: { "X-Client": "ext-test", ...headers } }), env, { waitUntil() {} });
  const full = await ask({ Cookie: `dmzs_session=${await issueSession(env.AUTH_SECRET, { name: "Phone" })}` });
  const push = await ask({ "X-Session": await issueSession(env.AUTH_SECRET, { scope: PUSH_SCOPE }) });
  const fb = await full.json();
  const pb = await push.json();

  eq([full.status, push.status], [200, 200], "both a full session and the push-only token may read the push state");
  eq(fb.reminders.map((r) => r.title).sort(), ["Appointment at the clinic", "No reply yet: Offer"], "a full session gets the reminders that just fired");
  eq(Object.keys(pb).sort(), ["from", "subject", "total", "unread"], "the push-only token gets the badge it was made for and nothing more");
  eq([pb.unread, pb.from, pb.subject], [1, "Zoe", "Lunch?"], "the same badge a full session gets");
  ok(!JSON.stringify(pb).includes("clinic") && !JSON.stringify(pb).includes("camille@"), "and no reminder text or address");

  const other = await worker.fetch(new Request("http://x/api/reminders", { headers: { "X-Session": await issueSession(env.AUTH_SECRET, { scope: PUSH_SCOPE }) } }), env, { waitUntil() {} });
  eq(other.status, 401, "nor can it read the reminders anywhere else");
} finally {
  globalThis.fetch = realFetch;
}
