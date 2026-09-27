import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "../..");
const read = (path) => readFileSync(join(root, path), "utf8");

/** Upstream project URLs of the `Name -- https://...` stanzas in a NOTICE. */
function upstreams(notice) {
  return [...notice.matchAll(/^\S.* -- (https:\/\/\S+)/gm)].map((m) => m[1]);
}

// The per-package NOTICE files are authoritative (#75); the root one must not
// drop an upstream any of them names.
test("root NOTICE names every upstream of the per-package NOTICE files", () => {
  const rootNotice = read("NOTICE");
  const rootUpstreams = new Set(upstreams(rootNotice));
  for (const pkg of ["core", "texture", "node"]) {
    const named = upstreams(read(`packages/${pkg}/NOTICE`));
    assert.ok(named.length > 0, `packages/${pkg}/NOTICE lists no upstream`);
    for (const url of named) {
      // The decoder is a workspace package, not an upstream; the root NOTICE
      // points at its LICENSE instead. Its URL is this repo's until the rename (plan D8).
      if (url.endsWith("/fatal10110/texture2ddecoder-wasm")) continue;
      assert.ok(rootUpstreams.has(url), `root NOTICE is missing ${url} (packages/${pkg}/NOTICE)`);
    }
  }
});

test("root NOTICE points at every per-package notice file", () => {
  const rootNotice = read("NOTICE");
  for (const path of [
    "packages/core/NOTICE",
    "packages/texture/NOTICE",
    "packages/node/NOTICE",
    "packages/decoder/LICENSE",
  ]) {
    assert.ok(rootNotice.includes(path), `root NOTICE does not mention ${path}`);
  }
});
