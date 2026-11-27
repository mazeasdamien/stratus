/**
 * The assertions test.mjs counts with, shared so a file under test/ adds to
 * the same totals and the same exit code instead of keeping its own.
 *
 * A test file is test/<anything>.test.mjs. test.mjs imports each one after its
 * own checks, so a file only has to import { ok, eq } from "./harness.mjs" and
 * assert at the top level (top-level await is fine).
 */
let pass = 0;
let fail = 0;

export const ok = (cond, label) => {
  if (cond) { pass++; }
  else { fail++; console.log(`  ✗ ${label}`); }
};

export const eq = (a, b, label) =>
  ok(JSON.stringify(a) === JSON.stringify(b), `${label} — reçu ${JSON.stringify(a)}, attendu ${JSON.stringify(b)}`);

export const counts = () => ({ pass, fail });
