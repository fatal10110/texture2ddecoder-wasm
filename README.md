# unity-asset-reader

Read Unity AssetBundles in the browser and in Node.js: unpack them, read their objects, and
decode their textures and sprites to RGBA. The parser is TypeScript with no WASM and no
platform dependencies. Only texture decoding uses a small WASM module.

This repository holds four npm packages. It will be renamed from `texture2ddecoder-wasm` to
`unity-asset-reader`.

**Status:** the three `unity-asset-reader*` packages are not on npm yet; their first release will
be 1.0.0. `texture2ddecoder-wasm` is on npm (1.2.2); its next release is 1.2.3.

## Which packages do I need?

Most apps need one or two. Pick the row that matches what you do:

| You want to | Install |
|---|---|
| Read bundles in a browser, a Worker or Node.js: unpack them, list their objects, read text, your scripts' data, and raw audio, video and font bytes | `unity-asset-reader` |
| Do that, and also get textures and sprites as pixels | `unity-asset-reader` + `unity-asset-reader-texture` |
| Do either of the above in Node.js, on files and folders on disk | add `unity-asset-reader-node` |
| Decode raw compressed texture blocks you already have, with no Unity files around them | `texture2ddecoder-wasm` alone |

`texture2ddecoder-wasm` is a dependency of `unity-asset-reader-texture` and is installed with it,
so you never add it next to `-texture` yourself.

### What each package does

- **[`unity-asset-reader`](packages/core/README.md)**, the parser. It takes bytes
  (`Uint8Array`), or fetches them for you with `open()`, and gives back the unpacked files and the
  assets in them. It is plain TypeScript: synchronous parsing, with no WASM and no Node.js APIs,
  so it runs the same everywhere. For a
  `Texture2D` it reads the header fields and the still-encoded `imageData`, but it never decodes
  pixels.
- **[`unity-asset-reader-texture`](packages/texture/README.md)** turns the `Texture2D` and
  `Sprite` objects that the parser reads into RGBA pixels. It parses nothing itself: you pass it
  an asset's `data` from `unity-asset-reader`. It decodes plain formats (RGBA32, RGB565, ...) in
  TypeScript and block-compressed ones (BC, ETC, ASTC, PVRTC, ...) through the decoder's WASM.
- **[`unity-asset-reader-node`](packages/node/README.md)** gets Unity files off the disk.
  `loadPath()` reads a file or a whole folder, merges split files (`.split0`, `.split1`, ...),
  picks up `.resS` / `.resource` sidecars, and hands everything to the parser's `load()`. It
  returns the same `Env` as `load()`, so everything after that works the same.
