/**
 * The rules of "Offline mail" in public/index.html that need no browser: what
 * a request is, when the saved copy answers it, and what is evicted when the
 * copy is over its limits. The IndexedDB store and the page around it are
 * driven by the scenarios in scripts/ui-harness.
 */
import { eq, ok } from "./harness.mjs";
import { clientFns } from "./client-fns.mjs";

const { OFFLINE_EXEMPT, offlineClass, offlineChoice, offlineEvict } = clientFns(
  ["OFFLINE_EXEMPT", "offlineClass", "offlineChoice", "offlineEvict"]
);

console.log("\n-- hors ligne : ce qu'est une requête ---------");
{
  eq(offlineClass("/api/messages?folder=inbox&limit=51"), { what: "list", key: "list:|inbox" }, "la première page d'un dossier est gardée");
  eq(offlineClass("/api/messages?folder=Work&limit=51&account=a1").key, "list:a1|Work", "un filtre de compte donne sa propre copie");
  eq(offlineClass("/api/messages?limit=51").key, "list:|inbox", "sans dossier c'est la boîte de réception");
  eq(offlineClass("/api/messages?folder=inbox&before=5&before_id=m3").what, "live", "« plus anciens » n'est pas gardé");
  eq(offlineClass("/api/messages?folder=all&q=facture").what, "live", "une recherche n'est pas gardée");
  eq(offlineClass("/api/messages?folder=all&starred=1").what, "live", "les messages suivis ne sont pas gardés");
  eq(offlineClass("/api/messages?thread=t-m1"), { what: "thread", key: "thread:t-m1" }, "une conversation est gardée");
  eq(offlineClass("/api/messages/abc123"), { what: "msg", key: "msg:abc123", peek: false }, "un message est gardé");
  eq(offlineClass("/api/messages/abc123?peek=1").peek, true, "peek=1 est reconnu");
  eq(["/api/messages/abc123/attachment/0", "/api/messages/abc123/eml", "/api/messages/abc123/attachments.zip"].map((p) => offlineClass(p).what), ["other", "other", "other"], "les pièces jointes et l'export ne sont jamais gardés");
  eq([offlineClass("/api/accounts").key, offlineClass("/api/folders").key], ["meta:accounts", "meta:folders"], "les comptes et les noms de dossiers suivent la liste");
  eq(offlineClass("/api/messages/abc123/flag", "POST").what, "change", "marquer est un changement");
  eq(offlineClass("/api/send", "POST").what, "change", "envoyer est un changement");
  eq(offlineClass("/api/thread", "post").what, "change", "la méthode se lit sans tenir compte de la casse");
  eq(["/api/draft", "/api/draft/%3Cp1%40x%3E"].map((p) => offlineClass(p, p === "/api/draft" ? "POST" : "DELETE").what), ["other", "other"], "un brouillon garde sa propre copie locale : pas un changement à refuser");
  ok(!OFFLINE_EXEMPT.test("/api/drafts-by-hand"), "l'exemption ne déborde pas sur un autre chemin");
  eq(offlineClass("/api/signature").what, "other", "le reste n'est pas concerné");
}

console.log("\n-- hors ligne : servir la copie ou non ---------");
{
  const c = (enabled, failed, what, stored) => offlineChoice({ enabled, failed, what, stored });
  for (const what of ["list", "thread", "msg", "meta", "live", "change", "other"]) {
    eq(c(false, true, what, true), "network", `réglage éteint, connexion perdue, copie présente (${what}) : jamais la copie`);
    eq(c(true, false, what, true), "network", `réglage allumé, la requête a abouti (${what}) : le serveur gagne`);
  }
  eq(["list", "thread", "msg"].map((w) => c(true, true, w, true)), ["copy", "copy", "copy"], "hors ligne, avec une copie : la copie");
  eq(["list", "thread", "msg"].map((w) => c(true, true, w, false)), ["miss", "miss", "miss"], "hors ligne, sans copie : on le dit");
  eq([c(true, true, "meta", true), c(true, true, "meta", false)], ["copy", "network"], "les comptes : la copie, ou l'échec d'avant");
  eq(c(true, true, "live", false), "miss", "une recherche hors ligne : on le dit");
  eq([c(true, true, "change", true), c(true, true, "change", false)], ["refuse", "refuse"], "un changement hors ligne est refusé, copie ou pas");
  eq(c(true, true, "other", true), "network", "ce qui n'est pas du courrier échoue comme avant");
}

console.log("\n-- hors ligne : l'éviction ---------");
{
  const L = { maxItems: 3, maxBytes: 100, maxEntry: 60 };
  const e = (k, bytes, at) => ({ k, bytes, at });
  eq(offlineEvict([e("a", 10, 1), e("b", 10, 2), e("c", 10, 3)], L), [], "dans les limites : rien ne part");
  eq(offlineEvict([e("a", 10, 1), e("b", 10, 2), e("c", 10, 3), e("d", 10, 4)], L), ["a"], "trop d'éléments : le plus ancien part");
  eq(offlineEvict([e("d", 10, 4), e("a", 10, 1), e("c", 10, 3), e("b", 10, 2), e("e", 10, 5)], L), ["a", "b"], "l'ordre d'arrivée ne compte pas, la date d'enregistrement oui");
  eq(offlineEvict([e("a", 50, 1), e("b", 50, 2), e("c", 50, 3)], L), ["a"], "trop d'octets : le plus ancien part, puis on s'arrête dès que ça tient");
  eq(offlineEvict([e("a", 40, 1), e("b", 40, 2), e("c", 40, 3)], { ...L, maxBytes: 70 }), ["a", "b"], "il part autant d'anciens qu'il faut pour que ça tienne");
  eq(offlineEvict([e("a", 10, 1), e("b", 10, 2), e("big", 90, 3)], L), ["big"], "un message plus gros que la limite par message part seul, sans vider le reste");
  eq(offlineEvict([e("a", 10, 1), e("big", 500, 2)], { maxItems: 9, maxBytes: 100, maxEntry: 1000 }), ["big"], "un message plus gros que tout le budget part seul aussi");
  eq(offlineEvict([e("a", 60, 1), e("b", 60, 2)], L), ["a"], "deux messages à la limite : le plus ancien cède la place");
  eq(offlineEvict([e("x", 10, 7), e("y", 10, 7), e("z", 10, 7), e("w", 10, 7)], L), ["w"], "à date égale, l'ordre est stable");
  eq(offlineEvict([], L), [], "une copie vide ne perd rien");
  const input = [e("b", 10, 2), e("a", 10, 1), e("c", 10, 3), e("d", 10, 4)];
  offlineEvict(input, L);
  eq(input.map((x) => x.k), ["b", "a", "c", "d"], "la liste donnée n'est pas modifiée");
}
