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

    "Archived": "Archivé",
    "Categorize": "Catégoriser",
    "Categorize: {categories}": "Catégoriser : {categories}",
    "Pin conversation": "Épingler la conversation",
    "Unpin conversation": "Désépingler la conversation",
    "High importance": "Importance haute",
    "Low importance": "Importance basse",
    "Pinned": "Épinglée",
    "No categories yet.": "Aucune catégorie pour l’instant.",
    "Clear categories": "Retirer les catégories",
    "All categories…": "Toutes les catégories…",
    "Could not change the categories": "Impossible de modifier les catégories",
    "There is no category {n} yet": "Il n’y a pas encore de catégorie {n}",
    "{category} removed": "Catégorie {category} retirée",
    "{category} added": "Catégorie {category} ajoutée",
    "Pinned to the top": "Épinglée en haut de la liste",
    "Unpinned": "Désépinglée",
    "Could not change the pin": "Impossible de modifier l’épinglage",
    "Pinned — {n, plural, one {# conversation} other {# conversations}}": "{n, plural, one {# conversation épinglée} other {# conversations épinglées}}",
    "Unpinned — {n, plural, one {# conversation} other {# conversations}}": "{n, plural, one {# conversation désépinglée} other {# conversations désépinglées}}",
    "Red": "Rouge",
    "Orange": "Orange",
    "Yellow": "Jaune",
    "Green": "Vert",
    "Blue": "Bleu",
    "Purple": "Violet",
    "Pink": "Rose",
    "Teal": "Bleu canard",
    "Brown": "Marron",
    "Gray": "Gris",
    "Colour of {name}: {colour}. Change": "Couleur de {name} : {colour}. Modifier",
    "Name of this category": "Nom de cette catégorie",
    "Messages with it": "Messages dans cette catégorie",
    "{n, plural, one {# message} other {# messages}}": "{n, plural, one {# message} other {# messages}}",
    "Delete": "Supprimer",
    "Delete {name}": "Supprimer {name}",
    "Colour": "Couleur",
    "No categories yet. Add the first one below.": "Aucune catégorie pour l’instant. Ajoutez la première ci-dessous.",
    "That did not work": "Cela n’a pas fonctionné",
    "Delete the category {name}?": "Supprimer la catégorie {name} ?",
    "It is taken off {n, plural, one {# message} other {# messages}}. The messages themselves stay.": "Elle sera retirée de {n, plural, one {# message} other {# messages}}. Les messages eux-mêmes restent.",
    "No message has it.": "Aucun message n’est dans cette catégorie.",
    "Images shown for this message": "Images affichées pour ce message",
    "Always": "Toujours",
    "That didn't work": "Cela n’a pas fonctionné",
    "Could not move this conversation": "Impossible de déplacer cette conversation",
    "{action} — {n, plural, one {# message} other {# messages}}": "{action} ({n, plural, one {# message} other {# messages}})",
    "Moved to Inbox": "Déplacé dans la boîte de réception",
    "Deleted": "Supprimé",
    "Delete this conversation permanently?": "Supprimer définitivement cette conversation ?",
    "Delete this message permanently?": "Supprimer définitivement ce message ?",
    "All {n} messages are removed from iCloud itself and cannot be recovered.": "Les {n} messages seront supprimés d’iCloud même et ne pourront pas être récupérés.",
    "It is removed from iCloud itself and cannot be recovered.": "Il sera supprimé d’iCloud même et ne pourra pas être récupéré.",
    "Could not delete this conversation": "Impossible de supprimer cette conversation",
    "Could not delete": "Impossible de supprimer",
    "Deleted permanently": "Supprimé définitivement",
    "Star": "Ajouter une étoile",
    "Could not star this message": "Impossible d’ajouter une étoile à ce message",
    "Could not remove the star": "Impossible de retirer l’étoile",
    "Could not mark it unread": "Impossible de le marquer comme non lu",
    "Marked unread": "Marqué comme non lu",
    "Nothing else to move it to yet.": "Aucun autre dossier où le déplacer pour l’instant.",
    "Moved to {folder}": "Déplacé vers {folder}",
    "Unknown sender": "Expéditeur inconnu",
    "This message carries no sender address.": "Ce message n’indique aucune adresse d’expéditeur.",
    "This message carries no sender address": "Ce message n’indique aucune adresse d’expéditeur",
    "Add to contacts": "Ajouter aux contacts",
    "No address to add": "Aucune adresse à ajouter",
    "Always load their images": "Toujours charger ses images",
    "Stop loading their images": "Ne plus charger ses images",
    "Open contact": "Ouvrir le contact",
    "Block and delete": "Bloquer et supprimer",
    "Everything from this address or domain is destroyed at iCloud — what arrives from now on, and what is already there. It cannot be undone.": "Tout ce qui vient de cette adresse ou de ce domaine est détruit sur iCloud, ce qui arrivera désormais comme ce qui s’y trouve déjà. Cette action est irréversible.",
    "Could not block this sender": "Impossible de bloquer cet expéditeur",
    "Blocked {pattern} — {n, plural, one {# deleted} other {# deleted}}": "{pattern} bloqué, {n, plural, one {# message supprimé} other {# messages supprimés}}",
    "Blocked {pattern}": "{pattern} bloqué",
    "nothing yet": "rien pour l’instant",
    "{n, plural, one {# deleted} other {# deleted}}, last {date}": "{n, plural, one {# supprimé} other {# supprimés}}, dernier le {date}",
    "{n, plural, one {# deleted} other {# deleted}}": "{n, plural, one {# supprimé} other {# supprimés}}",
    "Remove": "Retirer",
    "Nothing blocked. Mail from everyone reaches you.": "Aucun blocage. Les messages de tout le monde vous parviennent.",
    "Could not remove this rule": "Impossible de retirer ce blocage",
    "{pattern} unblocked — their next message arrives": "{pattern} débloqué : son prochain message arrivera normalement",
    "a deleted category": "une catégorie supprimée",
    "“{text}”": "« {text} »",
    "{action}: {value}": "{action} : {value}",
    "or": "ou",
    "and": "et",
    "Has not acted yet": "Pas encore appliquée",
    "Acted on {n, plural, one {# message} other {# messages}}, last {date}": "Appliquée à {n, plural, one {# message} other {# messages}}, dernière fois le {date}",
    "Acted on {n, plural, one {# message} other {# messages}}": "Appliquée à {n, plural, one {# message} other {# messages}}",
    "{name} is on": "{name} : activée",
    "{name} is off": "{name} : désactivée",
    "Written by another version of the app. This one cannot read it, so it never acts.": "Créée par une autre version de l’app, que celle-ci ne sait pas lire. Elle ne s’applique donc jamais.",
    "Last problem: {error}": "Dernier problème : {error}",
    "Move {name} up": "Monter {name}",
    "Move up": "Monter",
    "Move {name} down": "Descendre {name}",
    "Move down": "Descendre",
    "Edit {name}": "Modifier {name}",
    "Edit": "Modifier",
    "No rules yet. Mail stays where it lands until you add one.": "Aucune règle pour l’instant. Les messages restent là où ils arrivent tant que vous n’en ajoutez pas.",
    "Applies the enabled rules to what is in the inbox.": "Applique les règles activées aux messages de la boîte de réception.",
    "Could not reorder the rules": "Impossible de réordonner les règles",
    "Could not change this rule": "Impossible de modifier cette règle",
    "Delete the rule {name}?": "Supprimer la règle {name} ?",
    "Mail it already sorted stays where it is.": "Les messages déjà triés restent où ils sont.",
    "Could not delete this rule": "Impossible de supprimer cette règle",
    "No rule is switched on.": "Aucune règle n’est activée.",
    "Checked {n, plural, one {# message} other {# messages}}, {changed, plural, one {# changed} other {# changed}}…": "{n, plural, one {# message vérifié} other {# messages vérifiés}}, {changed, plural, one {# modifié} other {# modifiés}}…",
    "Checking the inbox…": "Vérification de la boîte de réception…",
    "Could not run the rules": "Impossible d’appliquer les règles",
    "Checked {n, plural, one {# message} other {# messages}}, {changed, plural, one {# changed} other {# changed}}, {failed, plural, one {# could not be updated at iCloud} other {# could not be updated at iCloud}} (see the rules).": "{n, plural, one {# message vérifié} other {# messages vérifiés}}, {changed, plural, one {# modifié} other {# modifiés}}, {failed, plural, one {# n’a pas pu être mis à jour sur iCloud} other {# n’ont pas pu être mis à jour sur iCloud}} (voir les règles).",
    "Checked {n, plural, one {# message} other {# messages}}, {changed, plural, one {# changed} other {# changed}}.": "{n, plural, one {# message vérifié} other {# messages vérifiés}}, {changed, plural, one {# modifié} other {# modifiés}}.",
    "Could not open the rule editor": "Impossible d’ouvrir l’éditeur de règles",
    "Edit rule": "Modifier la règle",
    "New rule": "Nouvelle règle",
    "Condition {n} value": "Valeur de la condition {n}",
    "Text to look for": "Texte à rechercher",
    "Condition {n} field": "Champ de la condition {n}",
    "Condition {n} operator": "Opérateur de la condition {n}",
    "Remove condition {n}": "Retirer la condition {n}",
    "Action {n} folder": "Dossier de l’action {n}",
    "Choose…": "Choisir…",
    "A deleted category": "Une catégorie supprimée",
    "Action {n} category": "Catégorie de l’action {n}",
    "No categories yet": "Aucune catégorie pour l’instant",
    "Action {n} type": "Type de l’action {n}",
    "Remove action {n}": "Retirer l’action {n}",
    "Could not save the rule": "Impossible d’enregistrer la règle",
    "Rule saved": "Règle enregistrée",
    "From {address}": "Messages de {address}",
    "On {date}, {name} wrote:": "Le {date}, {name} a écrit :",
    "someone": "quelqu’un",
    "Begin forwarded message:": "Début du message transféré :",
    "From:": "De :",
    "Subject:": "Objet :",
    "Date:": "Date :",
    "To:": "À :",
    "Cc:": "Cc :",
    "Forward": "Transférer",
    "attachment {n}": "pièce jointe {n}",
    "Some attachments could not be read": "Certaines pièces jointes n’ont pas pu être lues",
    "Not attached, could not be fetched: {files}": "Impossible de récupérer et de joindre : {files}",
    "{n, plural, one {# attachment left behind — over 20 MB} other {# attachments left behind — over 20 MB}}": "{n, plural, one {# pièce jointe non incluse (plus de 20 Mo)} other {# pièces jointes non incluses (plus de 20 Mo)}}",
    "Reply": "Répondre",
    "Reply all": "Répondre à tous",
    "From": "De",
    "To": "À",
    "Cc": "Cc",
    "Bcc": "Cci",
    "Date": "Date",
    "Could not read this message": "Impossible de lire ce message",
    "message": "message",
    "Could not open the print dialog": "Impossible d’ouvrir la fenêtre d’impression",
    "The whole conversation ({n} messages)": "Toute la conversation ({n} messages)",
    "Could not reach the server — you are not unsubscribed": "Serveur injoignable : vous n’êtes pas désabonné",
    "Unsubscribed — the sender has been told": "Désabonnement effectué : l’expéditeur a été prévenu",
    "Open this sender's unsubscribe page?": "Ouvrir la page de désabonnement de cet expéditeur ?",
    "Open": "Ouvrir",
    "Unsubscribe by email?": "Se désabonner par e-mail ?",
    "This sender accepts only a message to {address}.": "Cet expéditeur n’accepte qu’un message envoyé à {address}.",
    "Write it": "Le rédiger",
    "Unsubscribe": "Se désabonner",
    "No unsubscribe option in this message": "Ce message ne propose aucun moyen de se désabonner",
    "Could not unsubscribe — the server refused": "Désabonnement impossible : le serveur a refusé",
    "Already fetching that one": "Téléchargement déjà en cours",
    "fetching…": "téléchargement…",
    "contains": "contient",
    "does not contain": "ne contient pas",
    "is": "est",
    "is not": "n’est pas",
    "starts with": "commence par",
    "ends with": "se termine par",
    "Subject": "Objet",
    "Text": "Texte",
    "Attachment name": "Nom de pièce jointe",
    "Has attachment": "Pièce jointe",
    "Yes": "Oui",
    "No": "Non",
    "Importance": "Importance",
    "High": "Haute",
    "Normal": "Normale",
    "Low": "Basse",
    "Move to folder": "Déplacer vers un dossier",
    "Add category": "Ajouter une catégorie",
    "Mark as read": "Marquer comme lu",
    "Pin": "Épingler",
    "Move to Trash": "Placer dans la corbeille",

    /* ── end page 2 ── */

    /* ── page 3 ── */

    /* ── end page 3 ── */

    /* ── page 4 ── */

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
