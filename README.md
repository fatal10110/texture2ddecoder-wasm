# unity-asset-reader

Read Unity AssetBundles in your browser or Node.js. Browse assets, read text and script data,
and turn textures and sprites into RGBA pixels.

**[Try the live demo](https://fatal10110.github.io/unity-asset-reader/)** — open a bundle,
browse its contents, and preview its textures and sprites.

The parser is written in TypeScript. Compressed texture decoding uses WebAssembly.
You do not need Unity, .NET, or a native application installed.

## Choose your packages

| What you need | Packages |
|---|---|
| Read bundles and their assets | `unity-asset-reader` |
| Decode textures and sprites too | `unity-asset-reader` + `unity-asset-reader-texture` |
| Load files or folders from disk | Add `unity-asset-reader-node` |
| Decode raw texture blocks without reading Unity files | `texture2ddecoder-wasm` |

The texture package installs `texture2ddecoder-wasm` automatically.

- **[Core](packages/core/README.md):** unpack bundles, list assets, and read their data.
  Use `load(bytes)` for bytes you already have or `await open(url)` to fetch a file.
- **[Textures](packages/texture/README.md):** convert `Texture2D` and `Sprite` assets to
  RGBA pixels with `await decodeImage(asset)`.
- **[Node.js](packages/node/README.md):** load a file or folder with `loadPath()`, including
  split bundles and resource sidecars.
- **[Standalone decoder](packages/decoder/README.md):** decode compressed texture blocks
  to **BGRA**. It does not read Unity files.

Install only what you need: reading text or script data does not load the texture decoder.
Each package has its own version.

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
| Platforms | Xbox 360 textures are byte-swapped back and Switch textures deswizzled. Textures of every other build target are decoded as stored, except PS4 and PS5 ones, which are refused ([#130](https://github.com/fatal10110/unity-asset-reader/issues/130)) |
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
git clone --recurse-submodules https://github.com/fatal10110/unity-asset-reader.git
cd unity-asset-reader
npm ci
npm run verify   # build, test, check:browser, no-C# guard
```

Building the WASM decoder (`npm run build:wasm`) needs Docker. See
[CONTRIBUTING.md](CONTRIBUTING.md). The design and its decisions are in
[docs/unity-asset-reader-plan.md](docs/unity-asset-reader-plan.md), and the rules for changes are
in [docs/unity-asset-reader-rules.md](docs/unity-asset-reader-rules.md).

## Compare libraries

See [the feature and format comparison](COMPARISON.md) for a ✓ / ✗ table of Unity readers
and texture decoders.

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
