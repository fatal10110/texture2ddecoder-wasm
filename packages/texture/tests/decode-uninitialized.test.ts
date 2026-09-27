import assert from "node:assert/strict";
import { test } from "node:test";
import { TextureFormat } from "unity-asset-reader";
import { decodeTexture2D } from "../src/decode.js";

// Its own file, so its own process: nothing here has called initTexture().

const TEXTURES = [
  ["DXT1", TextureFormat.DXT1, new Uint8Array(8)],
  // Plain formats need no WASM, but the rule is the same, so it does not
  // depend on the format whether decoding works without initTexture().
  ["RGBA32", TextureFormat.RGBA32, new Uint8Array(64)],
] as const;

for (const [name, format, imageData] of TEXTURES) {
  test(`decodeTexture2D before initTexture() says to call initTexture (${name})`, async () => {
    await assert.rejects(
      decodeTexture2D({ m_Width: 4, m_Height: 4, m_TextureFormat: format, imageData }),
      (error: Error) => {
        assert.match(error.message, /not initialized/);
        assert.match(error.message, /call `await initTexture\(\)`/);
        return true;
      },
    );
  });
}
