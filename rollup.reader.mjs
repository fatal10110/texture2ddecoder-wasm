import resolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import { readFileSync } from "node:fs";

/**
 * Externals of a reader package, read from its own manifest: every declared
 * `dependencies` and `peerDependencies` entry, and its subpaths.
 *
 * One rule for workspace siblings and npm deps alike (#71). `dist/` keeps the
 * bare `import`, npm resolves it at install time, so a dep is never both
 * inlined in the published output and installed next to it: no second copy, no
 * bundled copy that a `npm audit fix` of a decompressor cannot reach, and no
 * per-dep NOTICE obligation. Anything *not* declared is bundled - an import of
 * an undeclared package is a build error (`UNRESOLVED_IMPORT`, or a resolved
 * copy of a devDependency), which is what it should be.
 *
 * CDN consumers therefore need an import map or a CDN ESM endpoint
 * (`/+esm`, esm.sh) - still zero bundler, and already required by
 * `unity-asset-reader-texture`, whose `texture2ddecoder-wasm` import is
 * external either way (D6, D7).
 *
 * @param {string} manifest path to the package's `package.json`
 * @returns {RegExp[]} one `^name(/|$)` matcher per declared dependency
 * @throws {Error} if the manifest is missing or not JSON
 */
export function declaredDependencies(manifest = "./package.json") {
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  const names = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ];
  return names.map((name) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\/|$)`));
}

/**
 * Build the rollup config for one reader package. Run from the package
 * directory, it emits `dist/index.mjs`, `dist/index.cjs` and, through
 * `emitDeclarationOnly` in the package tsconfig, `dist/index.d.ts`.
 *
 * @param {object} [options]
 * @param {boolean} [options.browser] Resolve the `browser` condition and refuse
 *   node builtins. True for `core` and `texture` (R4); false for `node`.
 * @param {(string | RegExp)[]} [options.external] Extra externals on top of the
 *   declared dependencies, e.g. node builtins for `unity-asset-reader-node`.
 * @returns {import("rollup").RollupOptions} config for `rollup -c`
 * @throws {Error} during the build, on a TypeScript diagnostic or an unresolved
 *   import — see {@link failOnTypeErrors}.
 */
export function readerConfig({ browser = true, external = [] } = {}) {
  return {
    input: "./src/index.ts",
    output: [
      { file: "dist/index.cjs", format: "cjs", exports: "named" },
      { file: "dist/index.mjs", format: "es" },
    ],
    external: [...declaredDependencies(), ...external],
    onwarn: failOnTypeErrors,
    plugins: [
      resolve({ browser, preferBuiltins: !browser }),
      typescript({ tsconfig: "./tsconfig.json", outputToFilesystem: true }),
    ],
  };
}

/**
 * Rollup `onwarn` handler that turns two warning classes into build failures.
 *
 * `@rollup/plugin-typescript` reports type errors through `this.warn`, so
 * without this the strict compiler set is advisory: a build with a type error
 * still writes `dist/` and exits 0. `UNRESOLVED_IMPORT` is the matching leak on
 * the module side - an unlisted `node:*` import would otherwise survive into
 * the bundle of a browser-safe package (R4).
 *
 * @param {import("rollup").RollupLog} warning the warning rollup raised
 * @param {(warning: import("rollup").RollupLog) => void} warn rollup's default handler
 * @throws {Error} when the warning is a type error or an unresolved import
 */
export function failOnTypeErrors(warning, warn) {
  if (warning.plugin === "typescript" || warning.code === "UNRESOLVED_IMPORT") {
    throw new Error(warning.message);
  }
  warn(warning);
}
