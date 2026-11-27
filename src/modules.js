import { remindersModule } from "./reminders.js";
import { tasksModule } from "./tasks.js";
import { calendarModule } from "./calendar.js";

/**
 * Where a feature plugs into the Worker without editing the shared files.
 *
 * Each feature is one file in src/ that exports a module, plus one line in
 * MODULES below. Branches that each add a feature then touch their own file
 * and one line of this array, rather than the route chain in api.js, the
 * cron in index.js or the table list in backup.js.
 *
 *   { name, api?, cron?, tables? }
 *
 *   name    Unique, for logs. Not used for routing.
 *
 *   api(request, env, path, ctx, session)
 *           Asked before any built-in route, in MODULES order, for every
 *           authenticated /api/ request. Returns a Response to answer it, or
 *           null to let the next module, and then the built-in routes, have
 *           it. Claim only paths you own, such as "/api/calendar/...": a
 *           module that answers a path the app already serves replaces it.
 *
 *   cron(env, ctx, event)
 *           Runs on the per-minute heartbeat, beside the mail sync, never on
 *           the nightly schedule. A throw or rejection is logged and stops
 *           nothing else. It runs every minute, so keep your own cursor in
 *           the database if you only want to work now and then.
 *
 *   tables  D1 tables the module owns, as they are named in src/schema.js.
 *           They are added to the nightly snapshot and to restore. The
 *           schema itself is still described once, in schema.js.
 *
 * The array is mutable so a test can add a module and take it out again.
 */
import { categoriesModule } from "./categories.js";
import { contacts } from "./contacts.js";
import { followupModule } from "./followup.js";
import { rulesModule } from "./sorting.js";
import { transfer } from "./transfer.js";

// One module to a line, so two branches that each add one do not collide.
export const MODULES = [
  remindersModule,
  categoriesModule,
  contacts,
  tasksModule,
  followupModule,
  rulesModule,
  transfer,
  calendarModule,
];

/** The first Response a module gives for this request, or null. */
export async function moduleApi(request, env, path, ctx, session) {
  for (const m of MODULES) {
    if (!m.api) continue;
    const res = await m.api(request, env, path, ctx, session);
    if (res) return res;
  }
  return null;
}

/**
 * Every module's cron, each under ctx.waitUntil and each on its own: one that
 * throws, synchronously or not, is logged and the next still runs.
 */
export function moduleCrons(env, ctx, event) {
  for (const m of MODULES) {
    if (!m.cron) continue;
    ctx.waitUntil(
      (async () => m.cron(env, ctx, event))().catch((e) =>
        console.log(`module ${m.name}: ${e && e.stack ? e.stack : e}`)
      )
    );
  }
}

/** Tables the modules own, once each. */
export function moduleTables() {
  return [...new Set(MODULES.flatMap((m) => m.tables || []))];
}
