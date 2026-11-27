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
    "added": "ajouté",
    "Remove": "Retirer",
    "No match.": "Aucun résultat.",
    "Nothing yet — these appear once you have sent mail, or when you add a sender from a message.": "Rien pour l’instant. Les contacts apparaissent dès que vous avez envoyé des messages, ou quand vous ajoutez un expéditeur depuis un message.",
    "Removed {email}": "{email} retiré",
    "Nobody to send it to": "Aucun destinataire",
    "Nothing to send": "Rien à envoyer",
    "Could not schedule": "Impossible de programmer l’envoi",
    "Could not send": "Impossible d’envoyer le message",
    "Not sent — {reason}": "Non envoyé : {reason}",
    "Sent — but its draft could not be removed from Drafts": "Envoyé, mais son brouillon n’a pas pu être retiré des Brouillons",
    "{said}. Kept in this browser only: {reason}": "{said}. Conservé dans ce navigateur uniquement : {reason}",
    "{said}. It is in Drafts.": "{said}. Il se trouve dans les Brouillons.",
    "Reaction not sent": "Réaction non envoyée",
    "Send": "Envoyer",
    "Not sent": "Non envoyé",
    "Not sent — it is back in the composer": "Non envoyé : le message est de nouveau ouvert pour modification",
    "The previous message is still going out — try again in a moment": "Le message précédent est encore en cours d’envoi. Réessayez dans un instant",
    "Attachments are still loading — try again in a moment": "Les pièces jointes sont encore en cours de chargement. Réessayez dans un instant",
    "Sending…": "Envoi…",
    "Sending to {who}": "Envoi à {who}",
    "Sending to {who} and others": "Envoi à {who} et à d’autres destinataires",
    "Reacting to {who}": "Réaction à {who}",
    "Reacting to {who} and others": "Réaction à {who} et à d’autres destinataires",
    "Undo": "Annuler",
    "Sent — Apple would not keep a copy: {reason}": "Envoyé, mais Apple n’en a pas gardé de copie : {reason}",
    "unknown reason": "raison inconnue",
    "Reaction sent": "Réaction envoyée",
    "Sent, but the reminder could not be set": "Envoyé, mais le rappel n’a pas pu être programmé",
    "Sent": "Envoyé",
    "Be careful with links and attachments in this message.": "Méfiez-vous des liens et des pièces jointes de ce message.",
    "Reply": "Répondre",
    "Reply all": "Répondre à tous",
    "Bcc": "Cci",
    "{address} is one character from {resembles}.": "{address} ne diffère de {resembles} que d’un caractère.",
    "{n, plural, one {And # more.} other {And # more.}}": "{n, plural, one {Et # autre.} other {Et # autres.}}",
    "Is this the right address?": "Cette adresse est-elle la bonne ?",
    "Are these the right addresses?": "Ces adresses sont-elles les bonnes ?",
    "You have not written to it before. A typo sends a message to a stranger.": "Vous n’avez encore jamais écrit à cette adresse. Avec une faute de frappe, le message part chez un inconnu.",
    "You have not written to them before. A typo sends a message to a stranger.": "Vous n’avez encore jamais écrit à ces adresses. Avec une faute de frappe, le message part chez un inconnu.",
    "Send anyway": "Envoyer quand même",
    "Go back": "Revenir",
    "Show everyone each other's address?": "Montrer à chacun l’adresse des autres ?",
    "{people} people at {domains} different domains are on To and Cc. Each of them will see everyone else's address. Bcc keeps them private.": "{people} personnes de {domains} domaines différents figurent en À et en Cc. Chacune verra l’adresse de toutes les autres. En Cci, les adresses restent confidentielles.",
    "Move them to Bcc": "Les mettre en Cci",
    "This evening": "Ce soir",
    "Tomorrow morning": "Demain matin",
    "Monday morning": "Lundi matin",
    "Pick a time at least a minute from now": "Choisissez une heure située au moins une minute plus tard",
    "Scheduled — {when}": "Envoi programmé : {when}",
    "Scheduled ({n})": "Envois programmés ({n})",
    "Scheduled ({n}) — one needs a look": "Envois programmés ({n}) : l’un d’eux demande votre attention",
    "(no subject)": "(sans objet)",
    "To {to} · {when}": "À {to} · {when}",
    "Not sent yet: {reason}": "Pas encore envoyé : {reason}",
    "Send now": "Envoyer maintenant",
    "Edit": "Modifier",
    "Cancel": "Annuler",
    "Nothing waiting to go.": "Aucun message en attente d’envoi.",
    "Cancel this message?": "Annuler ce message ?",
    "It will not be sent, and is not kept anywhere.": "Il ne sera pas envoyé et ne sera conservé nulle part.",
    "Cancel it": "Annuler l’envoi",
    "Send this message now?": "Envoyer ce message maintenant ?",
    "To {to}.": "À {to}.",
    "It goes straight away instead of {when}, and cannot be taken back.": "Il part tout de suite, sans attendre le {when}, et ne pourra pas être rappelé.",
    "It goes straight away, and cannot be taken back.": "Il part tout de suite et ne pourra pas être rappelé.",
    "That didn't work": "Cela n’a pas fonctionné",
    "Scheduled message": "Message programmé",
    "Taken out of the schedule — send it or schedule it again": "Retiré de la programmation : envoyez-le ou programmez-le à nouveau",
    "Cancelled": "Annulé",

    "The sender's name says {brand}, but the message came from {email}, which is not one of {brand}'s addresses.": "Le nom de l’expéditeur indique {brand}, mais le message vient de {email}, qui n’est pas une adresse de {brand}.",
    "The address {email} is at a look-alike domain: {domain} borrows the name of {brand} on a domain it does not use.": "L’adresse {email} utilise un domaine trompeur : {domain} reprend le nom de {brand} avec une extension que cette marque n’utilise pas.",
    "The address {email} is at a look-alike domain: {domain} looks like {real}, which belongs to {brand}, but is not it.": "L’adresse {email} utilise un domaine trompeur : {domain} ressemble à {real}, qui appartient à {brand}, mais ce n’est pas le même.",
    "The sender's name shows {name}, but the message came from {email}.": "Le nom de l’expéditeur affiche {name}, mais le message vient de {email}.",
    "Thumbs up": "Pouce levé",
    "Heart": "Cœur",
    "Celebration": "Fête",
    "Laughing": "Rire",
    "Surprised": "Surprise",
    "Sad": "Tristesse",
    "This is a reaction to “{subject}”.": "Ceci est une réaction à « {subject} ».",
    "This is a reaction to your message.": "Ceci est une réaction à votre message.",

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