- **[`texture2ddecoder-wasm`](packages/decoder/README.md)** is the WASM decoder for compressed
  texture blocks: [Texture2DDecoder](https://github.com/K0lb3/texture2ddecoder) built to WASM. It
  knows nothing about Unity files: you call the function for a format (`decode_bc1`,
  `decode_astc`, ...) with raw block data, a width and a height, and it gives back BGRA. Use it on
  its own only when you already have that raw data.

### Why they are separate

- **Only textures need WASM.** The parser is about 64 KB gzipped. Decoding textures adds about
  19 KB of JavaScript plus a 147 KB WASM module (50 KB gzipped), which has to be loaded and
  initialized first (`await initTexture()`). An app that only reads text or script data never
  downloads any of that.
- **Only disk access needs Node.js.** Reading files needs `fs`, which a browser bundle cannot
  include. Keeping it in `unity-asset-reader-node` means the parser and the texture package never
  import Node.js APIs and bundle cleanly for the browser.
- **The decoder stands on its own.** It is useful without any Unity parsing, it was published on
  its own before the reader existed, and it depends on nothing else here.
- **There is one copy of the parser.** `unity-asset-reader-texture` and `-node` take
  `unity-asset-reader` as a peer dependency, so they share the copy your app installs instead of
  bringing their own. The three `unity-asset-reader*` packages are released together, on one
  version number. `texture2ddecoder-wasm` has its own version line; the texture package's range
  on it says which versions work.

## Usage

### Node.js

```bash
npm install unity-asset-reader unity-asset-reader-texture unity-asset-reader-node
```

```js
import { initTexture, decodeTexture2D } from "unity-asset-reader-texture";
import { loadPath } from "unity-asset-reader-node";

await initTexture(); // no options: the WASM is read from the installed decoder package

const env = loadPath("Build/StreamingAssets/bundles"); // a file, or a folder read recursively
env.files; // every unpacked file: [{ path: "CAB-…", data }, { path: "CAB-….resS", data }]
for (const asset of env.assets("Texture2D")) {
  const { data, width, height } = await decodeTexture2D(asset.reader.read()); // RGBA
  console.log(asset.path ?? asset.name, width, height); // "assets/ui/icon.png" 256 256
}
```

The bytes don't have to come from disk: when they come from an upload or a download, skip
`unity-asset-reader-node` and call `load(bytes)` (`bytes` is a `Uint8Array` or an `ArrayBuffer`;
a `Buffer` is a `Uint8Array` too), or `await open(url)` to fetch them. No package here writes image files; to save a PNG, hand the
RGBA to an image library, for example
`sharp(data, { raw: { width, height, channels: 4 } }).png().toFile("out.png")`.

### Browser

```bash
npm install unity-asset-reader unity-asset-reader-texture
```

```js
import { open } from "unity-asset-reader";
import { initTexture, decodeTexture2D } from "unity-asset-reader-texture";

// A browser has no package folder to read from, so tell it where the two WASM files are:
// a CDN, as here, or your own static folder (`npx texture2ddecoder-copy-wasm public/wasm`).
await initTexture({ wasmPath: "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1/wasm" });

const env = await open("a.bundle"); // fetches it; a File from an <input> works too
const icon = env.get("Assets/UI/Icon.png"); // an asset by its path in the Unity project
if (icon?.type === "Texture2D") {
  const { data, width, height } = await decodeTexture2D(icon.data); // RGBA
}
```

Parsing is synchronous, so a big bundle blocks the page while it loads; run it in a Web Worker.
[`examples/cdn.html`](examples/cdn.html) does that, and the [Bundler Guide](BUNDLER_GUIDE.md) has
the Vite and Next.js setups.

## Documentation

- [Quick Start](QUICK_START.md): extract a bundle in Node.js, draw a texture in a browser.
- [Bundler Guide](BUNDLER_GUIDE.md): Vite, Next.js, CDN without a bundler, Node.js ESM and
  CommonJS, Workers.
- Package READMEs: the API reference, and what is supported and what is not.
  - [`unity-asset-reader`](packages/core/README.md): containers, compression, classes, tested
    Unity versions, errors, `bigint` and JSON.
  - [`unity-asset-reader-texture`](packages/texture/README.md): texture formats, sprites,
    platforms.
  - [`unity-asset-reader-node`](packages/node/README.md): `loadPath()`.
- [`examples/`](examples/README.md): a CDN page that reads a bundle in a Worker and draws its
  textures.

## At a glance

| | |
|---|---|
| Containers | UnityFS, UnityWeb, UnityRaw, `UnityWebData` (WebGL `.data`), gzip, loose SerializedFiles and `.resS` |
| Compression | LZ4, LZ4HC, LZMA, none |
| Objects | Any class through its type tree. Hand-written readers for `AssetBundle`, `TextAsset`, `MonoBehaviour`, `MonoScript`, `Material`, `Texture2D`, `Sprite`, `SpriteAtlas`, `AudioClip`, `VideoClip`, `Font` and `MovieTexture` also read bundles built without type trees |
| Textures | Plain formats in TypeScript; BC1–7, ETC1/2, EAC, PVRTC, ASTC, ATC and Crunch through WASM. Output is RGBA |
| Tested on | Bundles built with Unity 2019.4, 2020.3 and 6000.3 (SerializedFile formats 21 and 22) |
| Not supported | LZHAM, brotli, zstd, `UnityArchive`, encrypted bundles; audio, video and mesh decoding; writing bundles |

The full matrices are in the package READMEs.

## Development

```bash
git clone --recurse-submodules https://github.com/fatal10110/texture2ddecoder-wasm.git
cd texture2ddecoder-wasm
npm ci
npm run verify   # build, test, check:browser, no-C# guard
```

Building the WASM decoder (`npm run build:wasm`) needs Docker. See
[CONTRIBUTING.md](CONTRIBUTING.md). The design and its decisions are in
[docs/unity-asset-reader-plan.md](docs/unity-asset-reader-plan.md), and the rules for changes are
in [docs/unity-asset-reader-rules.md](docs/unity-asset-reader-rules.md).

## License

MIT, except the tight-mesh fill of `unity-asset-reader-texture` (`packages/texture`). That code is
derived from ImageSharp.Drawing and is under Apache-2.0, so that package is `MIT AND Apache-2.0`
(see its `NOTICE` and `LICENSE-APACHE`). The upstreams the repo derives from (AssetStudio, UnityPy
and others) are listed in [`NOTICE`](NOTICE). Each published package ships its own `NOTICE`, which
is the authoritative one for its tarball.
