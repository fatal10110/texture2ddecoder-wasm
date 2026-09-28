// `load()`'s inputs (#183): one input or an array, bare bytes or
// `{ name, data }`, and the default name a nameless input gets.

import assert from "node:assert/strict";
import { test } from "node:test";

import { golden, loadFixture, sha256 } from "../../../fixtures/helpers.js";
import { load } from "../src/env.js";
import { ResourceNotFoundError } from "../src/errors.js";

const BUNDLE = "editor/6000.3.25f1/lz4/texture";

/** The golden file hashes, as `env.files` must reproduce them. */
const expectedFiles = (name: string) =>
  Object.entries(golden(name).files).map(([path, { sha256 }]) => ({ path, sha256 }));
const hashes = (files: { path: string; data: Uint8Array }[]) =>
  files.map(({ path, data }) => ({ path, sha256: sha256(data) }));

test("one bundle as bare bytes: a Uint8Array or an ArrayBuffer", () => {
  const bytes = loadFixture(BUNDLE);
  assert.deepStrictEqual(hashes(load(bytes).files), expectedFiles(BUNDLE));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  assert.deepStrictEqual(hashes(load(buffer).files), expectedFiles(BUNDLE));
});

test("one input with or without a name, and the old array form, give the same env", () => {
  const data = loadFixture(BUNDLE);
  const expected = expectedFiles(BUNDLE);
  assert.deepStrictEqual(hashes(load({ name: "texture.bundle", data }).files), expected);
  assert.deepStrictEqual(hashes(load({ data }).files), expected);
  assert.deepStrictEqual(hashes(load([{ name: "texture.bundle", data }]).files), expected);
});

test("a nameless input is called input <index>, in paths and in errors", () => {
  const loose = new Uint8Array([1, 2, 3]);
  const env = load([loose, { data: loose }, { name: "named.bin", data: loose }]);
  assert.deepStrictEqual(
    env.files.map((f) => f.path),
    ["input 0", "input 1", "named.bin"],
  );
  // A container's errors name the input it was found in.
  const broken = loadFixture(BUNDLE).subarray(0, 64);
  assert.throws(() => load([loose, broken]), { message: /^input 1: / });
});

test("loose files are matched by their real name", () => {
  const { files } = load(loadFixture(BUNDLE));
  const [serialized, resS] = files;
  assert.ok(serialized && resS && resS.path.endsWith(".resS"));

  // Named as Unity named them: the texture finds its .resS.
  const named = load([
    { name: serialized.path, data: serialized.data },
    { name: resS.path, data: resS.data },
  ]);
  const [texture] = named.assets("Texture2D");
  const { imageData } = texture!.data;
  assert.equal(imageData.length, 64);

  // Bare bytes are "input 0" and "input 1": the .resS is not found by name.
  const nameless = load([serialized.data, resS.data]);
  const [unnamed] = nameless.assets("Texture2D");
  assert.throws(() => unnamed!.data, ResourceNotFoundError);
});

test("an input that is neither bytes nor { name, data } is refused", () => {
  // @ts-expect-error - not a load() input
  assert.throws(() => load("a.bundle"), /input 0: expected a Uint8Array/);
  // @ts-expect-error - not a load() input
  assert.throws(() => load([{ name: "a", data: "bytes" }]), /a: expected a Uint8Array/);
});
