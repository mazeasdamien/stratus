/**
 * Running a request from another region when this one cannot reach Apple.
 *
 * A Worker runs where Cloudflare puts it, and on 2026-11-24 the place it put
 * this one could not open an outbound socket to anything: every IMAP action
 * answered "Stream was cancelled." within a few milliseconds while the cron,
 * running somewhere else, went on syncing. Nothing in the request was wrong;
 * it was in the wrong place.
 *
 * So the place is checked on every request, by the request itself. When the
 * connection to the mail server dies before the server has said a word
 * (NoRouteError, from imapOpen), nothing has been done there and the request
 * is safe to run again. It is handed to a Durable Object pinned to another
 * region, which runs the same code with the same bindings, and its answer is
 * returned as if nothing had happened. A second region is tried if the first
 * is no better.
 *
 * No probe on a timer, and no state to go stale: the check costs nothing when
 * everything works, and a few milliseconds when it does not.
 *
 * SMTP is deliberately not covered. A send that failed half way is not safe to
 * repeat, and the outbox already retries a send that did not go.
 */

/**
 * Where to try, in order. Eastern Europe first: near enough to the database
 * in Western Europe to be quick, far enough to be a different set of
 * machines. Then the other side of the Atlantic.
 */
export const REGIONS = ["eeur", "enam"];

/** Says which region answered, on the response, for anyone checking. */
export const RAN_IN = "X-Ran-In";
/** Marks an answer from a region that could not reach the server either. */
export const NO_ROUTE = "X-No-Route";

/**
 * Runs `request` (an unread copy of the original) in the first region that
 * can reach the mail server. Returns its response, or null when the binding
 * is missing or no region could, so the caller answers with its own error.
 */
export async function runElsewhere(request, env, why) {
  if (!env.ELSEWHERE) return null;
  let last = null;
  for (let i = 0; i < REGIONS.length; i++) {
    const region = REGIONS[i];
    // A copy per attempt but the last, which can have the original.
    const attempt = new Request(i < REGIONS.length - 1 ? request.clone() : request);
    attempt.headers.set("X-Region", region);
    try {
      const stub = env.ELSEWHERE.get(env.ELSEWHERE.idFromName(region), { locationHint: region });
      const res = await stub.fetch(attempt);
      if (!res.headers.get(NO_ROUTE)) {
        console.log(`no route from here (${why}); ran in ${region} instead`);
        return res;
      }
      last = res;
    } catch (e) {
      console.log(`relay to ${region} failed: ${(e && e.message) || e}`);
    }
  }
  console.log(`no route from here (${why}), nor from ${REGIONS.join(" or ")}`);
  return last;
}
