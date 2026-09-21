import resolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

/**
 * Workspace packages that are never bundled into a reader package: the shared
 * core is a peer dependency (one instance per app, D7) and the decoder ships
 * its own WASM loader.
 */
const WORKSPACE_EXTERNAL = [/^unity-asset-reader(\/|$)/, /^texture2ddecoder-wasm(\/|$)/];

/**
 * Build the rollup config for one reader package. Run from the package
 * directory, it emits `dist/index.mjs`, `dist/index.cjs` and, through
 * `emitDeclarationOnly` in the package tsconfig, `dist/index.d.ts`.
 *
 * @param {object} [options]
 * @param {boolean} [options.browser] Resolve the `browser` condition and refuse
 *   node builtins. True for `core` and `texture` (R4); false for `node`.
 * @param {(string | RegExp)[]} [options.external] Extra externals on top of the
 *   workspace packages, e.g. node builtins for `unity-asset-reader-node`.
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
    external: [...WORKSPACE_EXTERNAL, ...external],
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
