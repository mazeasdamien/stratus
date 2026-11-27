/**
 * The translator (public/i18n.js): English falls through as it is, a
 * dictionary replaces it, placeholders and plurals are filled in with the
 * language's own rules, and a value that was not given is left showing.
 */
import { eq, ok } from "./harness.mjs";
import "../public/i18n.js";

const I = globalThis.StratusI18n;
const { t, tw } = I;

// English: the text is the answer, with its values in.
eq(t("Archive"), "Archive", "English with no entry is the English");
eq(t("Moved to {folder}", { folder: "Receipts" }), "Moved to Receipts", "a placeholder is filled");
eq(t("{a} and {a}", { a: "x" }), "x and x", "a placeholder may appear twice");
eq(t("Moved to {folder}", {}), "Moved to {folder}", "a value that was not given stays visible");
eq(t("Moved to {folder}", { folder: undefined }), "Moved to {folder}", "an undefined value is not printed as undefined");
eq(t("Moved to {folder}", { folder: 0 }), "Moved to 0", "zero is a value");

const many = "{n, plural, =0 {No messages} one {# message} other {# messages}}";
eq([0, 1, 2, 1.5].map((n) => t(many, { n })), ["No messages", "1 message", "2 messages", "1.5 messages"], "English plural: only 1 is singular");
eq(t(many, {}), many, "a plural with no count stays as written");
eq(t("{n, plural, one {# file} other {# files} }", { n: 1234 }), "1,234 files", "a count is formatted for the language");
eq(t("Deleted {n, plural, one {# message} other {# messages}} in {folder}", { n: 3, folder: "Trash" }), "Deleted 3 messages in Trash", "a plural inside a sentence");
eq(t("{n, plural, one {{name} has # message} other {{name} has # messages}}", { n: 2, name: "Ana" }), "Ana has 2 messages", "a placeholder inside a plural branch");

// A language: its entry, its plural rule, its numbers.
I.define("fr", {
  locale: "fr-FR",
  strings: {
    "Moved to {folder}": "Déplacé vers {folder}",
    "{n, plural, =0 {No messages} one {# message} other {# messages}}": "{n, plural, =0 {Aucun message} one {# message} other {# messages}}",
    "{n, plural, one {# file} other {# files} }": "{n, plural, one {# fichier} other {# fichiers}}",
    "Too many wrong keys. Try again in {n} min.": "Trop de clés erronées. Réessayez dans {n} min.",
    "Wrong key": "Clé erronée",
    "Not saved: {why}": "Non enregistré : {why}",
  },
});
I.use("fr");
eq(I.code, "fr", "the language is in use");
eq(t("Wrong key"), "Clé erronée", "an entry replaces the English");
eq(t("Unknown thing"), "Unknown thing", "no entry: the English shows");
eq(t("Moved to {folder}", { folder: "Reçus" }), "Déplacé vers Reçus", "a translated placeholder");
eq(t("Moved to {folder}", {}), "Déplacé vers {folder}", "a missing value is left visible in French too");
eq([0, 1, 2, 1.5].map((n) => t(many, { n })), ["Aucun message", "1 message", "2 messages", "1,5 message"], "French plural: 0 and 1 are singular, and so is 1.5");
eq(t("{n, plural, one {# file} other {# files} }", { n: 1234 }).replace(/\s/g, " "), "1 234 fichiers", "numbers group the French way");
eq(t("{n, plural, one {# file} other {# files} }", { n: 0 }), "0 fichier", "zero is singular in French");

// Text that arrives already written, from the Worker.
eq(tw("Wrong key"), "Clé erronée", "worker text: an exact entry");
eq(tw("Too many wrong keys. Try again in 3 min."), "Trop de clés erronées. Réessayez dans 3 min.", "worker text: an entry with a placeholder, matched");
eq(tw("Not saved: it was a long day"), "Non enregistré : it was a long day", "worker text: the variable part is carried over");
eq(tw("Something nobody translated"), "Something nobody translated", "worker text with no entry stays English");
eq(tw(undefined), undefined, "worker text that is not text is returned as it was");

// The service worker's side: the choice is handed over and read back.
I.use("en");
eq(tw("Wrong key"), "Wrong key", "English: worker text is untouched");
eq(I.resolve("fr"), "fr", "a stored choice resolves to itself");
eq(I.resolve("xx"), I.resolve("system"), "an unknown choice follows the system");
ok(I.LANGUAGES.every((l) => l.code === "en" || l.file), "every language but English has a file");
