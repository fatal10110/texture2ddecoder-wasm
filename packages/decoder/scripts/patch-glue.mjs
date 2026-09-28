// Patches the Emscripten glue that build-wasm.sh generates (#202). Run by build-wasm.sh.
//
// In Node.js the glue gets `require` with `const{createRequire}=await import("module")`. When
// webpack bundles the glue for a server (a Next.js route handler, `next build --webpack`), it
// keeps "module" as an external `require("module")` and wraps it in a namespace object that has
// the export's own properties only when the export is an object. Node's "module" exports a
// function (`Module`), so the namespace holds only `default`, and `createRequire` is undefined.
// The patched glue takes `createRequire` from `default` when the namespace lacks it.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const GLUE = fileURLToPath(new URL("../wasm/texture2ddecoder.js", import.meta.url));

/** What emsdk 4.0.7 emits (EXPORT_ES6, ENVIRONMENT includes node). */
const FROM = 'const{createRequire}=await import("module");';

/** The same import, with `createRequire` also looked up on the default export. */
const TO =
  'const nodeModule=await import("module");' +
  "const createRequire=nodeModule.createRequire||nodeModule.default.createRequire;";

const glue = readFileSync(GLUE, "utf8");
const count = glue.split(FROM).length - 1;
if (count !== 1) {
  console.error(
    `patch-glue: expected 1 \`${FROM}\` in ${GLUE}, found ${count}. ` +
      "Did the emsdk version in build-wasm.sh change? Update scripts/patch-glue.mjs to match.",
  );
  process.exit(1);
}
writeFileSync(GLUE, glue.replace(FROM, TO));
console.log(`✓ Patched ${GLUE}: createRequire for webpack server bundles (#202)`);
