/**
 * The swipe table of the list (public/index.html): which action may be taken
 * on a row in which folder, and what a device's setting falls back to.
 */
import { eq, ok } from "./harness.mjs";
import { clientFns } from "./client-fns.mjs";

const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};
const { SWIPE_ACTIONS, swipeAllowed, swipeSetting } = clientFns(["SWIPE_ACTIONS", "swipeAllowed", "swipeSetting"], { localStorage });

const FOLDERS = ["inbox", "archive", "sent", "drafts", "spam", "trash", "Work", "Receipts/2026"];
const where = (action) => FOLDERS.filter((f) => swipeAllowed(action, f));

console.log("\n-- swipe : où chaque action est permise ---------");
{
  eq(where("archive"), ["inbox", "Work", "Receipts/2026"], "archiver : ni dans Archive, Brouillons, Envoyés, Corbeille, Spam");
  eq(where("delete"), ["inbox", "archive", "sent", "Work", "Receipts/2026"], "supprimer : pas dans Brouillons, Corbeille, Spam (là c'est définitif)");
  eq(where("read"), FOLDERS, "lu / non lu : partout");
  eq(where("star"), FOLDERS, "étoile : partout");
  eq(where("none"), [], "rien : nulle part, la ligne ne glisse pas");
  eq(where("teleport"), [], "une action inconnue n'est permise nulle part");
  eq(where(undefined), [], "pas d'action : nulle part");

  ok(swipeAllowed("archive", undefined) && swipeAllowed("archive", ""), "une ligne sans dossier est dans la boîte de réception");
  ok(!swipeAllowed("archive", "ARCHIVE") && !swipeAllowed("delete", "Trash"), "la casse du dossier ne change rien");
  eq(Object.keys(SWIPE_ACTIONS), ["none", "archive", "delete", "read", "star"], "les cinq choix du réglage");
}

console.log("\n-- swipe : le réglage de l'appareil ---------");
{
  eq([swipeSetting("right"), swipeSetting("left")], ["archive", "none"], "par défaut : à droite on archive, à gauche rien (comme avant)");
  localStorage.setItem("dmzs-swipe-right", "star");
  localStorage.setItem("dmzs-swipe-left", "delete");
  eq([swipeSetting("right"), swipeSetting("left")], ["star", "delete"], "le choix de l'appareil est lu");
  localStorage.setItem("dmzs-swipe-right", "constructor");
  localStorage.setItem("dmzs-swipe-left", "<img>");
  eq([swipeSetting("right"), swipeSetting("left")], ["archive", "none"], "une valeur inconnue retombe sur le défaut");
  const broken = { getItem: () => { throw new Error("blocked"); } };
  eq(clientFns(["SWIPE_ACTIONS", "swipeSetting"], { localStorage: broken }).swipeSetting("right"), "archive", "un stockage inaccessible retombe sur le défaut");
}
