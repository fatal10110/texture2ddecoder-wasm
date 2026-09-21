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
 */
export function readerConfig({ browser = true, external = [] } = {}) {
  return {
    input: "./src/index.ts",
    output: [
      { file: "dist/index.cjs", format: "cjs", sourcemap: true, exports: "named" },
      { file: "dist/index.mjs", format: "es", sourcemap: true },
    ],
    external: [...WORKSPACE_EXTERNAL, ...external],
    plugins: [
      resolve({ browser, preferBuiltins: !browser }),
      typescript({ tsconfig: "./tsconfig.json", outputToFilesystem: true }),
    ],
  };
}
