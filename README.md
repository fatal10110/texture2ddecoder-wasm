# unity-asset-reader

Read Unity AssetBundles in the browser and in Node.js: unpack them, read their objects, and
decode their textures and sprites to RGBA. The parser is TypeScript with no WASM and no
platform dependencies. Only texture decoding uses a small WASM module.

This repository holds four npm packages. It will be renamed from `texture2ddecoder-wasm` to
`unity-asset-reader`.

| Package | Install it to | Docs |
|---|---|---|
| [`unity-asset-reader`](packages/core/) | Unpack bundles and read objects: text, your scripts' data, raw audio, video and font bytes. Browser, Worker and Node.js. | [README](packages/core/README.md) |
| [`unity-asset-reader-texture`](packages/texture/) | Also get `Texture2D` and `Sprite` pixels as RGBA. Adds the WASM decoder. | [README](packages/texture/README.md) |
| [`unity-asset-reader-node`](packages/node/) | Load files and whole folders from disk in Node.js, with `.resS` sidecars and split files. | [README](packages/node/README.md) |
| [`texture2ddecoder-wasm`](packages/texture2ddecoder-wasm/) | Decode raw BC / ETC / PVRTC / ASTC / ATC / Crunch blocks to BGRA, without Unity files around them. Published and stable. | [README](packages/texture2ddecoder-wasm/README.md) |

The three `unity-asset-reader*` packages are released together, on one version number.
`unity-asset-reader-texture` and `-node` use `unity-asset-reader` as a peer dependency, so an app
always has one copy of the parser. `texture2ddecoder-wasm` is versioned on its own and depends on
nothing here.

**Status:** the `unity-asset-reader*` packages are not on npm yet; their first release will be
1.0. `texture2ddecoder-wasm` is on npm (1.2.2).

```js
import { load, ClassID } from "unity-asset-reader";
import { initTexture, decodeTexture2D } from "unity-asset-reader-texture";

await initTexture({ wasmPath: "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1/wasm" });

const env = load([{ name: "a.bundle", data: bytes }]); // bytes: Uint8Array
env.files; // every unpacked file: [{ path: "CAB-…", data }, { path: "CAB-….resS", data }]
for (const obj of env.objects) {
  if (obj.type === ClassID.Texture2D) {
    const { data, width, height } = await decodeTexture2D(obj.read()); // RGBA
  }
}
```

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
