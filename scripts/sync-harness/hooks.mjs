const STUBS = {
  "cloudflare:sockets": "./sockets-stub.mjs",
  "cloudflare:workers": "./workers-stub.mjs",
};

export async function resolve(specifier, context, next) {
  if (STUBS[specifier]) {
    return { url: new URL(STUBS[specifier], import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
