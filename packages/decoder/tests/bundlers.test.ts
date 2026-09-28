// How bundlers see the built package (#171). A browser bundle must leave the Node.js glue out
// (its `import("module")` failed the Next.js build), a Node.js bundle keeps it, and the
// wasmPath import stays a native import() in every bundler. Reads dist/, so it needs
// `npm run build:rollup` first.
import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rollup } from "rollup";
import resolve from "@rollup/plugin-node-resolve";

const dist = (file: string) => new URL(`../dist/${file}`, import.meta.url);

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
