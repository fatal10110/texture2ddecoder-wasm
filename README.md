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
  an asset from `unity-asset-reader` (`decodeImage(asset)`), or give the low-level
  `decodeTexture2D` what `asset.reader.read()` returns. It decodes plain formats (RGBA32, RGB565,
  ...) in TypeScript and block-compressed ones (BC, ETC, ASTC, PVRTC, ...) through the decoder's
  WASM.
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
  19 KB of JavaScript plus a 147 KB WASM module (50 KB gzipped), which is loaded and initialized
  before the first decode (by `decodeImage`, or `await initTexture()`). An app that only reads
  text or script data never downloads any of that.
- **Only disk access needs Node.js.** Reading files needs `fs`, which a browser bundle cannot
  include. Keeping it in `unity-asset-reader-node` means the parser and the texture package never
  import Node.js APIs and bundle cleanly for the browser.
- **The decoder stands on its own.** It is useful without any Unity parsing, it was published on
  its own before the reader existed, and it depends on nothing else here.
- **There is one copy of the parser.** `unity-asset-reader-texture` and `-node` take
  `unity-asset-reader` as a peer dependency, so they share the copy your app installs instead of
  bringing their own. Each package has its own version; the feature packages' ranges on
  `unity-asset-reader` and the texture package's range on `texture2ddecoder-wasm` say which
  versions work together.

## Usage

### Node.js

```bash
npm install unity-asset-reader unity-asset-reader-texture unity-asset-reader-node
```

```js
import { images } from "unity-asset-reader-texture";
import { loadPath } from "unity-asset-reader-node";

const env = loadPath("Build/StreamingAssets/bundles"); // a file, or a folder read recursively
env.files; // every unpacked file: [{ path: "CAB-…", data }, { path: "CAB-….resS", data }]
// Every Texture2D and Sprite, decoded. The WASM decoder loads on first use.
for await (const { rgba, width, height, path, name, formatName } of images(env)) {
  console.log(path ?? name, width, height, formatName); // "assets/ui/icon.png" 256 256 "DXT5"
}
```

The bytes don't have to come from disk: when they come from an upload or a download, skip
`unity-asset-reader-node` and call `load(bytes)` (`bytes` is a `Uint8Array` or an `ArrayBuffer`;
a `Buffer` is a `Uint8Array` too), or `await open(url)` to fetch them. No package here writes image files; to save a PNG, hand the
RGBA to an image library, for example
`sharp(rgba, { raw: { width, height, channels: 4 } }).png().toFile("out.png")`.

### Browser

```bash
npm install unity-asset-reader unity-asset-reader-texture
```

