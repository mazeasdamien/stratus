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

    "Reminders, {n} due": "Rappels, {n} en attente",
    "Reminders": "Rappels",
    "10 min": "10 min",
    "Snooze for 10 minutes": "Reporter de 10 minutes",
    "1 hour": "1 h",
    "Snooze for 1 hour": "Reporter d’une heure",
    "Tomorrow": "Demain",
    "Snooze until tomorrow morning": "Reporter à demain matin",
    "Nothing is due.": "Aucun rappel en attente.",
    "Reminder": "Rappel",
    "Due {when}": "Échéance : {when}",
    "Open": "Ouvrir",
    "Dismiss": "Ignorer",
    "Snooze": "Reporter",
    "Could not open that": "Impossible d’ouvrir cet élément",
    "That didn't work": "Cela n’a pas fonctionné",
    "Snoozed until {when}": "Reporté au {when}",
    "Dismissed": "Ignoré",
    "Tasks": "Tâches",
    "Today": "Aujourd’hui",
    "Yesterday": "Hier",
    "{day}, {time}": "{day} à {time}",
    "Overdue": "En retard",
    "Upcoming": "À venir",
    "No date": "Sans date",
    "Done": "Terminées",
    "Done {when}": "Terminée le {when}",
    "Important": "Important",
    "Mark not done: {title}": "Marquer comme non terminée : {title}",
    "Mark done: {title}": "Marquer comme terminée : {title}",
    "Open message": "Ouvrir le message",
    "Tasks, {n} due": "Tâches, {n} à faire",
    "Tasks · could not be loaded": "Tâches · chargement impossible",
    "Tasks · {n} due": "Tâches · {n} à faire",
    "Could not load your tasks": "Impossible de charger vos tâches",
    "Try again": "Réessayer",
    "Nothing to do": "Rien à faire",
    "Add a task above, or choose Add to tasks on any message.": "Ajoutez une tâche ci-dessus, ou choisissez «  Ajouter aux tâches  » dans n’importe quel message.",
    "Clear completed": "Effacer les terminées",
    "Could not add that task": "Impossible d’ajouter cette tâche",
    "Task added": "Tâche ajoutée",
    "Could not update that task": "Impossible de mettre à jour cette tâche",
    "Task done": "Tâche terminée",
    "Task reopened": "Tâche rouverte",
    "That task is gone": "Cette tâche n’existe plus",
    "(no subject)": "(sans objet)",
    "A task needs a title": "Une tâche doit avoir un titre",
    "Could not save that task": "Impossible d’enregistrer cette tâche",
    "Could not delete that task": "Impossible de supprimer cette tâche",
    "Task deleted": "Tâche supprimée",
    "Clear completed tasks?": "Effacer les tâches terminées ?",
    "{n, plural, one {# done task will be deleted.} other {# done tasks will be deleted.}} This cannot be undone.": "{n, plural, one {# tâche terminée sera supprimée.} other {# tâches terminées seront supprimées.}} Cette action est irréversible.",
    "Clear": "Effacer",
    "Cleared": "Tâches effacées",
    "Could not clear them": "Impossible de les effacer",
    "Add to tasks": "Ajouter aux tâches",
    "Added to tasks": "Ajouté aux tâches",
    "No reply by {when}": "Réponse attendue · {when}",
    "Overdue · {when}": "En retard · {when}",
    "Follow up · {when}": "Relance · {when}",
    "Follow-up overdue": "Relance en retard",
    "Waiting for a reply until {when}": "Réponse attendue, échéance {when}",
    "Follow up, due {when}": "Relance, échéance {when}",
    "Follow up": "Relance",
    "Follow up: be reminded about this message": "Relance : recevoir un rappel pour ce message",
    "Follow-up": "Relance",
    "Follow up, overdue since {when}": "Relance en retard depuis le {when}",
    "Follow up, no reply by {when}": "Relance si personne n’a répondu d’ici le {when}",
    "Follow up, {when}": "Relance le {when}",
    "Overdue.": "En retard.",
    "Nobody has replied since you sent this. The reminder was due {when}.": "Personne n’a répondu depuis votre envoi. Le rappel était prévu le {when}.",
    "Waiting for a reply.": "En attente de réponse.",
    "You will be reminded {when} if nobody has answered by then.": "Vous recevrez un rappel le {when} si personne n’a répondu d’ici là.",
    "You wanted to follow up on this {when}.": "Vous vouliez revenir sur ce message le {when}.",
    "Change": "Modifier",
    "Mark complete": "Marquer comme terminée",
    "Later today": "Plus tard aujourd’hui",
    "Tomorrow morning": "Demain matin",
    "Next week": "La semaine prochaine",
    "Now: no reply by {when} (overdue).": "Aucune réponse reçue au {when} (en retard).",
    "Now: no reply by {when}.": "Rappel le {when} si personne n’a répondu.",
    "Now: {when} (overdue).": "Prévue le {when} (en retard).",
    "Now: {when}.": "Prévue le {when}.",
    "Starred on every device, and a reminder when the time comes.": "Une étoile sur tous vos appareils, et un rappel le moment venu.",
    "{n, plural, one {# day} other {# days}}": "{n, plural, one {# jour} other {# jours}}",
    "Pick a time at least a minute from now": "Choisissez un moment au moins une minute après l’heure actuelle",
    "Could not set the follow-up": "Impossible de programmer la relance",
    "Follow up {when}": "Relance le {when}",
    "Reminder {when}, unless somebody replies": "Rappel le {when}, sauf si quelqu’un répond",
    "Could not mark it complete": "Impossible de terminer cette relance",
    "Marked complete": "Relance terminée",
    "Remind me if nobody replies": "Me le rappeler si personne ne répond",
    "No": "Non",
    "After {n, plural, one {# day} other {# days}}": "{n, plural, one {Après # jour} other {Après # jours}}",
    "On a date…": "À une date…",
    "Date and time to be reminded if nobody has replied": "Date et heure du rappel si personne n’a répondu",
    "Pick a reminder time that is still ahead": "Choisissez une heure de rappel à venir",
    ", but the reminder could not be set": ", mais le rappel n’a pas pu être programmé",

    /* ── end page 6 ── */

    /* ── page 7 ── */

    /* ── end page 7 ── */

    /* ── worker ── */

    /* ── end worker ── */
  },
});
