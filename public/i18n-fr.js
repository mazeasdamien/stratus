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

    /* ── end page 4 ── */

    /* ── page 5 ── */

    "Could not open this conversation": "Impossible d’ouvrir cette conversation",
    "Delete these {n} drafts?": "Supprimer ces {n} brouillons ?",
    "Delete this draft?": "Supprimer ce brouillon ?",
    "Every copy in this conversation goes, here and at iCloud. This cannot be undone, and nothing is sent.": "Toutes les copies de cette conversation sont supprimées, ici et sur iCloud. C’est irréversible, et rien n’est envoyé.",
    "It is removed here and at iCloud. This cannot be undone.": "Il est supprimé ici et sur iCloud. C’est irréversible.",
    "Delete": "Supprimer",
    "Could not delete this draft": "Impossible de supprimer ce brouillon",
    "{n} drafts deleted": "{n} brouillons supprimés",
    "Draft deleted": "Brouillon supprimé",
    "Could not open this draft": "Impossible d’ouvrir ce brouillon",
    "Draft": "Brouillon",
    "Bcc": "Cci",
    "{n, plural, one {# attachment not carried over — attach again before sending. The original draft keeps it.} other {# attachments not carried over — attach again before sending. The original draft keeps them.}}": "{n, plural, one {# pièce jointe n’a pas été reprise : joignez-la de nouveau avant d’envoyer. Le brouillon d’origine la conserve.} other {# pièces jointes n’ont pas été reprises : joignez-les de nouveau avant d’envoyer. Le brouillon d’origine les conserve.}}",
    "Could not reach iCloud": "Impossible de joindre iCloud",
    "Already syncing — new mail will appear in a moment": "Synchronisation déjà en cours : les nouveaux messages arrivent dans un instant",
    "{n, plural, one {# new message} other {# new messages}}": "{n, plural, one {# nouveau message} other {# nouveaux messages}}",
    "Up to date": "À jour",
    "Could not save": "Impossible d’enregistrer",
    "{n, plural, one {Saved — # other address} other {Saved — # other addresses}}": "{n, plural, one {Enregistré : # autre adresse} other {Enregistré : # autres adresses}}",
    "Saved": "Enregistré",
    "{day}, all day": "{day}, toute la journée",
    "{day}, {time}": "{day} à {time}",
    "Accept": "Accepter",
    "Maybe": "Peut-être",
    "Decline": "Refuser",
    "Add to calendar": "Ajouter au calendrier",
    "Download .ics": "Télécharger le .ics",
    "Join meeting · {host}": "Rejoindre la réunion · {host}",
    "{name} accepted": "{name} a accepté",
    "{name} might come": "{name} viendra peut-être",
    "{name} declined": "{name} a refusé",
    "{name} answered": "{name} a répondu",
    "Cancelled: {title}": "Annulé : {title}",
    "Invitation": "Invitation",
    "Organised by {name}": "Organisé par {name}",
    "Accepting": "Acceptation…",
    "Answering maybe": "Réponse « peut-être »…",
    "Declining": "Refus…",
    "Accepted — the organiser has been told": "Accepté : l’organisateur a été prévenu",
    "Answered maybe": "Réponse « peut-être » envoyée",
    "Declined — the organiser has been told": "Refusé : l’organisateur a été prévenu",
    "Not sent — the organiser has not been told": "Non envoyé : l’organisateur n’a pas été prévenu",
    "Could not send the answer": "Impossible d’envoyer la réponse",
    "Mail": "Mail",
    "Calendar": "Calendrier",
    "Loading meetings…": "Chargement des réunions…",
    "Today": "Aujourd’hui",
    "Tomorrow": "Demain",
    "Yesterday": "Hier",
    "Reading the conversation…": "Lecture de la conversation…",
    "Could not summarize": "Impossible de résumer",
    "Pick a time at least a minute from now": "Choisissez une heure dans une minute au moins",
    "Could not snooze": "Impossible de reporter ce message",
    "Snoozed until {when}": "Reporté jusqu’à {when}",
    "Downloading the original message…": "Téléchargement du message d’origine…",
    "Nothing else for this message.": "Rien d’autre pour ce message.",
    "Remove {address}": "Retirer {address}",
    "No name": "Sans nom",
    "People · could not be loaded": "Contacts · chargement impossible",
    "{n, plural, one {People · # contact} other {People · # contacts}}": "{n, plural, one {Contacts · # contact} other {Contacts · # contacts}}",
    "Loading…": "Chargement…",
    "Could not load your contacts": "Impossible de charger vos contacts",
    "The server did not answer.": "Le serveur n’a pas répondu.",
    "Try again": "Réessayer",
    "No contacts yet": "Aucun contact pour l’instant",
    "Add someone with the + above, bring a .vcf file in with Import, or add a sender from a message you are reading.": "Ajoutez quelqu’un avec le + ci-dessus, importez un fichier .vcf avec Importer, ou ajoutez l’expéditeur d’un message que vous lisez.",
    "No one matches": "Aucun résultat",
    "Nothing here goes by “{term}”.": "Personne ne correspond à « {term} ».",
    "People": "Contacts",
    "Email": "E-mail",
    "Work": "Travail",
    "Home": "Domicile",
    "Other": "Autre",
    "Phone": "Téléphone",
    "Mobile": "Portable",
    "Fax": "Fax",
    "email": "e-mail",
    "phone": "téléphone",
    "Write to {address}": "Écrire à {address}",
    "Show mail from {address}": "Afficher les messages de {address}",
    "Mail from this address": "Messages de cette adresse",
    "Call {number}": "Appeler le {number}",
    "Mail with this person": "Messages de cette personne",
    "Export .vcf": "Exporter le .vcf",
    "address": "adresse",
    "birthday": "anniversaire",
    "notes": "notes",
    "Delete {name}?": "Supprimer {name} ?",
    "The card is removed from People. Mail to and from them stays where it is.": "La fiche est retirée de Contacts. Les messages échangés avec cette personne restent où ils sont.",
    "Could not delete this contact": "Impossible de supprimer ce contact",
    "Deleted {name}": "Contact supprimé : {name}",
    "Could not bring it back": "Impossible de rétablir le contact",
    "Email address type": "Type d’adresse e-mail",
    "Phone number type": "Type de numéro de téléphone",
    "Email address": "Adresse e-mail",
    "Phone number": "Numéro de téléphone",
    "name@example.com": "nom@exemple.com",
    "Remove this email address": "Retirer cette adresse e-mail",
    "Remove this phone number": "Retirer ce numéro de téléphone",
    "Edit contact": "Modifier le contact",
    "New contact": "Nouveau contact",
    "Write the birthday as year-month-day, like 1990-04-23.": "Écrivez la date d’anniversaire sous la forme année-mois-jour, par exemple 1990-04-23.",
    "Could not save this contact.": "Impossible d’enregistrer ce contact.",
    "Added {name}": "Contact ajouté : {name}",
    "{file} is larger than 5 MB, which is more than an address book needs.": "{file} dépasse 5 Mo, bien plus qu’il n’en faut pour un carnet d’adresses.",
    "Importing {file}…": "Importation de {file}…",
    "{file}: {error}": "{file} : {error}",
    "{file}: could not be imported.": "{file} : importation impossible.",
    "{file}: no contacts found in it.": "{file} : aucun contact trouvé.",
    "{file}: {added, plural, one {# added} other {# added}}, {updated, plural, one {# updated} other {# updated}}, {skipped, plural, one {# skipped} other {# skipped}}.": "{file} : {added, plural, one {# ajouté} other {# ajoutés}}, {updated, plural, one {# mis à jour} other {# mis à jour}}, {skipped, plural, one {# ignoré} other {# ignorés}}.",
    "Imported: {added, plural, one {# added} other {# added}}, {updated, plural, one {# updated} other {# updated}}, {skipped, plural, one {# skipped} other {# skipped}}": "Importation terminée : {added, plural, one {# ajouté} other {# ajoutés}}, {updated, plural, one {# mis à jour} other {# mis à jour}}, {skipped, plural, one {# ignoré} other {# ignorés}}",
    "Nothing": "Rien",
    "Archive": "Archiver",
    "Mark read": "Lu",
    "Mark unread": "Non lu",
    "Star": "Étoile",
    "Unstar": "Retirer l’étoile",
    "Archived": "Archivé",
    "Deleted": "Supprimé",
    "Starred": "Étoile ajoutée",
    "Unstarred": "Étoile retirée",
    "Could not star this message": "Impossible d’ajouter une étoile à ce message",
    "Could not remove the star": "Impossible de retirer l’étoile",
    "Marked read": "Marqué comme lu",
    "Marked unread": "Marqué comme non lu",
    "Could not mark it read": "Impossible de le marquer comme lu",
    "Could not mark it unread": "Impossible de le marquer comme non lu",
    "Moved to {folder}": "Déplacé vers {folder}",
    "Moved {n} messages to {folder}": "{n} messages déplacés vers {folder}",
    "{n, plural, one {# message} other {# messages}}": "{n, plural, one {# message} other {# messages}}",
    "Drop {n} messages on a folder · Esc cancels": "Déposez les {n} messages sur un dossier · Échap pour annuler",
    "Drop on a folder to move it · Esc cancels": "Déposez sur un dossier pour déplacer · Échap pour annuler",
    "{n, plural, one {# selected} other {# selected}}": "{n, plural, one {# sélectionné} other {# sélectionnés}}",
    "{n} messages archived": "{n} messages archivés",
    "{n} messages deleted": "{n} messages supprimés",
    "Delete these {n} messages?": "Supprimer ces {n} messages ?",
    "Delete this message?": "Supprimer ce message ?",
    "They are moved to Trash at iCloud. Undo is offered on the next single action, not on a batch.": "Ils sont placés dans la Corbeille sur iCloud. L’annulation n’est proposée que pour une action sur un seul message, pas pour un lot.",
    "Filed at the provider, not just here.": "Rangé chez votre fournisseur de messagerie, pas seulement ici.",
    /* ── end page 5 ── */

    /* ── page 6 ── */

    /* ── end page 6 ── */

    /* ── page 7 ── */

    /* ── end page 7 ── */

    /* ── worker ── */

    /* ── end worker ── */
  },
});
