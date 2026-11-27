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
    /* ── end page 5 ── */

    /* ── page 6 ── */

    /* ── end page 6 ── */

    /* ── page 7 ── */

    /* ── end page 7 ── */

    /* ── worker ── */

    /* ── end worker ── */
  },
});
