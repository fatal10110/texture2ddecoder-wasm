# Changelog

This repo publishes two release lines. Each has its own section below, newest version first.
How to cut a release is in [RELEASING.md](RELEASING.md).

## Versioning policy

- **Reader packages** (`unity-asset-reader`, `unity-asset-reader-texture`,
  `unity-asset-reader-node`) version in **lockstep**: all three always carry the same version and
  are published together, even when only one of them changed. A feature package's
  `peerDependency` on `unity-asset-reader` is `^<major>` (for 1.x: `^1`), so any core of the same
  major works with it.
- **`texture2ddecoder-wasm`** versions independently on its own 1.x line. It is published only
  when it changed since its last npm version, never just because the reader packages are released.
  The texture package's `^` range on it names the oldest decoder it works with; that decoder is
  published first.
- Both lines follow [semver](https://semver.org/). For the reader packages the public API is what
  each package's `dist/index.d.ts` exports. A breaking change to any one of them bumps the major of
  all three, and the peer range moves with it.
- Changes that are not on npm yet collect under a `### <next version> - Unreleased` heading in
  the right section. The release replaces `Unreleased` with the publish date.

## Reader packages

### 1.0.0 - Unreleased

First release of `unity-asset-reader`, `unity-asset-reader-texture` and `unity-asset-reader-node`.

`unity-asset-reader` (core; isomorphic, synchronous, no WASM):

- Containers: UnityFS bundles (LZ4/LZ4HC, LZMA, uncompressed blocks), legacy UnityWeb/UnityRaw,
  `UnityWebData` files, gzip-wrapped inputs, loose SerializedFiles, and `.resS`/`.resource`
  sidecars. `detectFileType()` and `detectContainer()` tell them apart; brotli, zip and
  UnityArchive are detected and refused with `UnsupportedError`.
- `load()` returns an `Env` over every file given; `env.files` lists the SerializedFiles and
  resources, and PPtrs resolve across files.
- SerializedFile header, metadata, type trees and object table. Fixtures cover Unity 2019.4,
  2020.3 and 6000.3 builds. `readTypeTree()` turns any object with a type tree into a plain JS
  object.
- Hardcoded readers for typetree-stripped files: `Object`, `EditorExtension`, `NamedObject`,
  `AssetBundle` (container map), `TextAsset`, `MonoScript`, `MonoBehaviour` (header), `Material`,
  `Texture2D` (+ `StreamingInfo`), `Sprite`, `SpriteAtlas`, `AudioClip`, `Font`, `VideoClip` and
  `MovieTexture` (metadata and raw bytes out).
- 64-bit fields and path IDs are `bigint`. Unsupported input throws `UnsupportedError`, damaged
  input `CorruptError`, a missing sidecar `ResourceNotFoundError`.

`unity-asset-reader-texture` (peer: `unity-asset-reader@^1`; depends on `texture2ddecoder-wasm@^1.2.3`):

- `initTexture()` and `decodeTexture2D()`: Texture2D to RGBA, for the plain formats in TypeScript
  and the block and Crunch formats through `texture2ddecoder-wasm`, with platform byte swaps and
  the vertical flip.
- `decodeSprite()`: crops a Sprite out of its texture or atlas, with optional tight-mesh masking.
- `convertPlain()` for the uncompressed formats without the decoder.

`unity-asset-reader-node` (peer: `unity-asset-reader@^1`):

- `loadPath(fileOrDir)`: loads a file or a directory tree from disk, merges `.split0..n` parts and
  picks up `.resS`/`.resource` sidecars.

## texture2ddecoder-wasm

### 1.2.3 - Unreleased

- BC3 (DXT5) colour blocks decode in 4-colour mode, as the S3TC spec requires. Before, blocks with
  `c0 <= c1` came out with index 3 black (#137).
- `initialize()` works inside a Web Worker; it used to throw "Unsupported environment" there
  (#149).
- `build:wasm` uses `emscripten/emsdk:4.0.7` pinned by digest, the toolchain of 1.2.2 (#57).

### 1.2.2 and earlier

See the [GitHub releases](https://github.com/fatal10110/texture2ddecoder-wasm/releases).
