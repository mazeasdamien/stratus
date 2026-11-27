/**
 * Pure functions cut out of the shipped client script, for test files under
 * test/. test.mjs does the same for its own checks; this is the version a test
 * file can import without importing test.mjs, which runs them all.
 *
 * What is tested is the code that is deployed, not a copy that could drift.
 * A declaration is found by name and ends where the file's own layout ends it:
 * a function on a brace in the first column, a constant on a semicolon followed
 * by a blank line.
 */
import { readFileSync } from "node:fs";

const script = readFileSync(new URL("../public/index.html", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n")
  .split("<script>")[1]
  .split("</script>")[0];

function decl(name) {
  const at = script.search(new RegExp(`^(?:async )?(?:function ${name}\\b|const ${name} = )`, "m"));
  if (at < 0) throw new Error(`not in the client: ${name}`);
  const rest = script.slice(at);
  const end = rest.startsWith("const") ? rest.indexOf(";\n") + 1 : rest.indexOf("\n}\n") + 2;
  if (end <= 1) throw new Error(`no end to the declaration: ${name}`);
  return rest.slice(0, end);
}

/** These declarations, with what they expect around them passed in. */
export function clientFns(names, globals = {}) {
  const keys = Object.keys(globals);
  const src = names.map(decl).join("\n");
  return new Function(...keys, `${src}\nreturn { ${names.join(", ")} };`)(...keys.map((k) => globals[k]));
}
