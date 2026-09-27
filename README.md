# unity-asset-reader

npm-workspaces monorepo (repo will be renamed to `unity-asset-reader`). Plan: [docs/unity-asset-reader-plan.md](docs/unity-asset-reader-plan.md).

| Package | Path | What |
|---|---|---|
| [`texture2ddecoder-wasm`](packages/texture2ddecoder-wasm/README.md) | `packages/texture2ddecoder-wasm/` | WASM decoder for BC / ETC / PVRTC / ASTC / ATC / Crunch textures. Published, stable. |

More packages (`unity-asset-reader`, `-texture`, `-node`) are added under `packages/` by M0 issue #7. Full docs land in #44.

```bash
git clone --recurse-submodules https://github.com/fatal10110/texture2ddecoder-wasm.git
cd texture2ddecoder-wasm
npm ci
npm run build:rollup && npm test
```

License: MIT, except the tight-mesh fill of `unity-asset-reader-texture` (`packages/texture`), which is derived from ImageSharp.Drawing and under Apache-2.0: that package is `MIT AND Apache-2.0` (see its `NOTICE` and `LICENSE-APACHE`). The upstreams the repo derives from (AssetStudio, UnityPy and others) are listed in [`NOTICE`](NOTICE); each published package ships its own `NOTICE`, which is the authoritative one for its tarball.
