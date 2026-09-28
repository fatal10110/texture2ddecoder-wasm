// Node.js floor check (#172): the reader packages' `engines` names the lowest Node.js versions
// they support, and CI runs this script on exactly those. It loads the workspace builds (`dist/`)
// of unity-asset-reader, unity-asset-reader-texture and unity-asset-reader-node twice, with
// `import` and with `require()`, and uses each copy: it unpacks an LZMA bundle (`lzma1` is ES
// modules only, so `require()` needs `require(esm)`), loads a fixture with `loadPath()`, and
// decodes its textures after `initTexture()` (the decoder's ES-module glue needs ESM syntax
// detection). The decoded pixels must match the oracle goldens.
//
// The decode needs `packages/decoder/wasm/`, built with Docker (`npm run build:wasm`). Without
// it the decode is skipped, unless REQUIRE_WASM=1, which makes a missing WASM fail.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const LZMA = "lzma.bundle";
/** A fixture of Texture2Ds whose goldens UnityPy and AssetStudio agree on (no `oracleNote`). */
const TEXTURES = "editor/2019.4.41f2/block/ios";
const WASM = "packages/decoder/wasm/texture2ddecoder.wasm";

const bundle = (name) => join(root, "fixtures/bundles", name);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Unity stores rows bottom first; `decodeTexture2D` returns them top first. */
function reverseRows(rgba, width) {
  const stride = width * 4;
  const out = new Uint8Array(rgba.length);
  for (let from = 0; from < rgba.length; from += stride) {
    out.set(rgba.subarray(from, from + stride), rgba.length - from - stride);
  }
  return out;
}

/** pathId -> texture golden of the `TEXTURES` fixture. */
function textureGoldens() {
  const goldens = JSON.parse(readFileSync(join(root, "fixtures/goldens.json"), "utf8"));
  const serialized = Object.values(goldens.fixtures[TEXTURES].serialized);
  return Object.assign({}, ...serialized.map((s) => s.textures ?? {}));
}

/**
 * Use one copy of the three packages.
 *
 * @param how "import" or "require", for the messages
 * @param packages the three packages, loaded that way: `{ core, texture, node }`
 * @param decode whether to run `initTexture()` and decode
 * @returns the number of textures decoded
 */
async function check(how, packages, decode) {
  const { core, texture, node } = packages;
  const lzma = core.load(new Uint8Array(readFileSync(bundle(LZMA))));
  assert.ok(lzma.files.length > 0, `${how}: ${LZMA} unpacked to no files`);

  const env = node.loadPath(bundle(TEXTURES));
  const textures = env.objects.filter((obj) => obj.type === core.ClassID.Texture2D);
  assert.ok(textures.length > 0, `${how}: ${TEXTURES} has no Texture2D`);
  if (!decode) return 0;

  await texture.initTexture();
  const goldens = textureGoldens();
  for (const obj of textures) {
    const golden = goldens[String(obj.pathId)];
    assert.ok(golden?.rgbaSha256 && !golden.oracleNote, `${how}: no golden for ${obj.pathId}`);
    const out = await texture.decodeTexture2D(obj.read());
    const rgba = reverseRows(out.data, out.width);
    assert.equal(sha256(rgba), golden.rgbaSha256, `${how}: ${golden.name}`);
  }
  return textures.length;
}

const decode = existsSync(join(root, WASM));
if (!decode && process.env.REQUIRE_WASM === "1") {
  throw new Error(`REQUIRE_WASM=1 but ${WASM} is not built (npm run build:wasm)`);
}

const imported = {
  core: await import("unity-asset-reader"),
  texture: await import("unity-asset-reader-texture"),
  node: await import("unity-asset-reader-node"),
};
const required = {
  core: require("unity-asset-reader"),
  texture: require("unity-asset-reader-texture"),
  node: require("unity-asset-reader-node"),
};

for (const [how, packages] of [["import", imported], ["require", required]]) {
  const decoded = await check(how, packages, decode);
  const what = decode ? `initTexture() and ${decoded} decodes` : "decode skipped, no WASM";
  console.log(`node ${process.version}, ${how}: load, loadPath, ${what}: ok`);
}
