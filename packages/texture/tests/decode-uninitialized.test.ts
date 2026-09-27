import assert from "node:assert/strict";
import { test } from "node:test";
import { TextureFormat } from "unity-asset-reader";
import { decodeTexture2D } from "../src/decode.js";

// Its own file, so its own process: nothing here has called initTexture().

const TEXTURES = [
  ["DXT1", TextureFormat.DXT1, 4, new Uint8Array(8)],
  // Plain formats need no WASM, but the rule is the same, so it does not
  // depend on the format whether decoding works without initTexture().
  ["RGBA32", TextureFormat.RGBA32, 4, new Uint8Array(64)],
  // Nor on the size: a 0x0 texture (a dynamic font's "Font Texture", #139)
  // decodes nothing, but needs initTexture() all the same.
  ["RGBA32 0x0", TextureFormat.RGBA32, 0, new Uint8Array(0)],
] as const;

for (const [name, format, size, imageData] of TEXTURES) {
  test(`decodeTexture2D before initTexture() says to call initTexture (${name})`, async () => {
    await assert.rejects(
      decodeTexture2D({ m_Width: size, m_Height: size, m_TextureFormat: format, imageData }),
      (error: Error) => {
        assert.match(error.message, /not initialized/);
        assert.match(error.message, /call `await initTexture\(\)`/);
        return true;
      },
    );
  });
}
