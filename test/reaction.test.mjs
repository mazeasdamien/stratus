/**
 * The reaction's message (public/reaction.js): who it goes to, who it is from,
 * what it says, and how the send path threads it. The threading is the
 * server's, so it is read off the message that path builds for it. The whole
 * way through the real send is in the sync harness.
 */
import { eq, ok } from "./harness.mjs";
import { REACTIONS, reactionMessage } from "../public/reaction.js";
import { buildRfc822, replyReferences } from "../src/mime.js";

eq(REACTIONS.map((r) => r.emoji), ["👍", "❤️", "🎉", "😂", "😮", "😢"], "the six reactions, in order");

const message = { id: "0123456789abcdef", account_id: "acct1", subject: "Quarterly plan", mid: "<c@x.test>", refs: "<a@x.test> <b@x.test>", from_email: "zoe@x.test" };

const m = reactionMessage({ message, to: ["zoe.reply@x.test"], from: "alias@icloud.test", emoji: "👍" });
eq([m.to, m.from, m.account_id, m.reply_to], ["zoe.reply@x.test", "alias@icloud.test", "acct1", "0123456789abcdef"], "to the address given, from the one the mail was sent to, as a reply to the message");
eq(m.subject, "Re: Quarterly plan", "a reply's subject");
eq(m.text, "👍\n\nThis is a reaction to “Quarterly plan”.", "the plain text is the emoji and a line saying what it is");
ok(m.html.includes("👍") && m.html.includes("reaction to “Quarterly plan”"), "and so is the HTML");

eq(reactionMessage({ message, to: "zoe@x.test", emoji: "❤️" }).from, undefined, "from the account's own address when there is no other");
eq(reactionMessage({ message: { ...message, subject: "Re: Quarterly plan" }, to: ["a@x.test"], emoji: "🎉" }).subject, "Re: Quarterly plan", "Re: is not added twice");
eq(reactionMessage({ message: { ...message, subject: "" }, to: ["a@x.test"], emoji: "🎉" }).text, "🎉\n\nThis is a reaction to your message.", "a message with no subject is still named");
ok(!reactionMessage({ message: { ...message, subject: "<img src=x onerror=1>" }, to: ["a@x.test"], emoji: "😂" }).html.includes("<img"), "a subject is escaped in the HTML");
eq(reactionMessage({ message, to: ["a@x.test", "b@x.test"], emoji: "😮" }).to, "a@x.test, b@x.test", "several recipients are written as a list");

// What the send path makes of it: the reply headers it writes for reply_to.
const raw = buildRfc822({
  from: "Me <alias@icloud.test>",
  to: m.to,
  subject: m.subject,
  text: m.text,
  html: m.html,
  inReplyTo: message.mid,
  references: replyReferences(message),
  messageId: "<r@x.test>",
});
ok(/^In-Reply-To: <c@x\.test>$/m.test(raw), "In-Reply-To is the message reacted to");
ok(/^References: <a@x\.test> <b@x\.test> <c@x\.test>$/m.test(raw), "References is its chain, with it at the end");
ok(/^To: zoe\.reply@x\.test$/m.test(raw) && /^From: Me <alias@icloud\.test>$/m.test(raw), "and it is addressed as built");
