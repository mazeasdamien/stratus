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
    "Cc": "Cc",
    "Insert link": "Insérer un lien",
    "Insert": "Insérer",
    "Links must start with http:// or https://": "Un lien doit commencer par http:// ou https://",
    "Write something first": "Écrivez d’abord quelque chose",
    "AI failed": "L’assistant a échoué",
    "The message changed while the assistant was working — nothing was replaced": "Le message a changé pendant que l’assistant travaillait : rien n’a été remplacé",
    "Selection rewritten": "Sélection reformulée",
    "Rewritten": "Message reformulé",
    "Selection corrected": "Sélection corrigée",
    "Corrected": "Message corrigé",
    "Open a message and press Reply first": "Ouvrez d’abord un message et appuyez sur Répondre",
    "Nothing to reply to": "Rien à quoi répondre",
    "Reply written — read it before sending": "Réponse rédigée : relisez-la avant de l’envoyer",
    "Remove": "Retirer",
    "None yet. Tap Images on a message, then Always, to add its sender.": "Aucun pour l’instant. Touchez « Images » sur un message, puis « Toujours », pour ajouter son expéditeur.",
    "Could not trust this sender": "Impossible d’autoriser cet expéditeur",
    "Could not remove this sender": "Impossible de retirer cet expéditeur",
    "Images from {email} will load": "Les images de {email} seront chargées",
    "Images from {email} will wait to be asked for": "Les images de {email} attendront votre demande",
    "Sign out every other device?": "Déconnecter tous les autres appareils ?",
    "Every other phone and browser, and the Chrome extension, will need the activation link again. This one stays signed in.": "Les autres téléphones et navigateurs, ainsi que l’extension Chrome, auront de nouveau besoin du lien d’activation. Cet appareil reste connecté.",
    "Sign out the others": "Déconnecter les autres",
    "Every other device is signed out": "Tous les autres appareils sont déconnectés",
    "Could not sign the other devices out": "Impossible de déconnecter les autres appareils",
    "No signature": "Aucune signature",
    "Custom": "Personnalisée",
    "Replace the signature you edited?": "Remplacer la signature modifiée ?",
    "You changed the signature in this message. Choosing another one replaces your changes.": "Vous avez modifié la signature de ce message. En choisir une autre remplacera vos modifications.",
    "Replace": "Remplacer",
    "{n, plural, one {# signature} other {# signatures}}: {names}": "{n, plural, one {# signature} other {# signatures}} : {names}",
    "No signature yet.": "Aucune signature pour l’instant.",
    "Empty": "Vide",
    "Edit": "Modifier",
    "Edit {name}": "Modifier {name}",
    "Rename": "Renommer",
    "Rename {name}": "Renommer {name}",
    "Delete": "Supprimer",
    "Delete {name}": "Supprimer {name}",
    "New mail": "Nouveaux messages",
    "Signature for new mail from {address}": "Signature des nouveaux messages envoyés depuis {address}",
    "Replies": "Réponses",
    "Signature for replies from {address}": "Signature des réponses envoyées depuis {address}",
    "Edit signature": "Modifier la signature",
    "New signature": "Nouvelle signature",
    "Rename the signature": "Renommer la signature",
    "Could not rename the signature": "Impossible de renommer la signature",
    "Delete “{name}”?": "Supprimer « {name} » ?",
    "Addresses that sign with it will sign with nothing. Messages already sent keep what they went with.": "Les adresses qui l’utilisent n’auront plus de signature. Les messages déjà envoyés gardent celle qu’ils avaient.",
    "Could not delete the signature": "Impossible de supprimer la signature",
    "Could not save that choice": "Impossible d’enregistrer ce choix",
    "Saved": "Enregistré",
    "Give the signature a name": "Donnez un nom à la signature",
    "Could not save the signature": "Impossible d’enregistrer la signature",
    "Signature saved": "Signature enregistrée",
    "Signature added": "Signature ajoutée",
    "Checking…": "Vérification…",
    "Could not read the current setting.": "Impossible de lire le réglage actuel.",
    "Ends {tail} — type a new key to replace it": "Se termine par {tail} : saisissez une nouvelle clé pour la remplacer",
    "Paste an Anthropic API key": "Collez une clé d’API Anthropic",
    "Set here, ending {tail}.": "Définie ici, se termine par {tail}.",
    "Using the deployed key, ending {tail}. Anything saved here replaces it.": "Clé du déploiement utilisée, se termine par {tail}. Une clé enregistrée ici la remplace.",
    "No key set — Write reply, Fix spelling and Improve will say so when you press them.": "Aucune clé définie : « Rédiger la réponse », « Corriger » et « Améliorer » vous le signaleront quand vous appuierez dessus.",
    "{model} is not on this key — {suggestion} is.": "{model} n’est pas disponible avec cette clé ; {suggestion} l’est.",
    "{model} is not on this key.": "{model} n’est pas disponible avec cette clé.",
    "Asking Anthropic…": "Interrogation d’Anthropic…",
    "Anthropic says: {reason}": "Réponse d’Anthropic : {reason}",
    "Could not reach Anthropic": "Impossible de joindre Anthropic",
    "Key works. {n, plural, one {# model on it} other {# models on it}}, and {model} is one of them.": "La clé fonctionne. {n, plural, one {# modèle disponible} other {# modèles disponibles}}, dont {model}.",
    "Key works, but {model} is not on it — {suggestion} is.": "La clé fonctionne, mais {model} n’est pas disponible avec elle ; {suggestion} l’est.",
    "Key works, but {model} is not on it.": "La clé fonctionne, mais {model} n’est pas disponible avec elle.",
    "Could not change the model": "Impossible de changer de modèle",
    "Writing with {model}": "Rédaction avec {model}",
    "Checking with Anthropic…": "Vérification auprès d’Anthropic…",
    "Removing…": "Suppression…",
    "Could not save that key": "Impossible d’enregistrer cette clé",
    "AI key saved": "Clé de l’assistant enregistrée",
    "Removed — back to the deployed key": "Clé supprimée : retour à la clé du déploiement",
    "AI key removed": "Clé de l’assistant supprimée",
    "Paste a key first — or use Remove, below, to clear the one stored.": "Collez d’abord une clé, ou utilisez le bouton de suppression ci-dessous pour effacer celle qui est enregistrée.",
    "Notifications unsupported here": "Notifications non prises en charge ici",
    "Notifications on — tap to turn off": "Notifications activées : touchez pour les désactiver",
    "Notifications blocked in browser settings": "Notifications bloquées dans les réglages du navigateur",
    "Enable notifications": "Activer les notifications",
    "Could not send a test": "Impossible d’envoyer un test",
    "No device is registered — tap Enable notifications first": "Aucun appareil inscrit : touchez d’abord « Activer les notifications »",
    "Pushed to {sent}/{devices} — but nothing is unread, so there is no badge to show": "Notification envoyée à {sent}/{devices}, mais aucun message non lu : pas de pastille à afficher",
    "{devices, plural, one {Pushed to {sent}/# device} other {Pushed to {sent}/# devices}} · badge should read {unread}": "{devices, plural, one {Notification envoyée à {sent}/# appareil} other {Notification envoyée à {sent}/# appareils}} · la pastille devrait afficher {unread}",
    "Turn notifications on here first": "Activez d’abord les notifications ici",
    "Could not clear the other registrations": "Impossible de supprimer les autres inscriptions",
    "{n, plural, one {Removed # other registration} other {Removed # other registrations}}: this device is the only one now": "{n, plural, one {# autre inscription supprimée} other {# autres inscriptions supprimées}} : cet appareil est désormais le seul",
    "This device was already the only one": "Cet appareil était déjà le seul",
    "Notifications off": "Notifications désactivées",
    "Permission refused": "Autorisation refusée",
    "Notifications on": "Notifications activées",
    "Could not register this device": "Impossible d’inscrire cet appareil",
    "Could not enable notifications": "Impossible d’activer les notifications",
    "{n} B": "{n} o",
    "{n} KB": "{n} Ko",
    "{n} MB": "{n} Mo",
    "Remove {name}": "Retirer {name}",
    "{name} would push this over 20 MB": "{name} ferait dépasser la limite de 20 Mo",
    "Could not read that file": "Impossible de lire ce fichier",
    "{n, plural, one {# attachment added} other {# attachments added}}": "{n, plural, one {# pièce jointe ajoutée} other {# pièces jointes ajoutées}}",
    "Could not read that image": "Impossible de lire cette image",

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
