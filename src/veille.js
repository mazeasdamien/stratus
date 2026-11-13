/**
 * The Veille section: the weekly digest, read inside the mail app.
 *
 * The digests live in the dmzs-digest Worker (its KV archive). This app shows
 * them under its own sign-in, so the pages are only ever reachable by an
 * activated device: the request is passed on through a service binding with a
 * shared secret (DIGEST_READER_TOKEN, set by dmzs-digest/agent/setup.py
 * --reader), and the answer comes back unchanged, its own CSP included.
 *
 *   GET  /veille, /veille/e/<id>, /veille/couts  →  /reader/…
 *   POST /api/veille/feedback                    →  /reader/api/feedback
 */

const PAGE = /^\/veille(\/|\/e\/[0-9a-f]{32}\/?|\/couts\/?)?$/;

export const isVeillePage = (path) => PAGE.test(path);
export const isVeilleApi = (path) => path === "/api/veille/feedback";

function unavailable(why, status = 503) {
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Veille</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 16px">
<p><a href="/">Retour au mail</a></p><h1 style="font-size:22px">La veille n'est pas joignable</h1><p>${why}</p></body>`;
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function proxyVeille(request, env, path) {
  const api = path.startsWith("/api/");
  if (!env.DIGEST || !env.DIGEST_READER_TOKEN) {
    const why = "La liaison avec dmzs-digest n'est pas configurée : lance <code>python agent/setup.py --reader</code> dans dmzs-digest, puis redéploie l'appli mail.";
    return api ? Response.json({ error: "Veille not configured" }, { status: 503 }) : unavailable(why);
  }
  const target = new URL("https://dmzs-digest/reader" + (api ? "/api/" + path.slice("/api/veille/".length) : path.slice("/veille".length)));
  const init = {
    method: request.method,
    headers: { Authorization: `Bearer ${env.DIGEST_READER_TOKEN}`, "Content-Type": request.headers.get("Content-Type") || "application/json" },
  };
  if (request.method === "POST") init.body = await request.text();
  let res;
  try {
    res = await env.DIGEST.fetch(new Request(target, init));
  } catch (err) {
    console.error(JSON.stringify({ message: "veille_proxy_failed", error: String(err?.message || err) }));
    return api ? Response.json({ error: "Veille unreachable" }, { status: 502 }) : unavailable("Le service de la veille ne répond pas. Réessaie dans un moment.", 502);
  }
  if (res.status === 401) {
    return api ? Response.json({ error: "Veille token mismatch" }, { status: 502 })
      : unavailable("Le jeton partagé ne correspond plus : relance <code>python agent/setup.py --reader</code> dans dmzs-digest.", 502);
  }
  // Only the headers that describe the page travel back.
  const out = new Headers();
  for (const h of ["Content-Type", "Content-Security-Policy", "Cache-Control", "Referrer-Policy", "X-Content-Type-Options"]) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(res.body, { status: res.status, headers: out });
}
