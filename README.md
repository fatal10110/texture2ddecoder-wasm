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
  `readTypeTree()` still reads such an object. `Texture2D` is the exception: it has no floor,
  with gates at 2.6 and 3.0 that no test covers, and reads any older version with its oldest
  layout.
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

## Comparison with other packages

Other npm packages also read Unity files or decode Unity textures. The table lists the ones found
by searching npm for `unity assetbundle`, `unityfs`, `unity texture`, `assetstudio`,
`unity serializedfile` and `texture2ddecoder`, as of **2026-09-29**. Every cell comes from the
package's npm metadata (`npm view <name>`: license, dependencies, last publish, unpacked size) or
from its README on npmjs.com; the Sources column says which. "Not stated" means the source does
not say, not that the package cannot do it.

| Package | License | Runtime | WASM or native parts | Reads | Texture decoding | Bundles without type trees | Last publish | Size and approach | Sources |
|---|---|---|---|---|---|---|---|---|---|
| **`unity-asset-reader`** (+ `-texture`, `-node`) | MIT (`-texture`: MIT AND Apache-2.0) | Browser, Worker, Node.js 20.19+ / 22.12+ | Parser: none (TypeScript; `fflate`, `lzma1`). Textures: the `texture2ddecoder-wasm` WASM module | UnityFS, UnityWeb, UnityRaw, `UnityWebData`, gzip, loose SerializedFiles, `.resS`; LZ4, LZ4HC, LZMA; any class through its type tree | `Texture2D` and `Sprite` to RGBA: plain formats, BC1, BC3–BC7, ETC/EAC, PVRTC, ASTC, ATC, Crunch | Yes, for the 12 classes with hand-written readers | 2026-09-28 (1.0.1) | 781 KB + 206 KB + 241 KB (decoder) unpacked. Synchronous parse, bytes in, objects out; writes no files | This repo |
| [`@arkntools/unity-js`](https://www.npmjs.com/package/@arkntools/unity-js) | **AGPL-3.0** | Node.js; browser with a `Buffer` polyfill | WASM through `@arkntools/unity-js-tools` (Rust: `lz4_flex`, `texture2ddecoder`); audio through `@arkntools/fmod` and `@arkntools/lame-wasm` | AssetBundles. Classes listed: TextAsset, Texture2D, Sprite, SpriteAtlas, MonoBehaviour, MonoScript, AudioClip, Material; Spine export; a game-specific `BundleEnv.ARKNIGHTS` option. The README says only "the minimum implementation required for the project" is done | Texture2D and Sprite to PNG (jimp), with a separate alpha texture merged in | Not stated | 2026-08-21 (5.3.0) | 765 KB unpacked, 14 dependencies (jimp, jszip, aes-js, ...). Async `loadAssetBundle()` | npm metadata, npm README, [unity-js-tools README](https://www.npmjs.com/package/@arkntools/unity-js-tools) |
| [`unityfs-js`](https://www.npmjs.com/package/unityfs-js) | MIT | Browser and Node.js (ES modules) | LZ4 and LZMA WASM inlined as base64, with a pure-JS fallback; no npm dependencies; Three.js injected by the caller for GLB export | UnityFS bundles, `.assets`, `.resS` / `.resource`. Exports TextAsset, Texture2D, Sprite, AudioClip (FSB5 to WAV/OGG), Mesh (OBJ), SkinnedMeshRenderer (GLB), Live2D models and motions; edits TextAsset, Texture2D and MonoBehaviour fields and repacks bundles | DXT1–5, BC7, ETC1/2, EAC, Crunch, to PNG, RGBA, canvas or Blob | Not stated (a `unityRevision` option helps align type trees in some old or version-less files) | 2026-08-25 (0.2.8) | 4.1 MB unpacked. Async `load()` to an `AssetManager`; README in Chinese | npm metadata, npm README |
| [`node-asset-studio-mod-js`](https://www.npmjs.com/package/node-asset-studio-mod-js) | MIT | Node.js 22+ only (worker threads), ES modules | Embedded WASM (ASTC decoder, SPIRV-Tools, Assimp); no npm dependencies | Built on `unityfs-js` 0.2.8. Exports Texture2D and Sprite (PNG), Texture2DArray, TextAsset, Font, Shader (inspection text), Mesh (OBJ), models (FBX), MonoBehaviour (JSON), AudioClip (WAV), VideoClip, MovieTexture, Live2D | Texture2D and Sprite to PNG; adds ASTC, BC4/5/6H, PVRTC and half/float formats to `unityfs-js`'s | `dump` fails without an embedded type tree | 2026-09-28 (0.1.7) | 10.4 MB unpacked. Async API over Node workers; writes files or returns buffers | npm metadata, npm README |
| [`node-asset-studio-mod`](https://www.npmjs.com/package/node-asset-studio-mod) | MIT | Node.js with the **.NET 9 runtime** | Downloads the native AssetStudioMod CLI at install | Whatever the [AssetStudioMod](https://github.com/aelurum/AssetStudio) CLI exports: textures, sprites, text, MonoBehaviour, font, shader, audio, video, mesh, animator | Through the CLI | Through the CLI | 2026-09-07 (1.0.5) | 32 KB unpacked, plus the CLI and .NET. Wraps the CLI | npm metadata, npm README |
| [`@tootallnate/unity-asset`](https://www.npmjs.com/package/@tootallnate/unity-asset) | MIT | Not stated (no README) | None listed; depends on `@tootallnate/bntx` | SerializedFiles only (the `CAB-…` files inside a bundle, not the bundle container): header, type table, object table, and objects as JSON through their type trees | Not stated | No: it walks the type tree | 2026-06-14 (0.1.0) | 226 KB unpacked | npm metadata, [CHANGELOG](https://github.com/TooTallNate/switch-tools/blob/main/packages/unity-asset/CHANGELOG.md) |
| [`@lego-fan9/asset-studio-web`](https://www.npmjs.com/package/@lego-fan9/asset-studio-web) | MIT | Browser only | Not stated | "A variant of AssetStudio written in TypeScript"; the README says it is early, with no stable API | Not stated | Not stated | 2026-06-16 (0.2.3) | 561 KB unpacked, depends on `@lunapaint/png-codec` | npm metadata, npm README |
| [`texture2ddecoder.js`](https://www.npmjs.com/package/texture2ddecoder.js) | MIT | ES modules and CommonJS; runtime not stated | WASM build of [K0lb3's texture2ddecoder](https://github.com/K0lb3/texture2ddecoder) | No Unity files: raw texture blocks only | BC1–7 (BC2 from Pillow), ATC, ETC/EAC, ASTC, PVRTC, Crunch, to BGRA | n/a | 2026-04-12 (1.1.0) | 221 KB unpacked | npm metadata, npm README |

Last published before 2022, so not in the table: [`shibunyan`](https://www.npmjs.com/package/shibunyan)
(MIT, 2021-03: mikunyan in TypeScript, UnityFS and UnityRaw, a few plain texture formats and
ETC1), [`unity-asset-server`](https://www.npmjs.com/package/unity-asset-server) (MIT, 2021-11:
Node.js, with AssetStudio's native Texture2DDecoder DLL through `ffi-napi`) and
[`unity-parser`](https://www.npmjs.com/package/unity-parser) (MIT, 2016-12: written for one game on
Unity 5.1.2f).

**Where others do more.** `unityfs-js` and `node-asset-studio-mod-js` export audio (FSB5 to WAV),
meshes (OBJ, GLB, FBX), Live2D and shaders; this library exports none of these, and hands out
audio and video only as raw bytes. `unityfs-js` also edits and repacks bundles; this library only
reads. `@arkntools/unity-js` exports Spine data and converts FSB audio to MP3 and WAV.
`node-asset-studio-mod` gets everything the AssetStudioMod CLI does, at the cost of .NET.
`texture2ddecoder.js` decodes BC2 (DXT3), which `texture2ddecoder-wasm` does not.

**Where this library does more.** The parser is synchronous and has no WASM and no platform
APIs, so it runs unchanged in a browser, a Worker and Node.js, and an app that reads no textures
never loads WASM. Of the maintained packages above, it is the only one whose README says it reads
the UnityWeb and UnityRaw containers and WebGL `.data` files, or objects from bundles built
without type trees (through its 12 hand-written readers). Its output is checked against goldens
produced by UnityPy on bundles built with three Unity editors. It is MIT (plus Apache-2.0 for the
sprite mesh fill in `-texture`), so it can ship in closed-source web apps.

**Why this library does not derive from `@arkntools/unity-js`.** It is AGPL-3.0: code derived
from it would put this package, and every web app that ships it, under the AGPL. This project
never copies, imports or tests against it; its row above comes only from its npm metadata and
README. The reader packages are ported from AssetStudio (MIT) instead, with UnityPy (MIT) as the
test oracle.

## Acknowledgements

This project stands on the work below. The reader packages are a derivative port, not a
clean-room rewrite: every ported file starts with a line naming the file it came from, and the
copyright notices are kept in [`NOTICE`](NOTICE) and in each package's `NOTICE` or `LICENSE`.

| Project | License | What it is used for |
|---|---|---|
| [AssetStudio](https://github.com/Razviar/assetstudio), Razviar's fork of [Perfare's AssetStudio](https://github.com/Perfare/AssetStudio) (© Perfare, RazTools, Razviar) | MIT | The source of truth for behaviour. The bundle, SerializedFile and type tree readers, the class readers, the plain texture conversion, the Xbox 360 byte swap, sprite cropping and the tight-mesh mask, and `loadPath()`'s file handling are hand-ported from it. |
| [UnityPy](https://github.com/K0lb3/UnityPy) (© K0lb3) | MIT | The oracle that generates the test goldens (`scripts/make-goldens.py`). Also ported where AssetStudio lacks something or disagrees: the UnityFS header version gates, the `[SerializeReference]` registry, the common-string table and the Switch texture deswizzle. |
| [AssetRipper TypeTreeDumps](https://github.com/AssetRipper/TypeTreeDumps) and [Tpk](https://github.com/AssetRipper/Tpk) (ds5678) | TypeTreeDumps: no license stated; Tpk: MIT | Indirectly: the type tree data in UnityPy's TPK table, which the common-string table and several class readers' version gates were taken from. |
| [AssetsTools.NET](https://github.com/nesrak1/AssetsTools.NET) (© nesrak1) | MIT | UnityPy's Switch deswizzle, ported into `unity-asset-reader-texture`, is based on its `SwitchSwizzle.cs`. |
| [ImageSharp.Drawing](https://github.com/SixLabors/ImageSharp.Drawing) (© Six Labors) | Apache-2.0 | The sprite tight-mesh triangle fill in `unity-asset-reader-texture` is a modified TypeScript translation of parts of v1.0.0-beta15, the version AssetStudio uses, so the masks match to the pixel. |
| [texture2ddecoder](https://github.com/K0lb3/texture2ddecoder) (© K0lb3) | MIT | The C++ block and Crunch decoders that `texture2ddecoder-wasm` compiles to WASM (a git submodule). |
| Codecs inside texture2ddecoder: [Perfare's AssetStudio](https://github.com/Perfare/AssetStudio/tree/master/Texture2DDecoderNative) (ATC, BCn), [mikunyan](https://github.com/Ishotihadus/mikunyan) (ASTC, ETC, PVRTC), [FP16](https://github.com/Maratyszcza/FP16), [BinomialLLC/crunch](https://github.com/BinomialLLC/crunch), [Unity-Technologies/crunch](https://github.com/Unity-Technologies/crunch) | MIT; MIT; MIT; public domain; zlib | The block decoders, half floats, and Crunch and Unity Crunch unpacking. |
| [fflate](https://github.com/101arrowz/fflate) | MIT | Runtime dependency of `unity-asset-reader`: gzip and zlib, synchronously. |
| [lzma1](https://github.com/xseman/lzma1) | MIT | Runtime dependency of `unity-asset-reader`: LZMA, synchronously and without WASM. |
| [Emscripten](https://github.com/emscripten-core/emscripten) | MIT or University of Illinois/NCSA | Compiles texture2ddecoder to the WASM module and generates its JavaScript loader (the pinned `emscripten/emsdk:4.0.7` Docker image). |

Development only, not shipped: TypeScript (Apache-2.0), Rollup, esbuild and tsx (MIT) build and
test the packages, and Playwright (Apache-2.0) runs the browser smoke test. The test bundles are
built with the Unity Editor from our own projects ([`fixtures/BUILDING.md`](fixtures/BUILDING.md)).

## License

MIT, except the tight-mesh fill of `unity-asset-reader-texture` (`packages/texture`). That code is
derived from ImageSharp.Drawing and is under Apache-2.0, so that package is `MIT AND Apache-2.0`
(see its `NOTICE` and `LICENSE-APACHE`). The upstreams the repo derives from (AssetStudio, UnityPy
and others) are listed in [`NOTICE`](NOTICE). Each published package ships its own `NOTICE`, which
is the authoritative one for its tarball.