```js
import { open } from "unity-asset-reader";
import { initTexture, isImage, imageInfo, decodeImage } from "unity-asset-reader-texture";

// A browser has no package folder to read from, so tell it where the two WASM files are:
// a CDN, as here, or your own static folder (`npx texture2ddecoder-copy-wasm public/wasm`).
await initTexture({ wasmPath: "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1/wasm" });

const env = await open("a.bundle"); // fetches it; a File from an <input> works too
const icon = env.get("Assets/UI/Icon.png"); // an asset by its path in the Unity project
if (icon && isImage(icon)) { // a Texture2D or a Sprite
  const { formatName, mipCount } = imageInfo(icon); // metadata, no decoding
  const { rgba, width, height } = await decodeImage(icon); // RGBA, top row first
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

## Supported formats and Unity versions

The short answer. The full tables, with what each claim is tested on, are in the package READMEs:
[containers, compression, classes and Unity versions](packages/core/README.md#supported),
[texture formats, platforms and sprites](packages/texture/README.md#texture-formats), and
[`texture2ddecoder-wasm`'s block formats](packages/decoder/README.md#supported-formats).

| | Supported |
|---|---|
| Containers | UnityFS; UnityWeb and UnityRaw (legacy web player bundles); `UnityWebData1.0` (a WebGL `.data` file); a gzip-wrapped file; loose SerializedFiles (`.assets`, `level0`, `globalgamemanagers`); `.resS` and `.resource` resource files. Split files (`.split0`, `.split1`, ...) through `unity-asset-reader-node` |
| Bundle compression | None, LZ4, LZ4HC, LZMA |
| SerializedFile formats | 2 to 22, little- and big-endian |
| Classes | Any class, through its type tree. A hand-written reader, which also reads bundles built without type trees, for `AssetBundle`, `TextAsset`, `MonoBehaviour`, `MonoScript`, `Material`, `Texture2D`, `Sprite`, `SpriteAtlas`, `AudioClip`, `VideoClip`, `Font` and `MovieTexture` |
| Texture formats | 17 plain formats (`RGBA32`, `RGB565`, `RHalf`, `RGB9e5Float`, `YUY2`, ...) in TypeScript. Through WASM: BC1 (`DXT1`), BC3 (`DXT5`), BC4 to BC7; ETC1, ETC2 and their 3DS variants; EAC R and RG, signed too; PVRTC 2 and 4 bpp; ATC; ASTC LDR and HDR at 4x4 to 12x12; Crunch (`DXT1Crunched`, `DXT5Crunched`, `ETC_RGB4Crunched`, `ETC2_RGBA8Crunched`). Output is RGBA8, top row first, first mip level |
| Sprites | Cut out of their texture, or of their `SpriteAtlas` when it is loaded; packer flips and rotations undone; optional transparency outside a tight mesh |
| Platforms | Xbox 360 textures are byte-swapped back and Switch textures deswizzled. Textures of every other build target are decoded as stored, except PS4 and PS5 ones, which are refused ([#130](https://github.com/fatal10110/texture2ddecoder-wasm/issues/130)) |
| Runtimes | Browsers and Web Workers (ES2020, WebAssembly for textures); Node.js `^20.19.0 \|\| >=22.12.0`, `import` and `require` |

### Unity versions

- **Tested on editor-built bundles:** Unity **2019.4.41f2**, **2020.3.30f1** and **6000.3.25f1**.
  That is SerializedFile formats 21 and 22 and UnityFS formats 7 and 8, with LZ4, LZMA and
  uncompressed blocks, with and without type trees, and version-stripped. PVRTC comes from
  2019.4 only (Unity 6 no longer writes it), sprites and atlases from 2019.4 and 6000.3.
- **Tested on generated or hand-written bytes only:** the class readers' version gates from
  Unity 3.4 to 6000.6; SerializedFile formats 6, 8 and 15; UnityFS format 6; UnityWeb and
  UnityRaw formats 2, 3, 4 and 6; `UnityWebData` and gzip. No real Unity build of those versions
  or containers is in the tests.
- **Handled in code:** SerializedFile formats 2 to 22 (Unity 2020.1 to 6000.x write 22). Type
  tree reads work on every one of them, whatever the Unity version. The class readers know the
  layouts from Unity 3.4 (`Sprite` from 4.3, `VideoClip` from 5.6, `SpriteAtlas` from 2017.1) up
  to 6000.5, and read a newer version with the newest layout they know; `SpriteAtlas` refuses
  6000.6 and later. A class reader refuses a version older than its first layout;
  `readTypeTree()` still reads such an object.
- **Version-stripped files** (`AssetBundleStripUnityVersion`): type tree reads work. A class
  reader reads the object when its bytes or the SerializedFile format decide the layout, and
  refuses it otherwise: `Texture2D`, `MovieTexture` and `MonoScript` always; `Material`,
  `Sprite` and `SpriteAtlas` outside formats 18 to 21, so in every file from Unity 2020.1 on.
  The table per class is in [the core README](packages/core/README.md#version-stripped-files).

### Not supported

Each of these throws `UnsupportedError`, naming what it found:

- Compression: LZHAM, brotli (a WebGL build's `.br` files), zstd.
- Containers: `UnityArchive`, zip archives, encrypted bundles (UnityCN and other game-specific
  encryption).
- Texture formats: `DXT3`, `ARGBFloat`, `RGBFloat`, `BGR24`, `R8`, `RG16`, `RG32`, `RGB48`,
  `RGBA64`. Textures built for PS4 or PS5. Sprites with an alpha texture (ETC1 split alpha) or
  from a variant atlas.

Not provided at all: decoding audio, video or meshes; mip levels other than the first; the
`Cubemap`, `Texture2DArray` and `Texture3D` classes; image encoding (PNG, JPEG); writing or
repacking bundles.

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
