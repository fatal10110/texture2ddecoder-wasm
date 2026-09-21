# Plan: browser-first Unity AssetBundle reader (TS + WASM leaf codecs)

Working name: `unity-asset-reader`. Monorepo (npm workspaces): a shared parser core plus feature packages; the existing `texture2ddecoder-wasm` is one of the packages (D7, D8). License: MIT. Source of truth for behavior: Razviar/assetstudio (MIT). Secondary reference + golden oracle: UnityPy (MIT).

Checkable rules derived from this plan: [unity-asset-reader-rules.md](unity-asset-reader-rules.md). Workflows: `.claude/skills/{implement-issue,review-implementation,fix-pr-comments}`.

## 0. Locked decisions

| # | Decision | Reason |
|---|---|---|
| D1 | **Port from AssetStudio (MIT). Do not fork, copy from, or import `@arkntools/unity-js` anywhere — including tests.** | unity-js is **AGPL-3.0**. A fork forces AGPL on the package and on every web app that ships it. AssetStudio, UnityPy and all chosen deps are MIT. This is a derivative port, not clean-room: keep Perfare / RazTools / Razviar (and UnityPy, where consulted) copyright notices in `LICENSE`/`NOTICE`. |
| D2 | TS parser, WASM only for leaf **C/C++** codecs. **No C# is ever compiled to WASM** (no Blazor / .NET-wasm / NativeAOT-LLVM / IL2CPP output). AssetStudio C# is a read-only behavior reference, hand-ported to TS. | Parsing is byte shuffling; WASM boundary = copies, no gain. A .NET runtime in WASM = multi-MB download + own GC, kills CDN drop-in. WASM inputs allowed: `texture2ddecoder` (C++), fallback `LzmaDec.c` (C), M6 `acl` (C++), `libvorbis` (C), `spirv-cross` (C++). |
| D3 | Core is isomorphic: zero `node:*`, zero DOM. Input = `Uint8Array`. | "Works in browser same as texture2ddecoder-wasm". |
| D4 | Core parse path is **sync**. Only `initialize()` and texture decode are async. | Matches existing lib; avoids async colouring the whole reader. Consequence: big bundles block the calling thread — docs and `examples/cdn.html` run the reader in a **Worker**. |
| D5 | No image encoding in core. Output `{ data: Uint8Array /*RGBA*/, width, height }`. | Kills Jimp/ImageSharp class of deps. Browser → `ImageData`; Node → caller's choice. |
| D6 | Single-threaded WASM only. No pthreads/SharedArrayBuffer. | pthreads force COOP/COEP headers → breaks drop-in CDN use. |
| D7 | **Several npm packages around one shared core.** `unity-asset-reader` (dir `packages/core`) is the isomorphic parser and the only place parsing lives. Feature packages depend on it and never on each other's internals: `unity-asset-reader-texture` (`packages/texture`), `unity-asset-reader-node` (`packages/node`), M6 items each get their own (`-mesh`, `-audio`, ...). `texture2ddecoder-wasm` (`packages/texture2ddecoder-wasm`) is a standalone leaf: it depends on nothing in the repo and keeps its npm name, API and 1.x version line. | A user who only unpacks bundles does not install WASM; a user who only decodes textures keeps using `texture2ddecoder-wasm` alone. Heavy M6 codecs (ACL, vorbis, spirv-cross) never bloat the core. Separate packages also make `texture2ddecoder-wasm` a normal `dependency` of the texture package instead of an optional-peer workaround. Reader packages version in lockstep with each other; `texture2ddecoder-wasm` versions independently. Names are final at first publish (#45); if an npm org is available, `@unity-asset-reader/{core,texture,node}` is the alternative. |
| D8 | **One git repo, npm workspaces, everything under `packages/`; repo gets renamed afterwards.** Root `package.json` is `private`, `"workspaces": ["packages/*"]`, and holds only shared dev tooling and scripts. The existing package **moves** from repo root to `packages/texture2ddecoder-wasm/` together with its submodule, `wasm_bindings.cpp`, `scripts/`, `examples/`, tests and README. Plain npm workspaces only: no lerna / nx / turbo / changesets. | Issues, CI and scaffolding already here. Workspaces link the packages in dev (no `file:..`), give one lockfile and one `npm ci`. The move is mechanical but touches the submodule path, `build-wasm.sh` paths and the npm publish dir, so it is its own M0 issue with a hard check: `npm pack --dry-run` file list of `texture2ddecoder-wasm` identical before and after. `docs/` stays at repo root (GitHub Pages serves from it). GitHub redirects old repo URLs after rename; update `repository.url` (and add `repository.directory`) in every `package.json` then. |
| D9 | 64-bit integers: **always `bigint`** for SInt64/UInt64 typetree fields and pathIDs. File offsets/sizes stay `number` with a `> 2^53` guard throw. | Typetrees carry int64 everywhere (every PPtr). "number when safe" gives a value whose type depends on its magnitude. Ship a documented JSON replacer (`bigint → string`). |

