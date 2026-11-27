/**
 * Français. The keys are the English the code writes (see i18n.js); this is
 * only what each one reads as here. scripts/check-i18n.mjs fails when a string
 * the page can show has no entry, when an entry has no string left, and when a
 * placeholder or a plural of the English is missing from the French.
 *
 * Vouvoiement, sentence case, « guillemets » and a narrow no-break space
 * (U+202F) before ; : ! ? and inside them. The vocabulary is Apple Mail's.
 */
StratusI18n.define("fr", {
  locale: "fr-FR",
  strings: {
    /* ── shared ── */

    "Inbox": "Boîte de réception",

    /* ── markup ── */

    /* ── end markup ── */

    /* ── page 1 ── */

    /* ── end page 1 ── */

    /* ── page 2 ── */

    /* ── end page 2 ── */

    /* ── page 3 ── */

    /* ── end page 3 ── */

    /* ── page 4 ── */

    "{size} MB": "{size} Mo",
    "{size} KB": "{size} Ko",
    "• {label}: {reason}": "• {label} : {reason}",
    "{n, plural, one {…and # more} other {…and # more}}": "{n, plural, one {… et # autre} other {… et # autres}}",
    "Details": "Détails",
    "New folder…": "Nouveau dossier…",
    "{n, plural, one {# file} other {# files}}, {size}: {names}": "{n, plural, one {# fichier} other {# fichiers}}, {size} : {names}",
    "No file chosen.": "Aucun fichier choisi.",
    "Stopping…": "Arrêt en cours…",
    "You have been signed out": "Vous avez été déconnecté",
    "the connection dropped": "la connexion a été interrompue",
    "This account needs reconnecting": "Ce compte doit être reconnecté",
    "the server answered {status}": "le serveur a répondu {status}",
    "the server did not answer": "le serveur n’a pas répondu",
    "larger than {max} MB ({size})": "plus de {max} Mo ({size})",
    "the message is empty": "le message est vide",
    "Importing {done} of {total}": "Import : {done} sur {total}",
    "Importing {done}": "Import : {done}",
    "Exporting {done} of {total}": "Export : {done} sur {total}",
    "Exporting {done}": "Export : {done}",
    "{n, plural, one {# already there} other {# already there}}": "{n, plural, one {# déjà présent} other {# déjà présents}}",
    "{n, plural, one {# failed} other {# failed}}": "{n, plural, one {# en échec} other {# en échec}}",
    "Give the new folder a name without quotes or backslashes": "Donnez au nouveau dossier un nom sans guillemets ni barres obliques inverses",
    "Counting messages…": "Comptage des messages…",
    "Counting messages… {n}": "Comptage des messages… {n}",
    "no messages found in it": "aucun message n’y a été trouvé",
    "could not read the file ({reason})": "impossible de lire le fichier ({reason})",
    "Stopped after {done} of {total}: {reason}.": "Arrêté après {done} sur {total} : {reason}.",
    "Cancelled with {left, plural, one {# of {total}} other {# of {total}}} not yet sent.": "Annulé : {left, plural, one {# message sur {total} n’a pas encore été envoyé} other {# messages sur {total} n’ont pas encore été envoyés}}.",
    "Imported {n, plural, one {# message} other {# messages}} into “{folder}”.": "{n, plural, one {# message importé} other {# messages importés}} dans « {folder} ».",
    "{n, plural, one {# message was already in your account and skipped.} other {# messages were already in your account and skipped.}}": "{n, plural, one {# message était déjà dans votre compte et a été ignoré.} other {# messages étaient déjà dans votre compte et ont été ignorés.}}",
    "{n, plural, one {# message could not be imported:} other {# messages could not be imported:}}": "{n, plural, one {# message n’a pas pu être importé :} other {# messages n’ont pas pu être importés :}}",
    "Choose the same files again to carry on: what is already in is skipped.": "Choisissez de nouveau les mêmes fichiers pour reprendre : ce qui est déjà importé sera ignoré.",
    "Mailbox archive": "Archive de messagerie",
    "this is more than the {max} MB a browser without direct file access can save as one file. Use Chrome or Edge, which write straight to disk, or export part of it from the selection bar": "cela dépasse les {max} Mo qu’un navigateur sans accès direct aux fichiers peut enregistrer en un seul fichier. Utilisez Chrome ou Edge, qui écrivent directement sur le disque, ou exportez-en une partie depuis la barre de sélection",
    "Exporting…": "Export en cours…",
    "message {id}": "message {id}",
    "Export stopped: {reason}.": "Export interrompu : {reason}.",
    "Cancelled. The file holds the messages written so far.": "Annulé. Le fichier contient les messages déjà écrits.",
    "Exported {n, plural, one {# message} other {# messages}} of {total} as a download: {name}": "{n, plural, one {# message exporté} other {# messages exportés}} sur {total}, dans le fichier téléchargé : {name}",
    "Exported {n, plural, one {# message} other {# messages}} of {total} to the file you chose: {name}": "{n, plural, one {# message exporté} other {# messages exportés}} sur {total}, dans le fichier choisi : {name}",
    "Exported {n, plural, one {# message} other {# messages}} as a download: {name}": "{n, plural, one {# message exporté} other {# messages exportés}} dans le fichier téléchargé : {name}",
    "Exported {n, plural, one {# message} other {# messages}} to the file you chose: {name}": "{n, plural, one {# message exporté} other {# messages exportés}} dans le fichier choisi : {name}",
    "{n, plural, one {# message could not be read from iCloud and is not in the file:} other {# messages could not be read from iCloud and are not in the file:}}": "{n, plural, one {# message n’a pas pu être lu sur iCloud et ne figure pas dans le fichier :} other {# messages n’ont pas pu être lus sur iCloud et ne figurent pas dans le fichier :}}",
    "An import or export is already running": "Un import ou un export est déjà en cours",

    /* ── end page 4 ── */

    /* ── page 5 ── */

    /* ── end page 5 ── */

    /* ── page 6 ── */

    /* ── end page 6 ── */

    /* ── page 7 ── */

    /* ── end page 7 ── */

    /* ── worker ── */

    /* ── end worker ── */
  },
});
