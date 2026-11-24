/**
 * Failures that have a shape the caller can act on.
 *
 * The rest of the stack throws ordinary Errors: a missing mailbox, a message
 * that has gone from the server, a parse that found nothing. Those are 502s
 * and worth saying out loud.
 *
 * This one is different. It means the credential itself was refused — an
 * app-specific password revoked at account.apple.com, a typo that survived
 * the first connect — and no retry and no amount of waiting will fix it. The
 * account is marked `reauth` and somebody has to paste a fresh password.
 *
 * It used to be an `e.reauth = true` flag stuck onto whatever Error was
 * already in flight. That survived a round trip through `String(e.message)`
 * about as well as you would expect.
 */
export class MailAuthError extends Error {
  constructor(message = "Apple rejected that address or app password") {
    super(message);
    this.name = "MailAuthError";
  }
}

/** true when this failure means "reconnect the account", whatever threw it. */
export const isAuthFailure = (e) =>
  e instanceof MailAuthError || !!(e && e.reauth);

/**
 * The connection to the mail server could not be opened from where this
 * request is running: the socket died before the server's greeting, so
 * nothing was sent and the request can be run again somewhere else.
 *
 * On 2026-11-24 every outbound socket from Cloudflare's Paris location failed
 * this way at once ("Stream was cancelled.", in 3 ms, to any host), and
 * Delete, Archive and Star answered 502 from France for as long as it lasted.
 * The fetch handler catches this one and reruns the request in another
 * region (src/elsewhere.js).
 */
export class NoRouteError extends Error {
  constructor(message = "Could not reach the mail server from here") {
    super(message);
    this.name = "NoRouteError";
  }
}
