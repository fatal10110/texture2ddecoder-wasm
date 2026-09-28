// decodeImage and images() load the WASM decoder themselves (#185). Its own
// file, so its own process: nothing here calls initTexture().

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { load, type Asset } from "unity-asset-reader";
import { golden, loadFixture, reverseRows, sha256 } from "../../../fixtures/helpers.js";
import { decodeTexture2D } from "../src/decode.js";
import { decodeImage, images } from "../src/image.js";

// As in decode.test.ts (#119).
const WASM = "decoder/wasm/texture2ddecoder.wasm";
const skip = existsSync(fileURLToPath(new URL(`../../${WASM}`, import.meta.url)))
  ? false
  : `packages/${WASM} not built (npm run build:wasm)`;
if (skip && process.env.REQUIRE_WASM === "1") {
  throw new Error(`REQUIRE_WASM=1 but ${skip}; the decode tests must not skip here`);
}

const FIXTURE = "editor/6000.3.25f1/block/windows";

/** The UnityPy RGBA hash of a fixture texture, rows as stored. */
function goldenRgba(asset: Asset): string | undefined {
  return golden(FIXTURE).serialized![asset.file]!.textures![String(asset.pathId)]!.rgbaSha256;
}

test("decodeImage and images() need no initTexture(), even called at once", { skip }, async () => {
  const env = load([{ name: FIXTURE, data: loadFixture(FIXTURE) }]);
  const [dxt1, dxt5] = ["10_DXT1", "12_DXT5"].map(
    (name) => [...env.assets("Texture2D")].find((a) => a.name === name)!,
  );
  // The low-level API still wants initTexture() first: nothing is loaded yet.
  await assert.rejects(decodeTexture2D(dxt1!.reader.read()), /not initialized/);
  // Node.js ignores wasmPath; a browser needs it here unless it called initTexture().
  const [a, b] = await Promise.all([
    decodeImage(dxt1!, { wasmPath: "/unused-in-node" }),
    decodeImage(dxt5!),
  ]);
  assert.equal(sha256(reverseRows(a.rgba, a.width)), goldenRgba(dxt1!));
  assert.equal(sha256(reverseRows(b.rgba, b.width)), goldenRgba(dxt5!));
  // And now it is loaded for the low-level API too.
  assert.equal((await decodeTexture2D(dxt1!.reader.read())).data.length, a.rgba.length);
  let count = 0;
  for await (const image of images(env)) count += image.rgba.length > 0 ? 1 : 0;
  assert.equal(count, [...env.assets("Texture2D")].length);
});
