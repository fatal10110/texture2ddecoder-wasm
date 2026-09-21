import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { CorruptError, UnsupportedError } from "../src/errors.js";

test("UnsupportedError names the kind and the offending value", () => {
  const error = new UnsupportedError("compression type", "LZHAM");
  assert.equal(error.message, "unsupported compression type: LZHAM");
  assert.equal(error.kind, "compression type");
  assert.equal(error.found, "LZHAM");
});

test("UnsupportedError keeps a numeric value readable", () => {
  assert.equal(new UnsupportedError("format version", 9).message, "unsupported format version: 9");
});

test("UnsupportedError appends a hint when given one", () => {
  const error = new UnsupportedError("container", "UnityArchive", "no upstream implementation");
  assert.equal(error.message, "unsupported container: UnityArchive (no upstream implementation)");
});

test("the two error types are distinguishable after throw/catch (R9)", () => {
  for (const [thrown, isUnsupported] of [
    [new UnsupportedError("compression type", "brotli"), true],
    [new CorruptError("block wrote 10 bytes but expected 12"), false],
  ] as const) {
    try {
      throw thrown;
    } catch (caught) {
      assert.ok(caught instanceof Error);
      assert.equal(caught instanceof UnsupportedError, isUnsupported);
      assert.equal(caught instanceof CorruptError, !isUnsupported);
    }
  }
});

test("both carry a name that survives into stack traces", () => {
  assert.equal(new UnsupportedError("signature", "x").name, "UnsupportedError");
  assert.equal(new CorruptError("truncated").name, "CorruptError");
  assert.match(String(new CorruptError("truncated")), /^CorruptError: truncated$/);
  assert.match(new UnsupportedError("signature", "x").stack ?? "", /UnsupportedError/);
});

test("instanceof still holds through the built ESM entry point", async () => {
  const dist = fileURLToPath(new URL("../dist/index.mjs", import.meta.url));
  const built = (await import(dist)) as typeof import("../src/index.js");
  const error = new built.UnsupportedError("compression type", "LZHAM");
  assert.ok(error instanceof built.UnsupportedError);
  assert.ok(error instanceof Error);
  assert.equal(error.message, "unsupported compression type: LZHAM");
});
