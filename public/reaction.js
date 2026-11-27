/**
 * A reaction: one emoji, sent as a short reply.
 *
 * There is no reaction in mail, so this is an ordinary reply that says so. It
 * is built here, apart from the page, so that what it is made of can be
 * tested: the page and test/ both import this file. The message it returns is
 * the body /api/send takes, and it goes out through the one send path every
 * message does, with the hold to undo it and the copy in Sent. Threading is
 * the server's: given reply_to it writes In-Reply-To and References from the
 * message being answered, exactly as for a typed reply.
 */

import "./i18n.js";

const { t } = globalThis.StratusI18n;

export const REACTIONS = [
  { emoji: "👍", name: t("Thumbs up") },
  { emoji: "❤️", name: t("Heart") },
  { emoji: "🎉", name: t("Celebration") },
  { emoji: "😂", name: t("Laughing") },
  { emoji: "😮", name: t("Surprised") },
  { emoji: "😢", name: t("Sad") },
];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The /api/send body for a reaction.
 *
 *   message  The message reacted to, as the API lists it (id, account_id, subject).
 *   to       Who it goes to: the sender, or the Reply-To where there is one,
 *            as the page's reply would address it.
 *   from     The address the mail was sent to, "" for the account's own.
 *   emoji    One of REACTIONS.
 */
export function reactionMessage({ message, to, from = "", emoji }) {
  const subject = String(message.subject || "").trim();
  // The line says what it is, in words, for a reader whose client shows no
  // emoji or who has no idea why a thumb has arrived.
  const line = subject ? t("This is a reaction to “{subject}”.", { subject }) : t("This is a reaction to your message.");
  return {
    account_id: message.account_id,
    from: from || undefined,
    to: [].concat(to).join(", "),
    subject: /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`.trim(),
    text: `${emoji}\n\n${line}`,
    html:
      `<div style="font-size:32px;line-height:1.3">${emoji}</div>` +
      `<div style="color:#5b5b60;font-size:13px">${esc(line)}</div>`,
    reply_to: message.id,
  };
}

// The page reaches it from its own script.
if (typeof window !== "undefined") window.Reaction = { reactionMessage, REACTIONS };
