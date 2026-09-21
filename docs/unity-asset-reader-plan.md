# Plan: browser-first Unity AssetBundle reader (TS + WASM leaf codecs)

Working name: `unity-asset-reader`. License: MIT. Source of truth for behavior: Razviar/assetstudio (MIT). Secondary reference + golden oracle: UnityPy (MIT).

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
| D7 | One npm package for the reader, subpath exports. Split later only if something forces it. | Fewest moving parts. `texture2ddecoder-wasm` stays a separate npm package (already is). |
| D8 | **Same git repo as texture2ddecoder-wasm; repo gets renamed afterwards.** Reader lives in top-level dir `unity-asset-reader/` with its own `package.json`, `src/`, `tests/`, `dist/`. Existing package stays untouched at repo root. No workspaces tooling. | Issues, CI and scaffolding already here. A subdir avoids colliding with the root package's `exports`/`files`/README and avoids moving the root package (submodule path, build scripts, `docs/` GitHub Pages). In dev the reader uses the decoder via `"texture2ddecoder-wasm": "file:.."`; published, it is an optional peer on the npm version. GitHub redirects old repo URLs after rename; update `repository.url` in both `package.json` files then. |
| D9 | 64-bit integers: **always `bigint`** for SInt64/UInt64 typetree fields and pathIDs. File offsets/sizes stay `number` with a `> 2^53` guard throw. | Typetrees carry int64 everywhere (every PPtr). "number when safe" gives a value whose type depends on its magnitude. Ship a documented JSON replacer (`bigint → string`). |

## 1. Dependencies (all MIT, all browser-safe, all sync)

