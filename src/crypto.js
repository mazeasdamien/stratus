/**
 * Sealing stored credentials before they touch D1.
 *
 * AES-256-GCM with a key that lives only as a Worker secret (ENC_KEY,
 * 32 random bytes, base64). A dump of the database therefore contains
 * ciphertext, not an iCloud app-specific password. The IV rides in
 * front of the ciphertext; GCM authenticates, so tampering reads as null.
 */

import { b64decode, b64encode } from "./mime.js";

/**
 * ENC_KEY as `npm run secrets` writes it is 32 random bytes in base64, used as
 * is — as is any string that decodes to a valid AES key length, which is
 * exactly the set that ever worked before. Anything else — a passphrase typed
 * into the Deploy to Cloudflare form — is hashed to 32 bytes, so any string
 * works and the same string always gives the same key.
 */
async function rawKey(secret) {
  const s = String(secret ?? "");
  let bytes = null;
  try {
    bytes = b64decode(s);
  } catch {
    bytes = null;
  }
  if (bytes && [16, 24, 32].includes(bytes.length)) return bytes;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

async function keyOf(secretB64) {
  return crypto.subtle.importKey("raw", await rawKey(secretB64), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Object → opaque base64 string. */
export async function seal(secretB64, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyOf(secretB64), data)
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64encode(out);
}

/** Opaque base64 string → object, or null when the key or blob is wrong. */
export async function open(secretB64, blob) {
  try {
    const raw = b64decode(blob);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: raw.slice(0, 12) },
      await keyOf(secretB64),
      raw.slice(12)
    );
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    return null;
  }
}
