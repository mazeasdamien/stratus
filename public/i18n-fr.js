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

    /* ── end page 5 ── */

    /* ── page 6 ── */

    /* ── end page 6 ── */

    /* ── page 7 ── */

    "Loading…": "Chargement…",
    "Delete": "Supprimer",
    "Save": "Enregistrer",
    "Cancel": "Annuler",
    "Name": "Nom",
    "Close": "Fermer",
    "Create": "Créer",
    "React with an emoji": "Réagir avec un emoji",
    "New event": "Nouvel événement",
    "Event": "Événement",
    "Edit event": "Modifier l’événement",
    "All day": "Toute la journée",
    "Calendars": "Calendriers",
    "New calendar": "Nouveau calendrier",
    "Subscribe": "S’abonner",
    "Calendar options": "Options du calendrier",
    "Agenda": "Agenda",
    "Day": "Jour",
    "Week": "Semaine",
    "Month": "Mois",
    "Previous": "Précédent",
    "Next": "Suivant",
    "Today": "Aujourd’hui",
    "Tomorrow": "Demain",
    "Yesterday": "Hier",
    "View": "Affichage",
    "Options": "Options",
    "Could not load your calendar": "Impossible de charger votre calendrier",
    "The server did not answer. Check the connection.": "Le serveur n’a pas répondu. Vérifiez la connexion.",
    "Try again": "Réessayer",
    "Calendar · could not be loaded": "Calendrier · chargement impossible",
    "Calendar · {n, plural, one {# event} other {# events}}": "Calendrier · {n, plural, one {# événement} other {# événements}}",
    "{date}, all day": "{date}, toute la journée",
    "No title": "Sans titre",
    "(No title)": "(Sans titre)",
    "repeats": "récurrent",
    "cancelled": "annulé",
    "Cancelled: {title}": "Annulé : {title}",
    "all-day": "journée",
    "{n, plural, one {+# more} other {+# more}}": "{n, plural, one {+# autre} other {+# autres}}",
    "Nothing planned": "Rien de prévu",
    "Nothing in the next 30 days. Make an event with the + button, or subscribe to a calendar.": "Rien dans les 30 prochains jours. Créez un événement avec le bouton +, ou abonnez-vous à un calendrier.",
    "Accepted": "Accepté",
    "Declined": "Refusé",
    "Maybe": "Peut-être",
    "Accept": "Accepter",
    "Decline": "Refuser",
    "Join · {host}": "Rejoindre · {host}",
    "Organised by {name}": "Organisé par {name}",
    "Show the next 30 days": "Afficher les 30 jours suivants",
    "Change a repeating event": "Modifier un événement récurrent",
    "Move this one, or every event in the series?": "Déplacer celui-ci seulement, ou tous les événements de la série ?",
    "Could not move that": "Impossible de déplacer l’événement",
    "No reminder": "Aucun rappel",
    "At the time of the event": "À l’heure de l’événement",
    "5 minutes before": "5 minutes avant",
    "10 minutes before": "10 minutes avant",
    "15 minutes before": "15 minutes avant",
    "30 minutes before": "30 minutes avant",
    "1 hour before": "1 heure avant",
    "2 hours before": "2 heures avant",
    "1 day before": "1 jour avant",
    "2 days before": "2 jours avant",
    "On the day, at 9:00": "Le jour même, à 9 h",
    "The day before, at 9:00": "La veille, à 9 h",
    "2 days before, at 9:00": "2 jours avant, à 9 h",
    "A week before, at 9:00": "Une semaine avant, à 9 h",
    "{n, plural, one {# minute before} other {# minutes before}}": "{n, plural, one {# minute avant} other {# minutes avant}}",
    "On the first {weekday}": "Le premier {weekday} du mois",
    "On the second {weekday}": "Le deuxième {weekday} du mois",
    "On the third {weekday}": "Le troisième {weekday} du mois",
    "On the fourth {weekday}": "Le quatrième {weekday} du mois",
    "On the last {weekday}": "Le dernier {weekday} du mois",
    "{day, plural, other {On day #}}": "{day, plural, =1 {Le 1er du mois} other {Le # du mois}}",
    "{n, plural, one {day} other {days}}": "{n, plural, one {jour} other {jours}}",
    "{n, plural, one {week} other {weeks}}": "{n, plural, one {semaine} other {semaines}}",
    "{n, plural, one {month} other {months}}": "{n, plural, one {mois} other {mois}}",
    "{n, plural, one {year} other {years}}": "{n, plural, one {an} other {ans}}",
    "Could not open that event": "Impossible d’ouvrir cet événement",
    "From the subscribed calendar “{name}”. It is read-only here.": "Cet événement vient du calendrier « {name} », auquel vous êtes abonné. Il est ici en lecture seule.",
    "Pick a start and an end": "Choisissez un début et une fin",
    "The event cannot end before it starts": "L’événement ne peut pas se terminer avant d’avoir commencé",
    "Change this event only, or every event in the series?": "Modifier cet événement seulement, ou tous les événements de la série ?",
    "Could not save that": "Impossible d’enregistrer les modifications",
    "Event added": "Événement ajouté",
    "Event saved": "Événement enregistré",
    "Delete a repeating event": "Supprimer un événement récurrent",
    "Delete this event only, or every event in the series?": "Supprimer cet événement seulement, ou tous les événements de la série ?",
    "Delete this event?": "Supprimer cet événement ?",
    "It is removed from your calendar.": "Il sera retiré de votre calendrier.",
    "Could not delete that": "Impossible de supprimer",
    "Event deleted": "Événement supprimé",
    "not fetched yet": "pas encore chargé",
    "just now": "à l’instant",
    "{n} min ago": "il y a {n} min",
    "{n} h ago": "il y a {n} h",
    "{n} d ago": "il y a {n} j",
    "Check for changes every": "Fréquence de mise à jour",
    "{n} minutes": "Toutes les {n} minutes",
    "hour": "Toutes les heures",
    "{n} hours": "Toutes les {n} heures",
    "day": "Tous les jours",
    "Colour": "Couleur",
    "Subscribed · {when}": "Abonnement · {when}",
    "From your mail": "Depuis vos messages",
    "Show {name}": "Afficher {name}",
    "Calendar name": "Nom du calendrier",
    "New address (leave empty to keep the saved one)": "Nouvelle adresse (laisser vide pour garder l’actuelle)",
    "New address": "Nouvelle adresse",
    "Refresh now": "Actualiser maintenant",
    "Import .ics": "Importer un .ics",
    "Export .ics": "Exporter en .ics",
    "Subscribe to a calendar": "S’abonner à un calendrier",
    "A calendar on the web, from an https:// or webcal:// address. It is read-only here, and the address is kept private on the server.": "Un calendrier publié sur le web, à une adresse https:// ou webcal://. Il est ici en lecture seule, et son adresse reste privée sur le serveur.",
    "https:// or webcal://": "https:// ou webcal://",
    "Calendar address": "Adresse du calendrier",
    "Could not import that file": "Impossible d’importer ce fichier",
    "{n, plural, one {Imported # event} other {Imported # events}}": "{n, plural, one {# événement importé} other {# événements importés}}",
    "{n, plural, one {# left out} other {# left out}}": "{n, plural, one {# ignoré} other {# ignorés}}",
    "{n, plural, one {# repeat not kept} other {# repeats not kept}}": "{n, plural, one {# répétition non conservée} other {# répétitions non conservées}}",
    "Up to date": "À jour",
    "Could not refresh": "Impossible d’actualiser",
    "Delete “{name}”?": "Supprimer « {name} » ?",
    "Its events are deleted with it. This cannot be undone.": "Ses événements seront supprimés avec lui. Cette action est irréversible.",
    "Could not make that calendar": "Impossible de créer ce calendrier",
    "Subscribed, but {error}": "Abonnement ajouté, mais {error}",
    "{n, plural, one {Subscribed, # event} other {Subscribed, # events}}": "{n, plural, one {Abonnement ajouté : # événement} other {Abonnement ajouté : # événements}}",
    "Calendar added": "Calendrier ajouté",
    "That event is gone": "Cet événement n’existe plus",
    "Could not add that to your calendar": "Impossible d’ajouter cet événement à votre calendrier",
    "Added to {calendar}": "Ajouté à « {calendar} »",
    "Removed again": "Ajout annulé",
    "Thumbs up": "Pouce levé",
    "Heart": "Cœur",
    "Celebration": "Fête",
    "Laughing": "Rire",
    "Surprised": "Surprise",
    "Sad": "Tristesse",
    "Goes to {to} from {from}, as a reply in this conversation.": "Sera envoyée à {to} depuis {from}, en réponse dans cette conversation.",
    "Goes to {to}, as a reply in this conversation.": "Sera envoyée à {to}, en réponse dans cette conversation.",
    "The previous message is still going out — try again in a moment": "Le message précédent est encore en cours d’envoi. Réessayez dans un instant.",

    /* ── end page 7 ── */

    /* ── worker ── */

    /* ── end worker ── */
  },
});
