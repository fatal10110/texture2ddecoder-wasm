# Changelog

Every package in this repo ships under one version. Newest version first.
How to cut a release is in [RELEASING.md](RELEASING.md).

## Versioning policy

- All four packages (`unity-asset-reader`, `unity-asset-reader-texture`,
  `unity-asset-reader-node` and `unity-asset-reader-decoder`) version in **lockstep**: they always
  carry the same version and are published together, even when only one of them changed. A
  feature package's `peerDependency` on `unity-asset-reader` is `^<major>` (for 1.x: `^1`), so
  any core of the same major works with it; the texture package's `dependency` on
  `unity-asset-reader-decoder` stays within the same major.
- Versions follow [semver](https://semver.org/). The public API is what each package's
  `dist/index.d.ts` exports; for the decoder also its `wasm/` file names and the
  `texture2ddecoder-copy-wasm` command. A breaking change to any one of them bumps the major of
  all four, and the ranges move with it.
- Changes that are not on npm yet collect under a `## <next version> - Unreleased` heading. The
  release replaces `Unreleased` with the publish date.

## 1.0.0 - Unreleased

First release of `unity-asset-reader`, `unity-asset-reader-texture` and `unity-asset-reader-node`,
and of the texture decoder under its new name, `unity-asset-reader-decoder`.

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

`unity-asset-reader-texture` (peer: `unity-asset-reader@^1`):

- `initTexture()` and `decodeTexture2D()`: Texture2D to RGBA, for the plain formats in TypeScript
  and the block and Crunch formats through `unity-asset-reader-decoder`, with platform byte swaps
  and the vertical flip.
- `decodeSprite()`: crops a Sprite out of its texture or atlas, with optional tight-mesh masking.
- `convertPlain()` for the uncompressed formats without the decoder.

`unity-asset-reader-node` (peer: `unity-asset-reader@^1`):

- `loadPath(fileOrDir)`: loads a file or a directory tree from disk, merges `.split0..n` parts and
  picks up `.resS`/`.resource` sidecars.

`unity-asset-reader-decoder` (formerly `texture2ddecoder-wasm`):

- Renamed from `texture2ddecoder-wasm`, and its version joins the other packages at 1.0.0 (#174).
  The API is unchanged: same exports, `initialize()`, decode functions, `wasm/` files and
  `texture2ddecoder-copy-wasm` command. To migrate, install `unity-asset-reader-decoder`, import
  from it instead, and point CDN URLs at `unity-asset-reader-decoder@1`. `texture2ddecoder-wasm`
  stays at 1.2.2 on npm and gets no further releases.
- Changes since `texture2ddecoder-wasm` 1.2.2:
  - BC3 (DXT5) colour blocks decode in 4-colour mode, as the S3TC spec requires. Before, blocks
    with `c0 <= c1` came out with index 3 black (#137).
  - `initialize()` works inside a Web Worker; it used to throw "Unsupported environment" there
    (#149).
  - `build:wasm` uses `emscripten/emsdk:4.0.7` pinned by digest, the toolchain of 1.2.2 (#57).

## texture2ddecoder-wasm 1.2.2 and earlier

Released under the old name, on their own version line. See the
[GitHub releases](https://github.com/fatal10110/texture2ddecoder-wasm/releases).