## 1. Dependencies (all MIT, all browser-safe, all sync)

Runtime deps of `packages/core` unless the note names another package. Between workspace packages: feature packages list `unity-asset-reader` as a `peerDependency` (one core instance per app, so `instanceof` and `ClassID` stay shared) plus a `devDependency` for the workspace link.

| Need | Dep | Note |
|---|---|---|
| Block texture decode + Crunch | `texture2ddecoder-wasm` (workspace package) | regular `dependency` of `unity-asset-reader-texture` only; core never imports it. Outputs **BGRA** → swap to RGBA (M3). |
| LZ4 / LZ4HC block | none — ~40 LOC in `packages/core/src/codec/lz4.ts` | port `AssetStudio/LZ4/LZ4.cs`. LZ4HC decodes identically; no separate path or fixture. |
| LZMA | `lzma1` (pure TS) — **decided**, see M1 spike #13 | Two stream shapes, see M1. Correct on both; ~10 MB/s, under the original 20 MB/s bar. Kept anyway: it is sync, zero-dep and browser-safe, so core stays WASM-free. WASM fallback deferred to M6 (#69), to be built only if real bundles make this hurt. |
| gzip/zlib | `fflate` | 8KB, sync (native `DecompressionStream` is async → violates D4) |
| LZHAM, brotli | — | skipped; throw `UnsupportedError` |
| zstd (M6 only) | `fzstd` | **not stock Unity** — only game-specific forks emit it. Lands with game variants (#50). |
| AES (M6 only) | `aes-js` | WebCrypto is async + no ECB |

## 2. Layout

Target layout (D8). Created in M0; until then the repo still has the old package at its root.

```
package.json            private; workspaces: ["packages/*"]; scripts: build, test, check:browser, verify
tsconfig.base.json      shared compiler options (strict set); core/texture use lib ES2020 only, no DOM, no node types
rollup.reader.mjs       one config factory for the reader packages (ESM + CJS + d.ts)
fixtures/               shared test bundles (zipped) + goldens              (§5)
scripts/                make-goldens.py
docs/                   plan, rules, GitHub Pages demo
packages/
  core/                 npm: unity-asset-reader          isomorphic, sync, zero deps on other workspace packages
    src/
      io/        BinaryReader.ts                       ← EndianBinaryReader.cs
      codec/     lz4.ts lzma.ts inflate.ts             ← LZ4/, SevenZipHelper.cs
      bundle/    detect.ts BundleFile.ts WebFile.ts    ← FileReader.cs, BundleFile.cs, WebFile.cs
      serialized/SerializedFile.ts TypeTree.ts TypeTreeReader.ts CommonString.ts ClassID.ts ObjectReader.ts
      classes/   Object NamedObject PPtr AssetBundle TextAsset Texture2D Sprite SpriteAtlas
                 MonoBehaviour MonoScript AudioClip Material Mesh ...     (field readers only, no pixel work)
      env.ts     resource resolver (.resS / .resource lookup across loaded files)
      index.ts
    tests/
  texture/              npm: unity-asset-reader-texture  isomorphic; deps: core (peer), texture2ddecoder-wasm
    src/         convert.ts (plain formats) decode.ts (→ texture2ddecoder-wasm) sprite.ts index.ts
    tests/
  node/                 npm: unity-asset-reader-node     Node only; deps: core (peer)
    src/         index.ts   fs + dir scan + sidecar resolution
    tests/
  texture2ddecoder-wasm/  npm: texture2ddecoder-wasm     moved from repo root as is; standalone
    src/ tests/ scripts/ examples/ texture2ddecoder/ (submodule) wasm_bindings.cpp
examples/               cdn.html, vite/   (reader examples; use core + texture together)
```

What belongs in core: anything two packages need, and anything that reads Unity bytes into fields (so `classes/Texture2D.ts` and `classes/Sprite.ts` live in core; turning their bytes into pixels lives in `texture`). What does not: WASM, pixel conversion, `fs`, anything with a heavy or optional dependency. `texture2ddecoder-wasm` shares no code with core today; if a second WASM package appears (LZMA fallback, M6 — #69), its emscripten loader is extracted then, not before.

Every reader package builds ESM + CJS + types through `rollup.reader.mjs`. `core` and `texture` use `resolve({ browser: true })` with **no** node builtins in `external`; only `node` may externalize them.

**Externalization rule (#71, decided):** *everything a package declares in `dependencies`, `peerDependencies` or `optionalDependencies` is `external`; everything else is bundled, except the node builtins `packages/node` passes through `external` itself.* One rule for workspace siblings and npm deps alike — `rollup.reader.mjs` reads the package's own manifest, so adding a dep to `package.json` is the only step. `dist/` keeps the bare `import`, npm resolves it at install time. Consequences, accepted:

- A dep is never both inlined in `dist/` and installed beside it. No second copy, and a security fix in a decompressor that eats untrusted bytes (`fflate`, `lzma1` — #14, #15) reaches consumers through `npm update`, not through a republish of this package.
- No per-dep NOTICE obligation: we distribute no copy of their code. The `fflate` stanza added by #68 is dropped.
- Consumers dedupe and tree-shake the dep themselves.
- A bare specifier in `dist/` means CDN use needs an import map or a CDN ESM endpoint (`/+esm`, esm.sh) — still zero bundler, so M3's `examples/cdn.html` criterion stands. `unity-asset-reader-texture` needs one regardless, since `texture2ddecoder-wasm` is external either way; this makes it one pattern to document instead of two. A separate bundled `dist/*.bundle.mjs` CDN build was rejected: it doubles the published output and keeps the NOTICE chore it was meant to avoid. Revisit only if a real CDN consumer cannot use an import map.
- An undeclared import is **not** caught by the build: npm hoists root devDependencies and symlinks workspace siblings into the root `node_modules`, so rollup resolves them and inlines them silently. Only a package absent from `node_modules` fails (`UNRESOLVED_IMPORT`). The guard is a test — `scripts/tests/rollup-reader.test.mjs` fails `npm run verify` when a reader package's `src/` imports something its `package.json` does not declare — with `check:browser` covering the R14 half at source level.

## 3. Public API (target)

```ts
import { load } from 'unity-asset-reader'
import { initTexture, decodeTexture2D } from 'unity-asset-reader-texture'

await initTexture({ wasmPath: '/wasm' })                // once; passthrough to texture2ddecoder-wasm

const env = load([{ name: 'a.bundle', data: u8 }, { name: 'a.resS', data: u8b }])
for (const obj of env.objects) {
  if (obj.type === ClassID.Texture2D) {
    const { data, width, height } = await decodeTexture2D(obj.read())   // RGBA
  }
}
env.files        // unpacked CAB / resS entries: { path, data }  ← pure "unpack" use case
obj.readTypeTree()  // generic JS object for any class with an embedded typetree; int64 → bigint (D9)
```

## 4. Milestones

Each milestone = shippable npm prerelease. "Port" lists the AssetStudio files that define behavior.

### M0 — Monorepo skeleton + browser guard (1 d)
- **First: convert the repo to npm workspaces and move the existing package** to `packages/texture2ddecoder-wasm/` (D8): `git mv` incl. the submodule, fix `build-wasm.sh` / `copy-wasm.js` paths, private root `package.json`. No source or API change. Check: `npm pack --dry-run` file list identical before/after; its `build:rollup` and tests still pass.
- Scaffold `packages/core`, `packages/texture`, `packages/node` (§2) on `tsconfig.base.json` + `rollup.reader.mjs`; empty modules, one smoke test each.
- Root scripts: `build` (all TS builds, no Docker), `test` (reader packages; `texture2ddecoder-wasm` tests join only when its `wasm/` output exists, since that needs Docker), `check:browser`, and `verify` = all of them + the no-C# guard. One command for humans, agents and CI.
- CI: one workflow running `npm ci && npm run verify` at the root.
- CI guard (D2): `git ls-files '*.cs' '*.csproj' '*.sln'` must be empty — no C# in the repo, so none can reach a WASM build.
- CI guard: `esbuild --bundle --platform=browser` on the `core` and `texture` entries must succeed with **no** node-builtin resolution (`texture2ddecoder-wasm` marked external). This is the whole browser-safety test; cheap and catches every regression.
- Done when: `npm ci && npm run verify` is green at the root; every reader package emits `dist/index.{mjs,cjs,d.ts}`; `texture2ddecoder-wasm` tarball unchanged by the move.

### M1 — Unpack (layers 1–2) (3–4 d)
- **First task: golden harness (#20).** Every later "Done when" depends on it. See §5.
- All of M1 and M2 lands in `packages/core`.
- Port: `EndianBinaryReader.cs`, `FileReader.cs` (detection only), `BundleFile.cs` (UnityFS, UnityWeb, UnityRaw; flags, blocksInfo at end, v7 alignment, 2019.4+ padding), `WebFile.cs`, `LZ4.cs`.
- `UnityArchive` signature: detect, throw `UnsupportedError`. Upstream has no implementation to port (confirm in `BundleFile.cs` while porting).
- Compression types: none, LZMA, LZ4, LZ4HC. LZHAM and anything else → `UnsupportedError(type)`.
- LZMA (spike #13, **done**) covers **both** stream shapes:
  - UnityFS block: 5 prop bytes + raw data, uncompressed size from block info → synthesize the 13-byte `.lzma` header.
  - Legacy UnityWeb/UnityRaw: 5 prop bytes + u64 size already in the stream.
  - **Outcome: `lzma1`.** Correct on both shapes (sha256-exact against the #20 goldens), sync, `Uint8Array` in/out, no node builtins. Measured ~10 MB/s on a 50 MB block in both Node 22 and Chromium, against a native-liblzma reference of 44.5 MB/s.
  - The original bar was ≥ 20 MB/s on a single ~50 MB block, with `LzmaDec.c` as the fallback. **The bar is retired, not met.** Taking the WASM path would put WASM in core, which §2 and AGENTS.md forbid, and D4's consequence already routes big bundles through a Worker — so ~5 s on a 50 MB block instead of ~2.5 s does not justify it yet. Revisit via #69 if real bundle sizes make it hurt.
  - `lzma1` does **not** throw on truncated input — it returned 52 MB of garbage for a 100 KB slice of a 26 MB stream. #14's wrapper must assert the output length itself (R9).
- gzip-wrapped files via `fflate`.
- `BinaryReader` directly over `Uint8Array`. No `ByteSource` interface yet — one impl, one backlog consumer (#51). Guard: total uncompressed block size above typed-array limit → throw.
- Done when: `load()` returns `env.files` byte-identical to golden raw-file hashes for fixtures covering: LZ4, LZMA (UnityFS), LZMA (legacy UnityWeb), uncompressed, gzip-wrapped.

### M2 — SerializedFile + TypeTree (5–6 d)
- Port: `SerializedFile.cs`, `SerializedFileHeader/FormatVersion`, `SerializedType.cs`, `TypeTree*.cs`, `TypeTreeHelper.cs`, `CommonString.cs`, `ClassIDType.cs`, `ObjectInfo.cs`, `ObjectReader.cs`, `PPtr.cs`; include the fork's Unity 6000 typetree fixes (`UNITY_6000_FIXES.md`).
- Generic `readTypeTree()` → plain JS object. This alone decodes *every* class in bundles with embedded typetrees — biggest capability per LOC in the project.
- Format-version claim: parse code is **ported for all versions upstream handles; tested only on what fixtures cover** (Editors 2019/2021/2022/6000 ≈ v21–22). README states the tested range. Older versions get a fixture when someone installs a 5.x/2017/2018 editor — not before.
- Done when: object table (pathID, classID, size) matches goldens for every fixture incl. one Unity 6 bundle; typetree dump equals golden for TextAsset/MonoBehaviour under the §5 normalization.

### M3 — Textures + sprites (4–5 d)
- Split: class readers (`Texture2D`, `Texture`, `StreamingInfo`, `Sprite`, `SpriteAtlas`) and the resource resolver go to `packages/core`; everything that produces pixels goes to `packages/texture`.
- Port: `Classes/Texture2D.cs`, `Texture.cs`, `StreamingInfo` + `ResourceReader.cs` (→ `env.ts`), `Texture2DConverter.cs` (plain formats in TS: Alpha8, RGB24, RGBA32, ARGB32, BGRA32, RGB565, ARGB/RGBA4444, R16, R/RG/RGBA Half+Float, RGB9e5, YUY2; block + Crunch → `texture2ddecoder-wasm`), platform swaps (Switch/XBOX360 byte-swap), vertical flip.
- **Channel order:** `texture2ddecoder-wasm` and AssetStudio's converter both produce BGRA. Public output is RGBA (D5) → one in-place R/B swap after block decode (#32); plain-format converters write RGBA directly. Goldens are hashed post-swap.
- Then: `Sprite.cs`, `SpriteAtlas.cs`, `SpriteHelper.cs` (crop, rotate/flip packing; tight-mesh mask = optional flag, polygon fill in TS).
- Done when: RGBA output hash-equal to golden pixels for one fixture per format family; `examples/cdn.html` renders a texture from a bundle via jsDelivr with zero bundler, reader running in a Worker.

### M4 — Hardcoded classes for typetree-stripped bundles (2–3 d)
- All in `packages/core`.
- Port minimal readers: `Object`, `EditorExtension`, `NamedObject`, `AssetBundle` (container map), `TextAsset`, `MonoScript`, `MonoBehaviour` (header only), `Material`, `AudioClip` (metadata + raw FSB bytes out), `Font` (raw ttf/otf out), `VideoClip`/`MovieTexture` (raw out).
- Raw-bytes-out covers audio/font/video "extract" without any decoder.
- Done when: container paths + names match golden asset list for a stripped-typetree fixture.

### M5 — node adapter package + 1.0 (1–2 d)
- `packages/node`: `loadPath(fileOrDir)`: fs read, dir scan, split-file (`.split0..n`) merge, sidecar `.resS/.resource` lookup. Port only that slice of `AssetsManager.cs` / `ImportHelper.cs`.
- README (incl. tested format-version range, Worker guidance, bigint JSON replacer), QUICK_START, bundler guide (reuse existing lib's docs structure). Root README becomes the package index. Publish 1.0 of `unity-asset-reader`, `-texture`, `-node` in lockstep (`npm publish -w`); `texture2ddecoder-wasm` is not republished unless it changed.

### M6+ — On demand, each independent
Each item that brings a decoder or writer ships as its own package on top of core (D7); only the class field readers it needs are added to core.
| Item | Work | Trigger |
|---|---|---|
| Mesh → glTF | `Mesh.cs` (1.5k LOC, vertex decompression) + glTF writer in TS | need 3D |
| AudioClip → WAV/OGG | FSB5 parser TS + vorbis header rebuild; wasm libvorbis own repo | need playable audio |
| AnimationClip + `acl-wasm` | `AnimationClip.cs` 2k LOC + emscripten ACL | need animation |
| Game variants: zstd, UnityCN / game crypto | `fzstd`; `Crypto/*`, `aes-js`; plugin hook in `BundleFile` block read. Fixtures are third-party by nature → kept out of repo. | specific game |
| Blob-backed reads for big `.resS` | introduce `ByteSource` seam (`read(offset,len)`, `size`) here; `FileReaderSync` in a Worker keeps it **sync** — no async variant | OOM on big `.resS` |
| Shader | smol-v TS + spirv-cross wasm | unlikely |

## 5. Testing

- Runner: `tsx --test` (same as existing lib), tests in `packages/<pkg>/tests/`; fixtures and goldens shared from root `fixtures/`.
- **Golden oracle: UnityPy** (`pip install UnityPy`; MIT, cross-platform, scriptable). One script `scripts/make-goldens.py` emits per fixture: raw file hashes (`env.files`), object table, typetree JSON (`read_typetree()`), RGBA hashes. AssetStudio CLI is a Windows `.exe` with an unverified raw-dump path — use it only to cross-check disagreements, not in the harness.
- Goldens generated **once**, committed. The oracle is not a dependency of the package or CI.
- Typetree comparison normalization (both sides): int64 → decimal string; floats compared by float32 bit pattern (NaN/-0 safe), not by printed text; byte arrays → hex or hash.
- Fixtures: small bundles per (compression × editor version × texture family), zipped like `samples.zip`, built with own Unity Editor projects.
- Browser: M0 esbuild guard + one Playwright smoke loading `examples/cdn.html` (M3). No per-feature browser suite.

## 6. Risks

| Risk | Mitigation |
|---|---|
| `lzma1` API/perf mismatch | 2h spike at start of M1 with a numeric bar (both stream shapes, ≥ 20 MB/s); fallback is a known recipe |
| Fixture licensing (game assets) | build own fixtures with Unity Editor (2019/2021/2022/6000); never commit third-party game data. Consequence accepted: old format versions and game variants ship untested-by-fixture. |
| Oracle is wrong / disagrees with AssetStudio | UnityPy and AssetStudio are independent implementations; on mismatch, cross-check with AssetStudio GUI and record the verdict next to the golden |
| 64-bit values | D9: `bigint` for all int64 fields + pathIDs; offsets as `number` with `> 2^53` guard throw |
| Memory in browser | zero-copy `subarray` everywhere, never `slice` (note: a `subarray` pins its whole parent buffer); size guard throw; `ByteSource` seam deferred to M6 |
| Main-thread jank | D4: Worker usage in docs + example |
| Moving a published package breaks its build or tarball | own M0 issue, no source changes in the same PR, `npm pack --dry-run` diff must be empty, Docker `build:wasm` rerun once after the move |
| Two copies of core in one app (feature package pulls its own) | core is a `peerDependency` of feature packages, never a `dependency` |
| Scope creep toward full AssetStudio | M6 items need a named consumer before starting |

## 7. Explicitly not doing

C#→WASM, FBX, Mono.Cecil DLL reflection, YAML export, LZMA/LZ4 *compression*, repacking/writing bundles, brotli, LZHAM, UnityArchive, GUI, multi-threading, PNG/JPEG encoding.

**Core to 1.0: ~16–21 working days.**

## 8. Tracking (GitHub)

Issues live in this repo (`fatal10110/texture2ddecoder-wasm`, to be renamed — D8). No transfer needed.
Milestone epics (each has its tasks as sub-issues): M0 #6 · M1 #10 · M2 #21 · M3 #28 · M4 #36 · M5 #42 · M6+ #46
Labels: `epic`, `area:{bundle,serialized,texture,codec,node,infra}`, `backlog`.

Revision 2026-09-21c (#71): §2 states the externalization rule for `rollup.reader.mjs` — declared `dependencies`/`peerDependencies` are external, everything else is bundled.

Revision 2026-09-21b (monorepo, D7/D8 rewritten): new M0 issue #55 for the workspaces conversion + package move (#7 → scaffold reader packages, depends on #55; #8 → guards for core/texture + R14; #9 → root `verify` CI); #6–#9 re-scoped to `packages/*` and root `verify`; every implementation issue names its package; #28/#29–#35 split core/texture; #32 decoder is a regular dependency; #43 → `packages/node`; #44/#45 multi-package docs and lockstep publish; M6+ items (#47–#52) each name their own package. Milestones M0/M5 retitled. PR #54 (single-package scaffold) is superseded by the re-scoped #7.

Issue edits applied for the previous revision (2026-09-21, via `gh`):
- #6, #7, #9 → scaffold + CI scoped to `unity-asset-reader/` subdir (D8).
- #8 → adds no-C# guard (D2).
- #10, #21, #28 → epic goals/done-criteria aligned.
- #11 → `BinaryReader` only; `ByteSource` moves to #51.
- #13 → both LZMA stream shapes + 20 MB/s bar.
- #15 → gzip/zlib only; zstd moves to #50.
- #18 → drop UnityArchive (throw unsupported).
- #20 → UnityPy harness + normalization; do first in M1.
- #19, #22, #23, #25, #32, #36 → "match AssetStudio" → "match goldens (#20)".
- #35 → example runs reader in a Worker.
- #6–#52 → footer: "clean-room" → MIT-derivative wording + UnityPy oracle + no-C#→WASM rule.

Revision 2026-09-21c (M1 spike #13 resolved): LZMA is **`lzma1`**, not the `LzmaDec.c` WASM fallback. The spike measured it correct on both stream shapes but at ~10 MB/s against a 20 MB/s bar; the bar is retired rather than met, because the WASM route would put WASM in `packages/core` (forbidden by §2 and the AGENTS.md core row) and D4 already routes big bundles through a Worker. The WASM fallback becomes on-demand M6 work (#69), to be built only on a real complaint or a measured regression on genuine bundles. §1's LZMA row and the M1 LZMA bullet record the outcome; §2's "LZMA fallback, M6" line was already consistent and now names the issue. Also recorded: `lzma1` does not throw on truncated input, so #14's wrapper must assert output length itself (R9).