| Need | Dep | Note |
|---|---|---|
| Block texture decode + Crunch | `texture2ddecoder-wasm` | **peer/optional** — only loaded when a Texture2D is decoded. Outputs **BGRA** → swap to RGBA (M3). |
| LZ4 / LZ4HC block | none — ~40 LOC in `src/codec/lz4.ts` | port `AssetStudio/LZ4/LZ4.cs`. LZ4HC decodes identically; no separate path or fixture. |
| LZMA | `lzma1` (pure TS) — see M1 spike | Two stream shapes, see M1. Fallback: `LzmaDec.c` through existing emscripten recipe. |
| gzip/zlib | `fflate` | 8KB, sync (native `DecompressionStream` is async → violates D4) |
| LZHAM, brotli | — | skipped; throw `UnsupportedError` |
| zstd (M6 only) | `fzstd` | **not stock Unity** — only game-specific forks emit it. Lands with game variants (#50). |
| AES (M6 only) | `aes-js` | WebCrypto is async + no ECB |

## 2. Layout

All paths below are relative to `unity-asset-reader/` (D8).

```
src/
  io/        BinaryReader.ts                       ← EndianBinaryReader.cs
  codec/     lz4.ts lzma.ts inflate.ts             ← LZ4/, SevenZipHelper.cs
  bundle/    detect.ts BundleFile.ts WebFile.ts    ← FileReader.cs, BundleFile.cs, WebFile.cs
  serialized/SerializedFile.ts TypeTree.ts TypeTreeReader.ts CommonString.ts ClassID.ts ObjectReader.ts
  classes/   Object NamedObject PPtr AssetBundle TextAsset Texture2D Sprite SpriteAtlas
             MonoBehaviour MonoScript AudioClip Material Mesh ...
  texture/   convert.ts (plain formats) decode.ts (→ texture2ddecoder-wasm) sprite.ts
  env.ts     resource resolver (.resS / .resource lookup across loaded files)
  index.ts
node/        index.ts   fs + dir scan + sidecar resolution  (export "./node")
tests/  examples/cdn.html  examples/vite/
```

`package.json` exports: `.` (isomorphic), `./texture`, `./node`. ESM + CJS via the same Rollup config as texture2ddecoder-wasm, but `resolve({ browser: true })` and **no** node builtins in `external` for the `.` and `./texture` entries.

## 3. Public API (target)

```ts
import { load } from 'unity-asset-reader'
import { initTexture, decodeTexture2D } from 'unity-asset-reader/texture'

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

### M0 — Skeleton + browser guard (0.5 d)
- Create `unity-asset-reader/` subdir (D8); copy build/test scaffolding from repo root (rollup, tsconfig, `tsx --test`). Root package untouched.
- CI: add a job scoped to `unity-asset-reader/**`; existing root workflow keeps working as is.
- CI guard (D2): `git ls-files '*.cs' '*.csproj' '*.sln'` must be empty — no C# in the repo, so none can reach a WASM build.
- CI guard: `esbuild src/index.ts --bundle --platform=browser` must succeed with **no** node-builtin resolution. This is the whole browser-safety test; cheap and catches every regression.
- Done when: empty package builds ESM+CJS from the subdir, guard runs in CI, root package build/test still green.

### M1 — Unpack (layers 1–2) (3–4 d)
- **First task: golden harness (#20).** Every later "Done when" depends on it. See §5.
- Port: `EndianBinaryReader.cs`, `FileReader.cs` (detection only), `BundleFile.cs` (UnityFS, UnityWeb, UnityRaw; flags, blocksInfo at end, v7 alignment, 2019.4+ padding), `WebFile.cs`, `LZ4.cs`.
- `UnityArchive` signature: detect, throw `UnsupportedError`. Upstream has no implementation to port (confirm in `BundleFile.cs` while porting).
- Compression types: none, LZMA, LZ4, LZ4HC. LZHAM and anything else → `UnsupportedError(type)`.
- LZMA (**spike first, 2h**, #13) must cover **both** stream shapes:
  - UnityFS block: 5 prop bytes + raw data, uncompressed size from block info → synthesize the 13-byte `.lzma` header.
  - Legacy UnityWeb/UnityRaw: 5 prop bytes + u64 size already in the stream.
  - Pass bar: correct output on both **and ≥ 20 MB/s** on a single ~50 MB block (LZMA bundles are usually one giant block). Miss either → emscripten `LzmaDec.c`.
- gzip-wrapped files via `fflate`.
- `BinaryReader` directly over `Uint8Array`. No `ByteSource` interface yet — one impl, one backlog consumer (#51). Guard: total uncompressed block size above typed-array limit → throw.
- Done when: `load()` returns `env.files` byte-identical to golden raw-file hashes for fixtures covering: LZ4, LZMA (UnityFS), LZMA (legacy UnityWeb), uncompressed, gzip-wrapped.

### M2 — SerializedFile + TypeTree (5–6 d)
- Port: `SerializedFile.cs`, `SerializedFileHeader/FormatVersion`, `SerializedType.cs`, `TypeTree*.cs`, `TypeTreeHelper.cs`, `CommonString.cs`, `ClassIDType.cs`, `ObjectInfo.cs`, `ObjectReader.cs`, `PPtr.cs`; include the fork's Unity 6000 typetree fixes (`UNITY_6000_FIXES.md`).
- Generic `readTypeTree()` → plain JS object. This alone decodes *every* class in bundles with embedded typetrees — biggest capability per LOC in the project.
- Format-version claim: parse code is **ported for all versions upstream handles; tested only on what fixtures cover** (Editors 2019/2021/2022/6000 ≈ v21–22). README states the tested range. Older versions get a fixture when someone installs a 5.x/2017/2018 editor — not before.
- Done when: object table (pathID, classID, size) matches goldens for every fixture incl. one Unity 6 bundle; typetree dump equals golden for TextAsset/MonoBehaviour under the §5 normalization.

### M3 — Textures + sprites (4–5 d)
- Port: `Classes/Texture2D.cs`, `Texture.cs`, `StreamingInfo` + `ResourceReader.cs` (→ `env.ts`), `Texture2DConverter.cs` (plain formats in TS: Alpha8, RGB24, RGBA32, ARGB32, BGRA32, RGB565, ARGB/RGBA4444, R16, R/RG/RGBA Half+Float, RGB9e5, YUY2; block + Crunch → `texture2ddecoder-wasm`), platform swaps (Switch/XBOX360 byte-swap), vertical flip.
- **Channel order:** `texture2ddecoder-wasm` and AssetStudio's converter both produce BGRA. Public output is RGBA (D5) → one in-place R/B swap after block decode (#32); plain-format converters write RGBA directly. Goldens are hashed post-swap.
- Then: `Sprite.cs`, `SpriteAtlas.cs`, `SpriteHelper.cs` (crop, rotate/flip packing; tight-mesh mask = optional flag, polygon fill in TS).
- Done when: RGBA output hash-equal to golden pixels for one fixture per format family; `examples/cdn.html` renders a texture from a bundle via jsDelivr with zero bundler, reader running in a Worker.

### M4 — Hardcoded classes for typetree-stripped bundles (2–3 d)
- Port minimal readers: `Object`, `EditorExtension`, `NamedObject`, `AssetBundle` (container map), `TextAsset`, `MonoScript`, `MonoBehaviour` (header only), `Material`, `AudioClip` (metadata + raw FSB bytes out), `Font` (raw ttf/otf out), `VideoClip`/`MovieTexture` (raw out).
- Raw-bytes-out covers audio/font/video "extract" without any decoder.
- Done when: container paths + names match golden asset list for a stripped-typetree fixture.

### M5 — `./node` adapter + 1.0 (1–2 d)
- `loadPath(fileOrDir)`: fs read, dir scan, split-file (`.split0..n`) merge, sidecar `.resS/.resource` lookup. Port only that slice of `AssetsManager.cs` / `ImportHelper.cs`.
- README (incl. tested format-version range, Worker guidance, bigint JSON replacer), QUICK_START, bundler guide (reuse existing lib's docs structure), publish 1.0.

### M6+ — On demand, each independent
| Item | Work | Trigger |
|---|---|---|
| Mesh → glTF | `Mesh.cs` (1.5k LOC, vertex decompression) + glTF writer in TS | need 3D |
| AudioClip → WAV/OGG | FSB5 parser TS + vorbis header rebuild; wasm libvorbis own repo | need playable audio |
| AnimationClip + `acl-wasm` | `AnimationClip.cs` 2k LOC + emscripten ACL | need animation |
| Game variants: zstd, UnityCN / game crypto | `fzstd`; `Crypto/*`, `aes-js`; plugin hook in `BundleFile` block read. Fixtures are third-party by nature → kept out of repo. | specific game |
| Blob-backed reads for big `.resS` | introduce `ByteSource` seam (`read(offset,len)`, `size`) here; `FileReaderSync` in a Worker keeps it **sync** — no async variant | OOM on big `.resS` |
| Shader | smol-v TS + spirv-cross wasm | unlikely |

## 5. Testing

- Runner: `tsx --test` (same as existing lib).
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
| Scope creep toward full AssetStudio | M6 items need a named consumer before starting |

## 7. Explicitly not doing

C#→WASM, FBX, Mono.Cecil DLL reflection, YAML export, LZMA/LZ4 *compression*, repacking/writing bundles, brotli, LZHAM, UnityArchive, GUI, multi-threading, PNG/JPEG encoding.

**Core to 1.0: ~16–21 working days.**

## 8. Tracking (GitHub)

Issues live in this repo (`fatal10110/texture2ddecoder-wasm`, to be renamed — D8). No transfer needed.
Milestone epics (each has its tasks as sub-issues): M0 #6 · M1 #10 · M2 #21 · M3 #28 · M4 #36 · M5 #42 · M6+ #46
Labels: `epic`, `area:{bundle,serialized,texture,codec,node,infra}`, `backlog`.

Issue edits applied for this revision (2026-09-21, via `gh`):
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
