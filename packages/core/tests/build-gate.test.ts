import assert from "node:assert/strict";
import { test } from "node:test";

import { failOnTypeErrors, readerConfig } from "../../../rollup.reader.mjs";

/** Stand-in for rollup's default handler; records what was passed through. */
const collect = () => {
  const seen: unknown[] = [];
  return { seen, warn: (warning: unknown) => void seen.push(warning) };
};

test("readerConfig installs the failing warning handler", () => {
  assert.strictEqual(readerConfig().onwarn, failOnTypeErrors);
});

test("a TypeScript diagnostic fails the build instead of warning", () => {
  const { warn, seen } = collect();
  assert.throws(
    () => failOnTypeErrors({ plugin: "typescript", message: "TS2322: not assignable" }, warn),
    /TS2322/,
  );
  assert.deepStrictEqual(seen, []);
});

test("a TypeScript diagnostic inside a dependency is dropped, not fatal", () => {
  // `lzma1` ships its `.ts` sources as its `types` entry, so the strict flags
  // of whichever package imports it are applied to its code too. Those are not
  // ours to fix, and printing them on every build helps nobody.
  const { warn, seen } = collect();
  failOnTypeErrors(
    {
      plugin: "typescript",
      message: "TS2532: Object is possibly 'undefined'.",
      loc: { file: "/repo/node_modules/lzma1/src/decoder.ts", line: 215, column: 14 },
    },
    warn,
  );
  assert.deepStrictEqual(seen, []);
});

test("an unresolved import fails the build instead of warning", () => {
  const { warn, seen } = collect();
  assert.throws(
    () => failOnTypeErrors({ code: "UNRESOLVED_IMPORT", message: "node:fs is not resolved" }, warn),
    /node:fs/,
  );
  assert.deepStrictEqual(seen, []);
});

test("other warnings still reach rollup's handler", () => {
  const { warn, seen } = collect();
  const warning = { code: "EMPTY_BUNDLE", message: "Generated an empty chunk" };
  failOnTypeErrors(warning, warn);
  assert.deepStrictEqual(seen, [warning]);
});
