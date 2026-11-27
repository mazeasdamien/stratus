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

    "This tab is running {client}, the server is on {server}": "Cet onglet est en {client}, le serveur en {server}",
    "Reload": "Recharger",
    "This folder is not saved on this device": "Ce dossier n’est pas enregistré sur cet appareil",
    "This conversation is not saved on this device": "Cette conversation n’est pas enregistrée sur cet appareil",
    "This message is not saved on this device": "Ce message n’est pas enregistré sur cet appareil",
    "That needs a connection": "Une connexion est nécessaire",
    "This needs a connection, and nothing was changed": "Une connexion est nécessaire ; rien n’a été modifié",
    "Offline copy, saved {when}. Attachments are not kept on this device.": "Copie hors connexion (enregistrée : {when}). Les pièces jointes ne sont pas conservées sur cet appareil.",
    "Offline copy, saved {when}. Changes need a connection.": "Copie hors connexion (enregistrée : {when}). Toute modification nécessite une connexion.",
    "Nothing is stored on this device.": "Rien n’est stocké sur cet appareil.",
    "Turned on. Nothing is stored yet.": "Activé. Rien n’est encore stocké.",
    "This device holds {messages, plural, one {# message} other {# messages}} and {lists, plural, one {# folder list} other {# folder lists}}, {size}.": "Cet appareil conserve {messages, plural, one {# message} other {# messages}} et {lists, plural, one {# liste de messages} other {# listes de messages}}, soit {size}.",
    "Offline mail is off, and removed from this device": "Messages hors connexion désactivés et retirés de cet appareil",
    "This browser did not make the storage permanent, so it may clear the copy when space runs short. It works until it does.": "Ce navigateur n’a pas rendu le stockage permanent : il pourra effacer la copie s’il manque de place. D’ici là, elle fonctionne.",
    "Offline mail removed from this device, and turned off": "Copie hors connexion retirée de cet appareil, et option désactivée",
    "Connect an account first": "Connectez d’abord un compte",
    "Your accounts could not be loaded — check the connection": "Impossible de charger vos comptes : vérifiez la connexion",
    "({n}) Mail": "({n}) Mail",
    "Mail": "Mail",
    "{n, plural, one {# account} other {# accounts}}": "{n, plural, one {# compte} other {# comptes}}",
    "{count} in all folders": "{count} dans tous les dossiers",
    "{n, plural, one {# unread} other {# unread}}": "{n, plural, one {# non lu} other {# non lus}}",
    "All read": "Tout est lu",
    "{n, plural, one {# needs attention} other {# need attention}}": "{n, plural, one {# compte à vérifier} other {# comptes à vérifier}}",
    "No account connected yet": "Aucun compte connecté pour l’instant",
    "Could not load your mail": "Impossible de charger vos messages",
    "All": "Tous",
    "reconnect needed": "reconnexion nécessaire",
    "error": "erreur",
    "never synced": "jamais synchronisé",
    "just now": "à l’instant",
    "{n} min ago": "il y a {n} min",
    "Default": "Par défaut",
    "Make default": "Définir par défaut",
    "Sync": "Synchroniser",
    "Remove": "Retirer",
    "Nothing yet — connect one below.": "Aucun compte pour l’instant : connectez-en un ci-dessous.",
    "Your accounts could not be loaded. Check the connection, then refresh.": "Impossible de charger vos comptes. Vérifiez la connexion, puis actualisez.",
    "Connect iCloud": "Connecter iCloud",
    "Reconnect iCloud": "Reconnecter iCloud",
    "Change the app password, or add another account": "Changer le mot de passe pour app ou ajouter un compte",
    "Archive [folder]": "Archive",
    "Sent [folder]": "Envoyés",
    "Drafts [folder]": "Brouillons",
    "Spam [folder]": "Indésirables",
    "Trash [folder]": "Corbeille",
    "Starred [view]": "Étoilés",
    "{n, plural, one {# unread elsewhere} other {# unread elsewhere}}": "{n, plural, one {# non lu ailleurs} other {# non lus ailleurs}}",
    "Rename": "Renommer",
    "Rename {folder}": "Renommer le dossier {folder}",
    "Delete": "Supprimer",
    "Delete {folder}": "Supprimer le dossier {folder}",
    "Empty [action]": "Vider",
    "Empty {folder}": "Vider le dossier {folder}",
    "{folder}, {n, plural, one {# message} other {# messages}}, {unread, plural, one {# unread} other {# unread}}": "{folder}, {n, plural, one {# message} other {# messages}}, dont {unread, plural, one {# non lu} other {# non lus}}",
    "{folder}, {n, plural, one {# message} other {# messages}}": "{folder}, {n, plural, one {# message} other {# messages}}",
    "Veille": "Veille",
    "Your folders": "Vos dossiers",
    "Done [editing]": "OK",
    "Edit": "Modifier",
    "That didn't work": "Cela n’a pas fonctionné",
    "New folder": "Nouveau dossier",
    "Name": "Nom",
    "Create": "Créer",
    "Created {folder}": "Dossier « {folder} » créé",
    "Rename \"{folder}\"": "Renommer « {folder} »",
    "Renamed [folder]": "Dossier renommé",
    "Delete the folder \"{folder}\"?": "Supprimer le dossier « {folder} » ?",
    "Its {n, plural, one {# message} other {# messages}} will be permanently deleted from iCloud too. This cannot be undone.": "{n, plural, one {Son message sera aussi supprimé définitivement d’iCloud.} other {Ses # messages seront aussi supprimés définitivement d’iCloud.}} Cette action est irréversible.",
    "This cannot be undone.": "Cette action est irréversible.",
    "Deleted {folder}": "Dossier « {folder} » supprimé",
    "{folder} is already empty": "Le dossier « {folder} » est déjà vide",
    "Permanently delete all {n, plural, one {# message} other {# messages}} in {folder}?": "Supprimer définitivement {n, plural, one {le message} other {les # messages}} du dossier « {folder} » ?",
    "They are removed from iCloud itself. This cannot be undone.": "La suppression a lieu sur iCloud même. Cette action est irréversible.",
    "{folder} emptied": "Dossier « {folder} » vidé",

    /* ── end page 1 ── */

    /* ── page 2 ── */

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
