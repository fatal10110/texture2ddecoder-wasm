# Examples

Examples of the reader packages used together. Not published.

| File | What |
|---|---|
| [`cdn.html`](cdn.html) | Pick a bundle, list its objects, draw a Texture2D to a `<canvas>`. No bundler, no install. |
| [`cdn-worker.js`](cdn-worker.js) | The Worker `cdn.html` runs the reader in. |
| [`serve.mjs`](serve.mjs) | Static server with a local stand-in for jsDelivr, for trying the page on this repo's builds. |
| [`tests/cdn.spec.mts`](tests/cdn.spec.mts) | The Playwright smoke test of `cdn.html` (plan §5). |

## `cdn.html`

The page runs the reader in a module Worker. The parse path is synchronous (plan
D4), so on the main thread a big bundle would freeze the page. The Worker
imports the packages from jsDelivr and sends the page plain data: the object
list, and RGBA pixels that go straight into `ImageData`. The page itself
imports nothing.

- **No import map.** Import maps do not apply inside Workers. So the Worker
  imports jsDelivr's `/+esm` builds, which also rewrite the packages' own bare
  imports (`fflate`, `lzma1`, `unity-asset-reader`, `texture2ddecoder-wasm`) to
  CDN URLs.
- **No special headers.** Everything is single-threaded (D6), so the page works
  from any static host without COOP/COEP. It has to be served over HTTP, not
  opened as `file://`.
- **The WASM** comes from `texture2ddecoder-wasm@1/wasm` on the same CDN.
  `initTexture({ wasmPath })` loads it, even when the textures are plain
  formats decoded in TS.

### Where the packages come from

`cdn-worker.js` holds the jsDelivr base URL and the versions. **Opening the page
with `?local` switches** it to the builds of this repo instead, served by
`serve.mjs` under `/npm/<name>/+esm`.

Until the reader packages are published (#45), only `?local` works:

```bash
npm ci
npm run build                        # dist/ of every package
npm run build:wasm                   # needs Docker, see CONTRIBUTING.md
node examples/serve.mjs              # then open http://localhost:8080/
```

`serve.mjs` sends no special headers. It maps `/npm/<name>/+esm` to the
package's browser ESM entry in `node_modules`, and rewrites bare imports the
way jsDelivr does. The version in a URL is ignored, and the local build is
served.

## Smoke test

```bash
npm run test:smoke
```

This runs [`tests/cdn.spec.mts`](tests/cdn.spec.mts) in Chromium, against
`cdn.html?local`. It needs the builds and the WASM above, and a Playwright
Chromium (`npx playwright install chromium`). It checks:

- The page is served without COOP/COEP, and is not cross-origin isolated.
- An LZ4 bundle with an RGBA32 texture in its `.resS` node is listed and
  drawn. Then an uncompressed bundle of block textures is loaded, and its DXT1
  Crunch and DXT1 textures are drawn through the WASM.
- The pixels handed to the canvas match the UnityPy goldens in
  `fixtures/goldens.json`. `decodeTexture2D` returns the top row first, and the
  goldens hash Unity's bottom-up rows, so the test reverses the rows before it
  hashes. The DXT1 texture is also read back from the canvas.
- The reader modules load in the Worker only, never on the page. Animation
  frames keep coming from the file pick to the drawn texture.

CI runs it in the `decoder` job, the only job that builds the WASM.
