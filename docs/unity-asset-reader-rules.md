# unity-asset-reader: implementation rules

Condensed, checkable form of [the plan](unity-asset-reader-plan.md) and [CONTRIBUTING](../CONTRIBUTING.md). The plan wins on conflict; if the two disagree, fix this file in the same PR.

Used by humans and by the `.claude/skills/` workflows (`implement-issue`, `review-implementation`, `fix-pr-comments`). Each rule has an ID so reviews can cite it.

## Hard rules (a violation blocks merge)

| ID | Rule | Why |
|---|---|---|
| R1 | No code copied from, imported from, or tested against `@arkntools/unity-js`. | AGPL-3.0 would infect the package and every app shipping it (D1). |
| R2 | No C# in the repo and no C# compiled to WASM. `git ls-files '*.cs' '*.csproj' '*.sln'` prints nothing. Upstream C# is cloned **outside** the repo and read, never vendored. WASM sources are C/C++ only. | D2. A .NET runtime in WASM kills CDN drop-in use. |
| R3 | Every file ported from AssetStudio or UnityPy starts with a one-line attribution: `// Ported from AssetStudio/<path>.cs (MIT, © Perfare / RazTools / Razviar)`. `NOTICE` lists upstreams. | MIT requires keeping the notice; this is a derivative port, not clean-room. |
| R4 | `packages/core` and `packages/texture` (all of their `src/`) have zero `node:*` / `fs` / `path` / `crypto` / `Buffer` / `process` / `__dirname` and zero DOM. Input is `Uint8Array`. Node-only code lives in `packages/node`. | D3. `npm run check:browser` enforces it. |
| R5 | Parse path is sync. Only `initTexture()` and texture decode return promises. No `async` creeping into readers, codecs or classes. | D4. |
| R6 | 64-bit: SInt64/UInt64 fields and pathIDs are always `bigint`. Offsets and sizes are `number`, with a throw above 2^53. | D9. A value whose type depends on magnitude is a bug factory. |
| R7 | Bytes: `subarray`, never `slice`, on the read path. | Memory in browsers. |
| R8 | New runtime dependency only if the plan §1 lists it. Anything else: raise it in the PR, do not just add it. | Every dep is a license + bundle-size + browser-safety risk. |
| R9 | Unsupported input throws `UnsupportedError` with what was found (compression type, signature, format). Never return partial/garbage data silently. | Callers must be able to tell "not supported" from "corrupt". |
| R10 | Public texture output is RGBA. Block decoders return BGRA, so swap once after decode. | D5. |
| R11 | No third-party game data committed, ever. Fixtures are built with our own Unity projects. | Licensing. |
| R12 | Goldens come from the oracle (UnityPy, `scripts/make-goldens.py`), never from this library's own output. | A golden produced by the code under test proves nothing. |
| R13 | `packages/texture2ddecoder-wasm` keeps its npm name, public API and tarball contents, and keeps building and passing. Reader work never touches it unless the issue says so. | D7/D8. It is published and stable; the monorepo move must be invisible to its users. |
| R14 | Dependency direction: feature packages → `unity-asset-reader` (core, as `peerDependency`). Core imports no workspace package. `texture2ddecoder-wasm` imports no workspace package. No deep imports across packages (`unity-asset-reader/src/...`); only public entry points. | D7. A shared core only works if there is exactly one copy of it and nothing reaches around its API. |

## Design rules (a violation needs a reason in the PR)

- **Scope = the issue.** Implement its Tasks and Acceptance, nothing adjacent. Found something else worth doing? Open a follow-up issue.
- **Port behavior, not structure.** Match what upstream does on the same bytes; do not reproduce C# class hierarchies, streams or helper layers that TS does not need.
- **No speculative abstraction.** No interface with one implementation, no options nobody asked for, no plugin hooks before the M6 item that needs them (that is why `ByteSource` waits for #51).
- **Layout follows plan §2.** New packages, top-level folders or entry points need a plan change first.
- **Core or feature package?** Reading Unity bytes into fields, or needed by two packages → core. WASM, pixels, `fs`, heavy or optional deps → feature package. Do not create a shared helper package for code only one package uses.
- **Errors carry context:** file name, offset, expected vs actual. `write N bytes but expected M`, not `decode failed`.
- Deliberate shortcut with a known ceiling → `// ponytail: <ceiling>, <upgrade path>` comment.

## Code style (from CONTRIBUTING + `.editorconfig` + `tsconfig.json`)

- TypeScript, `strict` plus `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`. No `any` unless commented why. No `// @ts-ignore`.
- 2 spaces, LF, final newline, double quotes, semicolons, lines ≤ 100 when practical.
- `camelCase` functions/variables, `PascalCase` classes/types, `UPPER_SNAKE_CASE` constants. Unity field names read from data keep Unity's spelling (`m_Name`, `m_PathID`).
- JSDoc on every exported symbol: what it does, params, what it throws.
- Comment density like the surrounding code: explain *why* and format quirks (version gates, alignment), not what the next line does. Version gates cite the Unity version: `// 2019.4+: blocksInfo padded to 16`.

## Tests

- Runner: `tsx --test`, files in `packages/<pkg>/tests/**/*.test.ts`; shared fixtures and goldens in root `fixtures/`.
- Each Acceptance bullet of the issue maps to at least one test that fails when the behavior breaks.
- Codec/parser tests include the unhappy path the issue names (truncated input, wrong size, bad magic).
- Fixture-based tests compare against committed goldens under the normalization in plan §5 (int64 → decimal string, floats by float32 bits).
- No test frameworks, no mocks of our own code, no snapshot files generated by the code under test (R12).

## Verification (run before every push; reviewers rerun it)

```bash
npm ci && npm run verify
```

From the repo root. `verify` = build every package (TS only, no Docker) + test + `check:browser` + the no-C# guard (`git ls-files '*.cs' '*.csproj' '*.sln'` prints nothing). If `packages/texture2ddecoder-wasm/` changed, also run its `npm test -w texture2ddecoder-wasm` with `wasm/` built locally (`build:wasm`, needs Docker).

## Git and PRs

- Branch from up-to-date `main`: `feature/<issue>-<slug>`, `fix/<issue>-<slug>`, `docs/<issue>-<slug>`.
- Commits: imperative subject ≤ 50 chars, optional `type:` prefix (`feat:`, `fix:`, `docs:`, `test:`, `chore:`), body explains why. One logical change per commit.
- One issue per PR. PR body contains `Closes #<issue>`, an Acceptance table (criterion → test or evidence), the verification output summary, and a **Deviations** section (write "None" if none).
- Never push to `main`, never force-push a branch under review, never merge your own PR from a skill.
