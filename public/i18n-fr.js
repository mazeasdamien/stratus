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

    "Kept": "Conservé",
    "Kept, without its pictures": "Conservé, sans les images",
    "Too large to keep here — saved on close": "Trop volumineux pour être conservé ici : enregistré à la fermeture",
    "Draft": "Brouillon",
    "Bcc": "Cci",
    "Not saved to Drafts: {reason}": "Non enregistré dans Brouillons : {reason}",
    "Not kept with it — attach again: {files}": "Pièces jointes non conservées, joignez-les à nouveau : {files}",
    "Saving…": "Enregistrement…",
    "the server refused it": "le serveur l’a refusé",
    "Apple would not keep a copy: {reason}": "Apple n’a pas voulu en garder une copie : {reason}",
    "unknown reason": "raison inconnue",
    "Saved to Drafts": "Enregistré dans Brouillons",
    "Draft kept in this browser only — {reason}": "Brouillon conservé dans ce navigateur uniquement : {reason}",
    "Draft saved": "Brouillon enregistré",
    "Throw this draft away?": "Supprimer ce brouillon ?",
    "It is not kept anywhere after this.": "Il ne sera plus conservé nulle part.",
    "Discard": "Supprimer",
    "Unfinished message — not saved to Drafts: {reason}": "Message inachevé, non enregistré dans Brouillons : {reason}",
    "An unfinished message was kept": "Un message inachevé a été conservé",
    "Resume": "Reprendre",
    "Asking iCloud…": "Interrogation d’iCloud…",
    "Could not check": "Vérification impossible",
    "Nothing filed under Sent has your own address on it": "Aucun message des Envoyés ne porte votre propre adresse",
    "{n, plural, one {Checked # message, and it is not in your inbox at iCloud} other {Checked # messages, and none of them is in your inbox at iCloud}}": "{n, plural, one {# message vérifié : il n’est pas dans votre boîte de réception iCloud} other {# messages vérifiés : aucun n’est dans votre boîte de réception iCloud}}",
    "{n, plural, one {Moved # message back to the inbox} other {Moved # messages back to the inbox}}, {left} left: press again": "{n, plural, one {# message remis dans la boîte de réception} other {# messages remis dans la boîte de réception}}, il en reste {left} : appuyez de nouveau",
    "{n, plural, one {Moved # message back to the inbox} other {Moved # messages back to the inbox}}": "{n, plural, one {# message remis dans la boîte de réception} other {# messages remis dans la boîte de réception}}",
    "Last snapshot {when}: {n, plural, one {# message} other {# messages}}, {size} KB.": "Dernière sauvegarde : {when}, {n, plural, one {# message} other {# messages}}, {size} Ko.",
    "No snapshot yet. The first one is taken tonight, or now.": "Aucune sauvegarde pour l’instant. La première sera faite cette nuit, ou maintenant.",
    "The last attempt failed ({when}): {reason}": "La dernière tentative a échoué ({when}) : {reason}",
    "Snapshot taken": "Sauvegarde effectuée",
    "Could not take a snapshot": "Impossible d’effectuer la sauvegarde",
    "Restore from the last snapshot?": "Restaurer la dernière sauvegarde ?",
    "Rows missing from the database come back from the snapshot. Nothing that exists now is changed or removed.": "Les lignes absentes de la base de données sont reprises de la sauvegarde. Rien de ce qui existe aujourd’hui n’est modifié ni supprimé.",
    "Restore": "Restaurer",
    "Could not restore": "Restauration impossible",
    "There is no snapshot to restore from": "Aucune sauvegarde à restaurer",
    "{n, plural, one {Restored # missing row} other {Restored # missing rows}}": "{n, plural, one {# ligne manquante restaurée} other {# lignes manquantes restaurées}}",
    "Nothing was missing": "Rien ne manquait",
    "Checking with Apple…": "Vérification auprès d’Apple…",
    "Connect": "Connecter",
    "Could not connect": "Connexion impossible",
    "iCloud connected — fetching your newest mail": "iCloud connecté : récupération de vos messages les plus récents",
    "Hide": "Masquer",
    "Show": "Afficher",
    "Default account changed": "Compte par défaut modifié",
    "Syncing…": "Synchronisation…",
    "Could not reach iCloud": "Impossible de joindre iCloud",
    "Already syncing — new mail will appear in a moment": "Synchronisation déjà en cours : les nouveaux messages vont apparaître dans un instant",
    "{n, plural, one {# new message} other {# new messages}}": "{n, plural, one {# nouveau message} other {# nouveaux messages}}",
    "Up to date": "À jour",
    "Disconnect {email}?": "Déconnecter {email} ?",
    "Disconnect this account?": "Déconnecter ce compte ?",
    "Its stored messages here are deleted too. Mail at the provider is untouched, and reconnecting re-downloads it.": "Les messages enregistrés ici sont supprimés eux aussi. Ceux du fournisseur restent intacts, et ils sont téléchargés de nouveau si vous reconnectez le compte.",
    "Disconnect": "Déconnecter",
    "Could not disconnect — nothing was removed": "Déconnexion impossible : rien n’a été supprimé",
    "Removed {email}": "Compte {email} supprimé",
    "Account removed": "Compte supprimé",
    "Send": "Envoyer",
    "Reply": "Répondre",
    "New message": "Nouveau message",

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
