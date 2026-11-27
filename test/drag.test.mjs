/**
 * Which folders a drag of rows offers as drop targets (public/index.html).
 */
import { eq } from "./harness.mjs";
import { clientFns } from "./client-fns.mjs";

const { dropTargets } = clientFns(["dropTargets"]);
const all = ["inbox", "archive", "sent", "drafts", "trash", "Work"].map((folder) => ({ folder }));
const names = (rows) => dropTargets(rows, all).map((f) => f.folder);

console.log("\n-- glisser : dossiers proposés ---------");
eq(names([{ folder: "inbox" }]), ["archive", "sent", "drafts", "trash", "Work"], "un message de la boîte de réception : tous sauf elle");
eq(names([{ folder: "inbox" }, { folder: "inbox" }]), ["archive", "sent", "drafts", "trash", "Work"], "plusieurs du même dossier : tous sauf lui");
eq(names([{ folder: "inbox" }, { folder: "Work" }]), all.map((f) => f.folder), "de dossiers différents : tous, aucun n'est « là où ils sont »");
eq(names([{}]), ["archive", "sent", "drafts", "trash", "Work"], "une ligne sans dossier est dans la boîte de réception");
eq(names([]), all.map((f) => f.folder), "rien à porter : tous (la bande ne s'ouvre pas sans ligne)");
