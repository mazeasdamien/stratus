/**
 * The two checks before a send (public/sendguard.js), by what they report.
 * Addresses are invented: example.test and friends, never anyone's real one.
 */
import { eq, ok } from "./harness.mjs";
import { exposure, lookalikes, oneAway } from "../public/sendguard.js";

const found = (recipients, known, own = ["me@icloud.com"]) =>
  lookalikes(recipients, known, own).map((l) => `${l.address} ~ ${l.resembles} (${l.part})`);

// One edit: insert, delete, substitute, swap. Two is not one, and nothing is not one.
ok(oneAway("acme.com", "acme.co") && oneAway("acme.co", "acme.com"), "a deleted character is one edit");
ok(oneAway("acme.com", "acmee.com") && oneAway("acme.com", "acne.com"), "an inserted and a substituted one are one edit");
ok(oneAway("acme.com", "amce.com"), "two neighbours swapped are one edit");
ok(!oneAway("acme.com", "acme.com") && !oneAway("acme.com", "acne.co") && !oneAway("acme.com", "ca.me.com"), "the same, two edits and three edits are not");
ok(!oneAway("abcd", "badc"), "two swaps are two edits");

const known = ["alice@acme-corp.test", "bob@northwind.test", "carol@gmail.com", "jonathan@gmail.com"];

// A typo of a domain you write to.
eq(found(["alice@acme-corp.tset"], known), ["alice@acme-corp.tset ~ alice@acme-corp.test (domain)"], "a swapped domain is flagged, naming the address it resembles");
eq(found(["dave@northwnd.test"], known), ["dave@northwnd.test ~ bob@northwind.test (domain)"], "a deleted letter in a domain you know is flagged even for another person");
eq(found(["bob@northwindd.test"], known), ["bob@northwindd.test ~ bob@northwind.test (domain)"], "an inserted letter too");

// A typo of a name at a domain you write to.
eq(found(["jonathon@gmail.com"], known), ["jonathon@gmail.com ~ jonathan@gmail.com (name)"], "a name one letter off at the same domain is flagged");
eq(found(["alicia@acme-corp.test"], known), [], "a different name two letters off is not");

// Not flagged: people you know, you, a domain somebody you know is at.
eq(found(["alice@acme-corp.test", "ALICE@ACME-CORP.TEST"], known), [], "someone you know is never flagged, whatever the case");
eq(found(["me@icloud.com"], known), [], "you are never flagged");
eq(found(["erin@acme-corp.test"], [...known, "erin@acme-corp.tes"]), [], "a domain somebody you know is already at is not a typo of anything");
eq(found(["zoe@brand-new.test"], known), [], "a stranger at an unrelated domain is not flagged");

// Free mail.
eq(found(["x@gmx.de"], ["y@gmx.at"]), [], "two free-mail domains a character apart are not look-alikes of each other");
eq(found(["x@hotmail.com"], ["y@hotmail.co"]).length, 1, "a free-mail domain is still compared with one that is not on the list");
eq(found(["carol@gmial.com"], known), ["carol@gmial.com ~ carol@gmail.com (domain)"], "gmail.com mistyped is caught");
eq(found(["al@gmail.com"], ["ed@gmail.com"]), [], "short names are not compared");

// Your own address mistyped.
eq(found(["me@iclould.com"], [], ["me@icloud.com"]), ["me@iclould.com ~ me@icloud.com (domain)"], "your own address mistyped is caught");

// Exposure.
const own = ["me@icloud.com", "me@studio.test"];
const five = ["a@one.test", "b@two.test", "c@three.test", "d@four.test", "e@five.test"];
eq(exposure(five, own)?.outside.length, 5, "five outside addresses across five domains is flagged");
eq(exposure(five.slice(0, 4), own), null, "four is not");
eq(exposure(["a@one.test", "b@one.test", "c@one.test", "d@one.test", "e@one.test", "f@one.test"], own), null, "six at one domain is a team, not a list");
eq(exposure([...five.slice(0, 4), "colleague@studio.test"], own), null, "a colleague on your own domain does not count");
eq(exposure([...five.slice(0, 4), "ME@studio.test", "b@two.test"], own), null, "you, and a repeated address, do not count");
eq(exposure(["a@gmail.com", "b@gmail.com", "c@gmail.com", "d@outlook.com", "e@icloud.com"], own)?.domains.length, 3, "free-mail addresses are outside, even at the domain of your own address");
eq(exposure(five, ["me@icloud.com"])?.outside.length, 5, "an address at a free-mail provider gives you no domain of your own");
eq(exposure(five, own)?.domains.sort(), ["five.test", "four.test", "one.test", "three.test", "two.test"], "it reports the domains");
