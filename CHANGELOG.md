# Changelog

This repo publishes four npm packages. Each has its own section below, newest version first. How
to release is in [RELEASING.md](RELEASING.md).

## Versioning policy

- **Every package versions on its own**: `unity-asset-reader`, `unity-asset-reader-texture`,
  `unity-asset-reader-node` and `texture2ddecoder-wasm` each have their own version, and a package
  is published only when its version changes. Changing the `version` in a package's
  `package.json` on `main` is the release.
- Each follows [semver](https://semver.org/). For the reader packages the public API is what the
  package's `dist/index.d.ts` exports.
- Between packages of this repo, ranges say what goes together. A feature package's
  `peerDependency` on `unity-asset-reader` is `^<major>` (for 1.x: `^1`), so any core of that
  major works with it; a breaking core release moves the feature packages' peer range with it.
  The texture package's `^` range on `texture2ddecoder-wasm` names the oldest decoder it works
  with. A package is never published before a version its ranges need is on npm.
- Changes that are not on npm yet collect under a `### <next version> - Unreleased` heading in
  the package's section. The release replaces `Unreleased` with the publish date.

## unity-asset-reader

### 1.0.1 - 2026-09-28

- `engines` is `^20.19.0 || >=22.12.0`, was `>=18.0.0`. `require("unity-asset-reader")` needs a
  Node.js that can `require()` an ES module, because the LZMA decoder `lzma1` is published as ES
  modules only; Node.js 18 is end-of-life. CI tests on 20.19.0 and 22.12.0 (#172).

### 1.0.0 - 2026-09-28

First release. The core: isomorphic, synchronous, no WASM.

- Containers: UnityFS bundles (LZ4/LZ4HC, LZMA, uncompressed blocks), legacy UnityWeb/UnityRaw,
  `UnityWebData` files, gzip-wrapped inputs, loose SerializedFiles, and `.resS`/`.resource`
  sidecars. `detectFileType()` and `detectContainer()` tell them apart; brotli, zip and
  UnityArchive are detected and refused with `UnsupportedError`.
- `load()` returns an `Env` over every file given: `env.files` lists every unpacked file,
  `env.objects` every object as an `ObjectReader`, `env.resolve()` follows a PPtr across files
  and `env.readResource()` reads a `.resS`/`.resource` range. It takes one input or an array,
  each as bytes or `{ name, data }`.
- High-level API: `open()` fetches URLs or reads `Blob`/`File`/`Response` input, then calls
  `load()`. `env.assets(...types)` yields every object as an `Asset`, plain data with a `type`
  that narrows its lazily read `data`, plus its `name` and container `path`. `env.get(path)` finds
  an asset by container path (#183).
- `asset.data` has TypeScript-style field names for every class with a hardcoded reader:
  camelCase without Unity's `m_` (`Texture2DFields.format`, `.width`, `.mipCount`), with
  `TextAsset`'s `text` and `bytes`, and `MonoBehaviour`'s `script` and `fields`. Each field's
  JSDoc names its Unity field. `obj.read()` keeps Unity's names; `toXFields()` maps its result
  (#184).
- SerializedFile header, metadata, type trees and object table. Fixtures cover Unity 2019.4,
  2020.3 and 6000.3 builds. `readTypeTree()` turns any object with a type tree into a plain JS
  object.
- Hardcoded readers for typetree-stripped files: `Object`, `EditorExtension`, `NamedObject`,
  `AssetBundle` (container map), `TextAsset` (with `textAssetString()` for its text),
  `MonoScript`, `MonoBehaviour` (header), `Material`, `Texture`, `Texture2D` (+ `StreamingInfo`),
  `Sprite`, `SpriteAtlas`, `AudioClip`, `Font`, `VideoClip` and `MovieTexture` (metadata and raw
  bytes out).
- Low-level building blocks: `readBundle()`, `readWebFile()` and `readSerializedFile()` for
  one container or file, `ObjectReader` and `BinaryReader`, the codecs (`decompressLz4()`,
  `lzmaDecompress()`, `gunzip()`, `unzlib()`), and the value tables `ClassID` (with
  `classIdName()`), `TextureFormat`, `BuildTarget`, `SerializedFileFormatVersion`, `NodeFlags` and
  `SpritePackingRotation`.
- 64-bit fields and path IDs are `bigint`. Unsupported input throws `UnsupportedError`, damaged
  input `CorruptError`, a missing sidecar `ResourceNotFoundError`.

## unity-asset-reader-texture

### 1.0.1 - 2026-09-28

- `engines` is `^20.19.0 || >=22.12.0`, was `>=18.0.0`. In Node.js, `initTexture()` loads
  `texture2ddecoder-wasm`'s ES-module glue code, which Node.js below 20.19 refuses (`Cannot use
  'import.meta' outside a module`), and `require()` needs the same Node.js as
  `unity-asset-reader`. CI tests on 20.19.0 and 22.12.0 (#172).

### 1.0.0 - 2026-09-28

First release. Peer: `unity-asset-reader@^1`; depends on `texture2ddecoder-wasm@^1.2.3`.

- `initTexture()` and `decodeTexture2D()`: Texture2D to RGBA, for the plain formats in TypeScript
  and the block and Crunch formats through `texture2ddecoder-wasm`, with platform byte swaps and
  the vertical flip.
- `decodeSprite()`: crops a Sprite out of its texture or atlas, with optional tight-mesh masking.
- `convertPlain()` for the uncompressed formats without the decoder.
- Image API over `env.assets()`: `isImage()` narrows an asset to a Texture2D or Sprite;
  `imageInfo()` describes one without decoding it (size, format name and compression family,
  mips, colour space, filter and wrap modes, platform, whether its data is streamed, and for a
  Sprite its rects, pivot, border, packing, atlas and texture); `decodeImage()` decodes one to
  RGBA with that info, loading the WASM on first use, so `initTexture()` is optional; `images()`
  is an async iterator decoding every image of an env, and with `onError: "skip"` leaves out the
  ones that fail instead of stopping (#185).

## unity-asset-reader-node

### 1.0.1 - 2026-09-28

- `engines` is `^20.19.0 || >=22.12.0`, was `>=18.0.0`, the same as `unity-asset-reader`, which
  `require()` needs. CI tests on 20.19.0 and 22.12.0 (#172).

### 1.0.0 - 2026-09-28

First release. Peer: `unity-asset-reader@^1`.

- `loadPath(fileOrDir)`: loads a file or a directory tree from disk, merges `.split0..n` parts and
  picks up `.resS`/`.resource` sidecars.

## texture2ddecoder-wasm

### 1.2.4 - 2026-09-28

- Bundlers leave the browser `initialize({ wasmPath })` import alone, so it loads the glue from
  `wasmPath` at run time instead of failing with `Cannot find module ...` (webpack, Turbopack).
  The `browser` field of `package.json` keeps the Node.js glue out of browser bundles; its
  `import("module")` failed the build with `Can't resolve 'module'`. Next.js (Turbopack and
  webpack) bundles the package with no config (#171).
- A root-relative `wasmPath` (`"/wasm"`) is resolved against the page's or the Worker's location
  before the import. The Vite dev server failed to load it (#171).

### 1.2.3 - 2026-09-28

- BC3 (DXT5) colour blocks decode in 4-colour mode, as the S3TC spec requires. Before, blocks with
  `c0 <= c1` came out with index 3 black (#137).
- `initialize()` works inside a Web Worker; it used to throw "Unsupported environment" there
  (#149).
- `build:wasm` uses `emscripten/emsdk:4.0.7` pinned by digest, the toolchain of 1.2.2 (#57).

### 1.2.2 and earlier

See the [GitHub releases](https://github.com/fatal10110/texture2ddecoder-wasm/releases).
