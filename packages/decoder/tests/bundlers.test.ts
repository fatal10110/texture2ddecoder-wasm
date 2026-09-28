// How bundlers see the built package (#171). A browser bundle must leave the Node.js glue out
// (its `import("module")` failed the Next.js build), a Node.js bundle keeps it, and the
// wasmPath import stays a native import() in every bundler. The glue must also run the way a
// webpack server bundle runs it (#202). Reads dist/ and wasm/, so it needs
// `npm run build:rollup` and `npm run build:wasm` first.
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rollup } from "rollup";
import resolve from "@rollup/plugin-node-resolve";

const dist = (file: string) => new URL(`../dist/${file}`, import.meta.url);
const wasm = (file: string) => new URL(`../wasm/${file}`, import.meta.url);

/** Bundle dist/index.mjs into one chunk, resolving like a browser or a Node.js bundler. */
async function bundle(browser: boolean): Promise<string> {
  const build = await rollup({
    input: fileURLToPath(dist("index.mjs")),
    plugins: [resolve({ browser, preferBuiltins: !browser })],
    external: ["module"],
    onwarn: () => {},
  });
  const { output } = await build.generate({ format: "es", inlineDynamicImports: true });
  await build.close();
  return output[0].code;
}

// A line only the Emscripten glue has.
const GLUE = /createRequire/;

describe("bundling the built package", () => {
  it("a browser bundle leaves the Node.js glue out", async () => {
    assert.doesNotMatch(await bundle(true), GLUE);
  });

  it("a Node.js bundle keeps the Node.js glue", async () => {
    assert.match(await bundle(false), GLUE);
  });

  for (const file of ["index.mjs", "index.cjs"]) {
    it(`dist/${file} keeps the bundler hints on the wasmPath import`, () => {
      const code = readFileSync(dist(file), "utf8");
      assert.match(
        code,
        /import\(\s*\/\* webpackIgnore: true \*\/ \/\* turbopackIgnore: true \*\/ \/\* @vite-ignore \*\/\s*\w+\)/,
      );
    });
  }
});

/** The Emscripten module factory, with the one decode function the test calls. */
type CreateModule = (config: {
  locateFile: (path: string) => string;
}) => Promise<{ decode_bc1(data: Uint8Array, width: number, height: number): ArrayLike<number> }>;

/** Import a glue file by URL; the variable specifier keeps TypeScript from resolving it. */
async function importGlue(url: URL): Promise<CreateModule> {
  return (await import(url.href)).default;
}

/**
 * Import a copy of the Emscripten glue whose `import("module")` resolves to what webpack gives
 * it in a server bundle (#202). webpack keeps "module" as `require("module")` and wraps the
 * export in a namespace object that copies the export's own properties only when it is an
 * object. The export is a function (`Module`), so the namespace holds `default` only.
 */
async function importGlueAsWebpack(): Promise<CreateModule> {
  const parts = readFileSync(wasm("texture2ddecoder.js"), "utf8").split('import("module")');
  assert.strictEqual(parts.length, 2, 'the glue has one import("module")');
  const dir = mkdtempSync(join(tmpdir(), "texture2ddecoder-webpack-"));
  try {
    const file = join(dir, "texture2ddecoder.mjs");
    // Not `Module`: the glue declares its own.
    const glue = parts.join("Promise.resolve({ default: nodeModuleExport })");
    writeFileSync(file, `import nodeModuleExport from "module";\n${glue}`);
    return await importGlue(pathToFileURL(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the Node.js glue in a webpack server bundle", () => {
  it('initializes and decodes when import("module") has only a default export', async () => {
    const locateFile = (path: string) => fileURLToPath(wasm(path));
    // One BC1 block: red and blue endpoints, all four indices.
    const block = new Uint8Array([0x00, 0xf8, 0x1f, 0x00, 0xe4, 0x1b, 0x4e, 0xb1]);
    const webpack = await (await importGlueAsWebpack())({ locateFile });
    const native = await (await importGlue(wasm("texture2ddecoder.js")))({ locateFile });
    const expected = Array.from(native.decode_bc1(block, 4, 4));
    assert.strictEqual(expected.length, 4 * 4 * 4);
    assert.deepStrictEqual(Array.from(webpack.decode_bc1(block, 4, 4)), expected);
  });
});
