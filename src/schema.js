/**
 * The database, described once.
 *
 * schema.sql used to be the only description, and runtime `ensureSchema` had a
 * second, partial one beside it — the columns an older database might be
 * missing. The two drifted: a column added to one was not in the other, and
 * `npm run db:schema` on a fresh install then produced a different database
 * than the Worker healed an old one into.
 *
 * This file is the source. `scripts/gen-schema.mjs` writes schema.sql from it
 * and refuses to deploy if the written copy has been hand-edited since. The
 * Worker's `ensureSchema` reads the same structures, so healing an old
 * database and creating a new one can no longer disagree.
 *
 * The `jobs` table, for the Python agent that used to drive iCloud from a
 * machine at home, is deliberately not here. A pre-existing one is left
 * untouched — same reasoning as the old `labels` column: nothing reads or
 * writes it now, and dropping a table on a live mailbox is not worth the
 * risk of tidiness.
 */

/** DDL for a database that does not exist yet. Idempotent throughout. */
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,             -- 8 hex chars, hash of provider+email
  provider    TEXT NOT NULL,                -- icloud
  email       TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',     -- display name, defaults to email
  secret      TEXT,                         -- AES-GCM sealed app password
  sync_state  TEXT,                         -- per-mailbox UID cursors, JSON
  status      TEXT NOT NULL DEFAULT 'ok',   -- ok | reauth | error
  last_sync   INTEGER,                      -- ms
  last_error  TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE (provider, email)
)`,
  `CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,             -- 16 hex chars, hash of account+pid
  account_id  TEXT NOT NULL,
  pid         TEXT NOT NULL,                -- stable id: the RFC Message-ID where there is one
  mid         TEXT NOT NULL DEFAULT '',     -- RFC Message-ID, for reply threading
  -- First References id, else In-Reply-To, else the message's own id — so a
  -- root and its replies share one key. The subject only for mail with no ids.
  thread_key  TEXT NOT NULL DEFAULT '',
  refs        TEXT NOT NULL DEFAULT '',     -- the References chain, for replying to this
  -- The one bucket a message is filed under, for the folder switcher:
  -- inbox | archive | sent | spam | trash | drafts, or an IMAP folder name.
  folder      TEXT NOT NULL DEFAULT 'inbox',
  from_name   TEXT NOT NULL DEFAULT '',
  from_email  TEXT NOT NULL DEFAULT '',
  to_line     TEXT NOT NULL DEFAULT '',     -- human-readable recipients
  cc_line     TEXT NOT NULL DEFAULT '',     -- copied recipients; reply-all needs them
  -- Blind recipients. Never present on mail you receive, and deliberately
  -- absent from the bytes of anything sent — a Bcc written into the message
  -- is not blind. Kept here for the two copies that are only ever yours: the
  -- draft you are still writing, and your own record of what you sent.
  bcc_line    TEXT NOT NULL DEFAULT '',
  subject     TEXT NOT NULL DEFAULT '',
  snippet     TEXT NOT NULL DEFAULT '',
  date        INTEGER NOT NULL DEFAULT 0,   -- ms
  unread      INTEGER NOT NULL DEFAULT 1,
  starred     INTEGER NOT NULL DEFAULT 0,   -- IMAP \\Flagged
  -- The colour you used to give it, 1 to 5. Nothing reads or writes it now:
  -- categories carry that (see the categories table), and the "colors_to_categories"
  -- migration moved every value across. The column stays because dropping one
  -- on a live mailbox is not worth the risk.
  color       INTEGER NOT NULL DEFAULT 0,
  -- 1 when the conversation is pinned to the top of its list. Set on every
  -- message of the conversation, but read as "any message of it": mail that
  -- arrives later in a pinned conversation is not pinned itself.
  pinned      INTEGER NOT NULL DEFAULT 0,
  -- How the sender marked it: 1 high, -1 low, 0 normal. Read from the
  -- Importance, X-Priority and X-MSMail-Priority headers when the message is
  -- stored; mail stored before this column existed stays 0.
  importance  INTEGER NOT NULL DEFAULT 0,
  has_body   INTEGER NOT NULL DEFAULT 0,   -- 1 once the defused body sits in R2
  -- File names of the attachments, one per line, for has:attachment and
  -- attachment:name. NULL is "not looked at yet", which is what every message
  -- stored before this column is; '' is "looked, there are none".
  att_names   TEXT,
  -- Where the provider has it: IMAP mailbox path and UID within it. What lets
  -- a sync notice a flag changed or a message expunged on another device.
  -- 0 and '' until a sync has seen the message there.
  mailbox     TEXT NOT NULL DEFAULT '',
  uid         INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  UNIQUE (account_id, pid)
)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_list    ON messages(folder, date DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id, folder, date DESC)`,
  // The list groups by thread_key on every load, and opening a conversation
  // filters on it. Both walk the whole table without this.
  `CREATE INDEX IF NOT EXISTS idx_messages_thread  ON messages(thread_key)`,
  // Unread only: the badge, the push and the inbox count ask about these few
  // every minute, and without it each question read the whole folder.
  `CREATE INDEX IF NOT EXISTS idx_messages_unread  ON messages(folder, date DESC) WHERE unread=1`,
  // Key/value, for the things that are per-install rather than per-account:
  // the VAPID pair the push subscriptions are signed with, and the last unread
  // count a notification was sent for.
  // Names you give to messages, several to one message. Here only, like the
  // colour they replace: iCloud has no such thing. `color` is an index into the
  // palette in the client and in src/categories.js, whose first five are the
  // five colours a message could carry before categories existed.
  `CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  color      INTEGER NOT NULL DEFAULT 0,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)`,
  // No foreign key: D1 does not cascade for us, so deleting a message or a
  // category cleans this by hand (forgetMessages in store.js, the delete route).
  // A rowid table, not WITHOUT ROWID: the nightly snapshot pages by rowid.
  `CREATE TABLE IF NOT EXISTS message_categories (
  message_id  TEXT NOT NULL,                -- messages.id
  category_id INTEGER NOT NULL,
  PRIMARY KEY (message_id, category_id)
)`,
  `CREATE INDEX IF NOT EXISTS idx_message_categories_cat ON message_categories(category_id)`,
  `CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS push_subs (
  endpoint   TEXT PRIMARY KEY,
  sub        TEXT NOT NULL,               -- the whole PushSubscription, JSON
  created_at INTEGER NOT NULL
)`,
  // Contacts are read out of sent mail rather than kept, so the only two things
  // worth storing are the corrections: someone you never want suggested, and
  // someone you have never written to but want anyway.
  `CREATE TABLE IF NOT EXISTS contacts_hidden (
  email      TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
)`,
  // No longer written: kept for a snapshot that holds rows from before the
  // address book, and moved into `contacts` by the contacts_book migration.
  `CREATE TABLE IF NOT EXISTS contacts_added (
  email      TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
)`,
  // The address book. One row per person, in the shape of a vCard so a card
  // can come in and go out without losing anything this app keeps. The lists
  // are JSON, [{ type, value }]: they are read whole and never queried by
  // field, and an address book is a few hundred rows, so matching an address
  // is done in code (src/contacts.js).
  `CREATE TABLE IF NOT EXISTS contacts (
  id         TEXT PRIMARY KEY,
  uid        TEXT NOT NULL,                 -- the vCard UID, what an import matches on first
  name       TEXT NOT NULL DEFAULT '',      -- the display name (FN)
  given      TEXT NOT NULL DEFAULT '',
  family     TEXT NOT NULL DEFAULT '',
  org        TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  emails     TEXT NOT NULL DEFAULT '[]',
  phones     TEXT NOT NULL DEFAULT '[]',
  address    TEXT NOT NULL DEFAULT '',
  birthday   TEXT NOT NULL DEFAULT '',      -- YYYY-MM-DD, or --MM-DD with no year
  notes      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_uid ON contacts(uid)`,
  // Senders whose mail is destroyed on sight.
  //
  // Not a folder and not a filter: a match is expunged at the provider during
  // the sync that finds it, so no row is ever written, no body reaches R2 and
  // no notification fires. `n` is the only trace kept — the rule is invisible
  // by design, and a rule that silently eats mail with no way to tell how much
  // is not one you can ever audit.
  // Messages written now and sent later. The message itself (attachments and
  // all, up to 20 MB) waits in R2 under outbox/<id>.json; this is the index
  // the cron reads every minute and the Scheduled sheet lists.
  `CREATE TABLE IF NOT EXISTS outbox (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  at          INTEGER NOT NULL,             -- ms, when it goes
  subject     TEXT NOT NULL DEFAULT '',
  to_line     TEXT NOT NULL DEFAULT '',
  tries       INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_outbox_at ON outbox(at)`,
  // Messages put away until later. The message itself waits in a Snoozed
  // mailbox at iCloud, so every device sees it gone; this row is what brings
  // it back to the inbox, unread, when its time comes.
  `CREATE TABLE IF NOT EXISTS snoozed (
  id          TEXT PRIMARY KEY,             -- messages.id
  account_id  TEXT NOT NULL,
  until       INTEGER NOT NULL,             -- ms
  folder      TEXT NOT NULL,                -- the app's name for the Snoozed mailbox
  created_at  INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_snoozed_until ON snoozed(until)`,
  `CREATE TABLE IF NOT EXISTS blocked_senders (
  pattern    TEXT PRIMARY KEY,             -- lowercase: a whole address, or a bare domain
  n          INTEGER NOT NULL DEFAULT 0,   -- messages destroyed by this rule
  last_at    INTEGER,                      -- ms, when it last matched
  created_at INTEGER NOT NULL
)`,
  // Rules that act on mail as it arrives (src/rules.js, src/sorting.js).
  // conditions and actions are JSON lists, read back defensively: a row from
  // another build may name a field or an action this one does not know.
  `CREATE TABLE IF NOT EXISTS rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL DEFAULT '',
  enabled    INTEGER NOT NULL DEFAULT 1,
  position   INTEGER NOT NULL DEFAULT 0,    -- the order rules are tried in
  "match"    TEXT NOT NULL DEFAULT 'all',   -- all | any of the conditions
  conditions TEXT NOT NULL DEFAULT '[]',    -- [{ field, op, value }]
  actions    TEXT NOT NULL DEFAULT '[]',    -- [{ type, value }]
  stop       INTEGER NOT NULL DEFAULT 0,    -- 1: no later rule is tried after this one matches
  n          INTEGER NOT NULL DEFAULT 0,    -- messages it has acted on
  last_at    INTEGER,                       -- ms, when it last acted
  last_error TEXT,                          -- what went wrong at iCloud the last time, until it next works
  created_at INTEGER NOT NULL
)`,
  // Senders whose remote images load as their mail opens.
  //
  // Images are held back by default, because a remote image is how a sender
  // learns you opened their mail. This is the list of the ones you have
  // decided may know: whole addresses, never domains.
  `CREATE TABLE IF NOT EXISTS image_senders (
  email      TEXT PRIMARY KEY,             -- lowercase, a whole address
  created_at INTEGER NOT NULL
)`,
  // Sessions ended before their time: signing out of a device puts its id
  // here, so a copy of the cookie stops working too. Kept only until the
  // token would have expired anyway — after that the signature check refuses
  // it on its own, and the next revocation sweeps the row.
  `CREATE TABLE IF NOT EXISTS revoked_sessions (
  sid        TEXT PRIMARY KEY,
  exp        INTEGER NOT NULL,             -- s, the token's own expiry
  created_at INTEGER NOT NULL
)`,
  // Full-text search. `id` is carried along to join back to messages, not
  // searched; diacritics are folded so "releve" finds "relevé".
  // Which index row holds which message. FTS5 can only look a row up by
  // rowid, so this is what lets one message leave the index without reading
  // all of it.
  `CREATE TABLE IF NOT EXISTS search_ids (
  id  TEXT PRIMARY KEY,                    -- messages.id
  rid INTEGER NOT NULL                     -- its rowid in search
)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
  id UNINDEXED,
  subject,
  sender,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
)`,
  // Calendar meetings & invitations extracted from mail.
  // Power the timeline of upcoming meetings.
  `CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,             -- messages.id
  account_id  TEXT NOT NULL,
  uid         TEXT NOT NULL DEFAULT '',     -- VEVENT UID
  summary     TEXT NOT NULL DEFAULT '',     -- VEVENT summary or message subject
  location    TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL DEFAULT '',     -- meeting join link (Teams, Meet, Zoom...)
  start_ms    INTEGER NOT NULL,
  end_ms      INTEGER NOT NULL,
  all_day     INTEGER NOT NULL DEFAULT 0,
  floating    INTEGER NOT NULL DEFAULT 0,   -- a time with no zone: the hour as written, wherever it is read
  status      TEXT NOT NULL DEFAULT '',     -- CONFIRMED, CANCELLED, etc.
  organizer   TEXT NOT NULL DEFAULT '',     -- CN or email
  created_at  INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_ms)`,
  // The one place anything that must nudge the user at a time is written; see
  // src/reminders.js. Its state is two timestamps, read as one state there.
  `CREATE TABLE IF NOT EXISTS reminders (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,                -- the feature: event, task, followup...
  ref          TEXT NOT NULL,                -- that feature's own id for the thing
  title        TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  at           INTEGER NOT NULL,             -- ms, when it rings: base_at, or later once snoozed
  base_at      INTEGER NOT NULL,             -- ms, the time the feature asked for
  fired_at    INTEGER,                      -- ms the cron picked it up; NULL until then
  dismissed_at INTEGER,                      -- ms the user dismissed it
  created_at   INTEGER NOT NULL,
  UNIQUE (kind, ref)
)`,
  `CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(at) WHERE fired_at IS NULL`,
  // To-do items, src/tasks.js. done_at is the one field that says a task is
  // done; due is a moment, or the date written in UTC when due_all_day is set.
  `CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  notes       TEXT NOT NULL DEFAULT '',
  due         INTEGER,                      -- ms; NULL for a task with no date
  due_all_day INTEGER NOT NULL DEFAULT 0,   -- 1: due is a date, midnight UTC, with no time
  reminder    INTEGER,                      -- ms the user asked to be nudged; see reminders.js
  important   INTEGER NOT NULL DEFAULT 0,
  done_at     INTEGER,                      -- ms; NULL while the task is open
  message_id  TEXT,                         -- the mail it was made from; may no longer exist
  position    INTEGER NOT NULL DEFAULT 0,   -- order of adding, for tasks with no date
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_open ON tasks(due) WHERE done_at IS NULL`,
  // Follow-ups: a message to come back to, or one you sent that wants an
  // answer. One row per message, only while it is open: a follow-up that is
  // cancelled by a reply or cleared by you is deleted, not kept with a flag.
  // See src/followup.js.
  `CREATE TABLE IF NOT EXISTS followups (
  message_id  TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  thread_key  TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL,                 -- flag: remind me at due | noreply: remind me at due if nobody has replied
  due         INTEGER NOT NULL,              -- ms
  state       TEXT NOT NULL DEFAULT 'waiting', -- waiting | reminded
  created_at  INTEGER NOT NULL
)`,
  // The calendar (src/calendar.js). Events live here, not at iCloud. Invitations
  // found in mail stay in `events` above and are never copied into these.
  `CREATE TABLE IF NOT EXISTS calendars (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#1f6fd0',
  kind        TEXT NOT NULL DEFAULT 'local',  -- local | subscription
  url_sealed  TEXT,                           -- a subscription's address, sealed with ENC_KEY; never sent to the page
  refresh_min INTEGER NOT NULL DEFAULT 60,    -- how often a subscription is fetched
  fetched_at  INTEGER,                        -- ms of the last fetch, successful or not; NULL until the first
  last_error  TEXT NOT NULL DEFAULT '',       -- what the last fetch said went wrong, shown beside the calendar
  hash        TEXT NOT NULL DEFAULT '',       -- of what the last fetch parsed to, to leave an unchanged feed alone
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS cal_events (
  id            TEXT PRIMARY KEY,
  calendar_id   TEXT NOT NULL,
  uid           TEXT NOT NULL,                -- iCalendar UID; an edited occurrence shares its series'
  summary       TEXT NOT NULL DEFAULT '',
  location      TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  url           TEXT NOT NULL DEFAULT '',
  start_ms      INTEGER NOT NULL,             -- an instant; for an all-day or floating event its wall time as UTC
  end_ms        INTEGER NOT NULL,             -- same; for all-day, the day after the last (exclusive)
  all_day       INTEGER NOT NULL DEFAULT 0,
  tzid          TEXT NOT NULL DEFAULT '',     -- IANA zone the wall clock is read in; '' with all_day = 0 is floating
  rrule         TEXT NOT NULL DEFAULT '',     -- RRULE text; '' for a single event
  exdates       TEXT NOT NULL DEFAULT '',     -- comma-separated start times (ms) of occurrences not held
  reminder_min  INTEGER,                      -- minutes before the start; NULL for none
  recurrence_id INTEGER,                      -- set on an edited occurrence: the start it had in its series' rule
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_cal_events_start ON cal_events(calendar_id, start_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_cal_events_uid ON cal_events(calendar_id, uid)`,
  // Signatures, src/signatures.js. html is already made safe on the way in.
  // signature_use says which one an address signs with: new_id for mail it
  // starts, reply_id for replies, either may be NULL (no signature). The
  // address '*' is the row for every address that has none of its own, which
  // is how the one signature everybody had before keeps signing every address
  // without a row per address having to be made for it.
  `CREATE TABLE IF NOT EXISTS signatures (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  html        TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS signature_use (
  address     TEXT PRIMARY KEY,             -- lowercase address, or '*'
  new_id      TEXT,
  reply_id    TEXT
)`,
];

/**
 * Columns a database created before this build might lack.
 *
 * schema.sql is CREATE TABLE IF NOT EXISTS from top to bottom. That is exactly
 * right for a fresh install and does nothing whatsoever for one that already
 * exists: a column added after the database was created is never added to the
 * database, and `npm run db:schema` will not tell you so.
 *
 * It is not a theoretical problem. The first INSERT naming a column that is
 * not there throws, storeRows throws with it, and the sync stops dead for
 * every account — silently, once a minute, for as long as it takes somebody
 * to notice no mail has arrived. Nor can it be fixed from a laptop: the API
 * token here deploys Workers but is refused on `d1 execute --remote`, so the
 * only thing that can reach the live database is the Worker itself.
 */
export const HEAL_COLUMNS = {
  messages: {
    mid: "TEXT NOT NULL DEFAULT ''",
    thread_key: "TEXT NOT NULL DEFAULT ''",
    cc_line: "TEXT NOT NULL DEFAULT ''",
    bcc_line: "TEXT NOT NULL DEFAULT ''",
    starred: "INTEGER NOT NULL DEFAULT 0",
    has_body: "INTEGER NOT NULL DEFAULT 0",
    refs: "TEXT NOT NULL DEFAULT ''",
    mailbox: "TEXT NOT NULL DEFAULT ''",
    uid: "INTEGER NOT NULL DEFAULT 0",
    color: "INTEGER NOT NULL DEFAULT 0",
    pinned: "INTEGER NOT NULL DEFAULT 0",
    importance: "INTEGER NOT NULL DEFAULT 0",
    att_names: "TEXT",
  },
  accounts: {
    label: "TEXT NOT NULL DEFAULT ''",
    secret: "TEXT",
    sync_state: "TEXT",
    last_error: "TEXT",
  },
  events: {
    floating: "INTEGER NOT NULL DEFAULT 0",
  },
};

/**
 * Indexes on columns an old database only has once healed.
 *
 * Kept out of SCHEMA because that runs first: on a database still missing
 * the column, the CREATE INDEX would throw before the heal that adds it, and
 * the sync would never get as far as fixing itself.
 */
export const AFTER_HEAL = [
  // Reconciling looks rows up by where the provider has them, a UID range at
  // a time. Without this every pass reads the whole mailbox's rows.
  `CREATE INDEX IF NOT EXISTS idx_messages_uid     ON messages(account_id, mailbox, uid)`,
  // The messages whose attachments have not been read yet. Holds nothing once
  // the backfill is done, so asking "is there any left" costs no row reads.
  `CREATE INDEX IF NOT EXISTS idx_messages_att_todo ON messages(account_id) WHERE att_names IS NULL`,
  // The few pinned messages, so a list can find its pinned conversations
  // without reading the folder.
  `CREATE INDEX IF NOT EXISTS idx_messages_pinned   ON messages(thread_key) WHERE pinned=1`,
];

/**
 * One-off data fixes, each run once and recorded in `settings` by name.
 * Unlike the DDL they are not cheap to repeat: each walks the whole table.
 */
export const MIGRATIONS = [
  // The five colours become five categories, ids 1 to 5, so a message's old
  // colour n is category n and its palette index is n-1. A migration may be a
  // list of statements, run in order.
  ["colors_to_categories", [
    `INSERT OR IGNORE INTO categories (id, name, color, position, created_at) VALUES
       (1,'Red',0,0,CAST(strftime('%s','now') AS INTEGER)*1000),
       (2,'Orange',1,1,CAST(strftime('%s','now') AS INTEGER)*1000),
       (3,'Yellow',2,2,CAST(strftime('%s','now') AS INTEGER)*1000),
       (4,'Green',3,3,CAST(strftime('%s','now') AS INTEGER)*1000),
       (5,'Blue',4,4,CAST(strftime('%s','now') AS INTEGER)*1000)`,
    `INSERT OR IGNORE INTO message_categories (message_id, category_id) SELECT id, color FROM messages WHERE color BETWEEN 1 AND 5`,
  ]],
  // Roots used to be keyed on their subject while their replies were keyed on
  // the root's Message-ID, so a conversation never grouped with its own first
  // message. A key that is not an id was a subject; where the row has an id,
  // that is what the key is now.
  ["thread_key_mid", `UPDATE messages SET thread_key=mid WHERE mid LIKE '<%>' AND thread_key NOT LIKE '<%'`],
  // The sealed Gemini key and model from before the move to Claude. They were
  // only cleared when a Claude key was saved in the app, so a deployment that
  // took its key from a secret kept a working Google credential sealed away
  // where nothing shows it and nobody remembers to revoke it.
  ["drop_gemini_key", `DELETE FROM settings WHERE key IN ('ai_key', 'ai_model')`],
  // Events indexed before `floating` existed all read 0, so a meeting given as
  // "09:00" with no zone still showed shifted in the timeline. Forgetting that
  // the timeline was seeded makes its next opening index the recent
  // invitations again, this time with the flag.
  ["events_floating", `DELETE FROM settings WHERE key='events_seeded'`],
  // The addresses kept by hand before there was an address book become its
  // first cards: one per address, named as it was named. contacts_added is
  // left where it is and no longer written.
  [
    "contacts_book",
    `INSERT OR IGNORE INTO contacts (id, uid, name, emails, created_at, updated_at)
     SELECT lower(hex(randomblob(8))), lower(hex(randomblob(16))), name,
            json_array(json_object('type', '', 'value', email)), created_at, created_at
       FROM contacts_added`,
  ],
  // The one plain-text signature becomes a signature named "Default", used by
  // every address for new mail and for replies, so nobody's mail changes on
  // the day this ships. Its text is escaped and its line breaks made <br>.
  // Nothing happens where there was no signature.
  ["signatures_default", [
    `INSERT INTO signatures (id, name, html, position, created_at, updated_at)
     SELECT lower(hex(randomblob(8))), 'Default',
            replace(replace(replace(replace(replace(value, char(13), ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), char(10), '<br>'),
            0, CAST(strftime('%s','now') AS INTEGER)*1000, CAST(strftime('%s','now') AS INTEGER)*1000
       FROM settings WHERE key='signature' AND trim(value) <> ''`,
    `INSERT OR IGNORE INTO signature_use (address, new_id, reply_id) SELECT '*', id, id FROM signatures WHERE name='Default'`,
    `DELETE FROM settings WHERE key='signature'`,
  ]],
];

/** What schema.sql looks like on disk, comments and all. */
export function schemaSql() {
  return `-- dmzs-mail, D1 schema.
--
-- GENERATED by scripts/gen-schema.mjs from src/schema.js. Do not edit by
-- hand: the generator overwrites this file, and deploy refuses to go ahead
-- while the two disagree. One provider, iCloud, over IMAP and SMTP spoken by
-- the Worker itself.

${[...SCHEMA, ...AFTER_HEAL].join(";\n\n")};
`;
}

/**
 * Brings a live database up to what this build expects.
 *
 * Everything here is idempotent, and costs one read when there is nothing to
 * do. Only ever says something when something changed: a line a minute saying
 * all is well is a line nobody reads.
 */
export async function ensureSchema(env) {
  // Thirteen statements a minute to find, nearly every time, that nothing has
  // changed. The fingerprint of what this build expects is kept once the
  // database matches it, and only a build that expects something else — a
  // new table, a new column — pays for the full pass.
  const fp = schemaFingerprint();
  const seen = await env.DB.prepare("SELECT value FROM settings WHERE key='schema_fp'")
    .first()
    .catch(() => null);
  if (seen?.value === fp) return [];

  const added = [];
  for (const sql of SCHEMA) {
    await env.DB.prepare(sql).run();
  }
  // Index rows written before search_ids existed. One read of the index,
  // once; after this every row is mapped as it is written.
  await env.DB.prepare("INSERT OR IGNORE INTO search_ids (id, rid) SELECT id, rowid FROM search").run();
  for (const [table, columns] of Object.entries(HEAL_COLUMNS)) {
    // pragma_table_info as a table-valued function rather than a bare PRAGMA:
    // it comes back as ordinary rows, which is what D1's query interface
    // returns anyway.
    const info = await env.DB.prepare("SELECT name FROM pragma_table_info(?)")
      .bind(table)
      .all()
      .catch(() => null);
    const have = new Set((info?.results ?? []).map((r) => r.name));
    // No columns at all means no table, which the CREATE above just made —
    // so there is nothing missing to heal on a fresh install.
    if (!have.size) continue;
    for (const [name, decl] of Object.entries(columns)) {
      if (have.has(name)) continue;
      // The table and column names are constants from the map above, never
      // anything that arrived over the wire — DDL cannot be parameterised.
      await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`).run();
      added.push(`${table}.${name}`);
    }
  }
  for (const sql of AFTER_HEAL) {
    await env.DB.prepare(sql).run();
  }
  if (added.length) console.log(`schema: added ${added.join(", ")}`);

  // A fresh install has nothing to migrate, but marking each done costs the
  // same either way and keeps this one code path. Inside the full pass, so
  // only a build whose fingerprint moved even asks.
  const done = await env.DB.prepare("SELECT value FROM settings WHERE key='migrations'")
    .first()
    .catch(() => null);
  let ran = [];
  try {
    ran = JSON.parse(done?.value || "[]");
  } catch {
    ran = [];
  }
  const todo = MIGRATIONS.filter(([name]) => !ran.includes(name));
  for (const [name, sql] of todo) {
    for (const one of [].concat(sql)) await env.DB.prepare(one).run();
    ran.push(name);
    console.log(`schema: migrated ${name}`);
  }
  if (todo.length) {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('migrations', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    )
      .bind(JSON.stringify(ran))
      .run();
  }
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('schema_fp', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  )
    .bind(fp)
    .run();
  return added;
}

/** A short hash of everything ensureSchema would apply. */
export function schemaFingerprint() {
  const text = JSON.stringify([SCHEMA, HEAL_COLUMNS, AFTER_HEAL, MIGRATIONS, "search_ids-v1"]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16);
}
