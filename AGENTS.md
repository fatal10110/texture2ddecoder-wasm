# AGENTS.md

npm-workspaces monorepo (repo will be renamed to `unity-asset-reader`): a shared parser core, feature packages on top, and the existing texture decoder as a standalone package. The decoder lives in `packages/texture2ddecoder-wasm/`; the reader packages are scaffolded by M0 (#7).

| Package | Path | State | What |
|---|---|---|---|
| `texture2ddecoder-wasm` | `packages/texture2ddecoder-wasm/` | published, stable | WASM bindings (emscripten, C++ submodule `texture2ddecoder/`) decoding BC/ETC/PVRTC/ASTC/ATC/Crunch textures to **BGRA**. Node + browser. |
| `unity-asset-reader` | `packages/core/` | in development | **Shared core.** Browser-first Unity AssetBundle parser, isomorphic and sync. TS hand-ported from AssetStudio (MIT). No WASM, no workspace deps. |
| `unity-asset-reader-texture` | `packages/texture/` | in development | Texture2D / Sprite → RGBA. Depends on core (peer) and `texture2ddecoder-wasm`. |
| `unity-asset-reader-node` | `packages/node/` | in development | Node adapter: `loadPath()`, dir scan, sidecars. Depends on core (peer). |

Dependencies point one way: feature packages → core. Core and `texture2ddecoder-wasm` import nothing from the repo. Do not change `packages/texture2ddecoder-wasm/` unless the task says so; it must keep building, passing and publishing the same tarball.

## Read before you work

| You need | Read |
|---|---|
| Architecture, locked decisions D1–D9, layout, milestones, test strategy | [docs/unity-asset-reader-plan.md](docs/unity-asset-reader-plan.md) |
| **Rules you will be reviewed against** (hard rules R1–R14, design, code style, tests, git/PR format) | [docs/unity-asset-reader-rules.md](docs/unity-asset-reader-rules.md) |
| Dev setup, branch/commit conventions, root package standards | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Decoder package API and usage | [README.md](packages/texture2ddecoder-wasm/README.md), [QUICK_START.md](packages/texture2ddecoder-wasm/QUICK_START.md), [BUNDLER_GUIDE.md](packages/texture2ddecoder-wasm/BUNDLER_GUIDE.md) |
| What to build | GitHub issues: `gh issue view <N>`. Epics: M0 #6 · M1 #10 · M2 #21 · M3 #28 · M4 #36 · M5 #42 · M6+ #46 |

The plan wins over everything else. If an issue, the rules, or this file contradicts it, stop and say so instead of picking a side.

## Non-negotiables

Full list with reasons is in the rules doc; these are the ones that cannot be undone after the fact:

1. **Never copy, import, or test against `@arkntools/unity-js`.** It is AGPL-3.0 and would relicense this package and every app shipping it.
2. **No C# in the repo, no C# compiled to WASM.** AssetStudio C# is read-only reference, cloned *outside* the repo and hand-ported to TS. WASM is built from C/C++ only. `git ls-files '*.cs' '*.csproj' '*.sln'` must print nothing.
3. **Ported files keep attribution:** first line `// Ported from AssetStudio/<path>.cs (MIT, © Perfare / RazTools / Razviar)`.
4. **Reader core is isomorphic and sync:** no `node:*`/`fs`/`Buffer`/`process`/DOM in `packages/core` or `packages/texture`, input is `Uint8Array`, no `async` in the parse path. Node-only code goes in `packages/node`.
5. **No third-party game data committed.** Fixtures come from our own Unity projects; goldens come from the UnityPy oracle script, never from this library's own output.
6. **No new runtime dependency** beyond plan §1 without asking.
7. **Scope = the issue.** Smallest code that meets its Tasks and Acceptance. No speculative abstractions. Extra ideas become follow-up issues.

## Commands

Everything (from repo root):

```bash
npm ci && npm run verify
```

One package: `npm run build -w unity-asset-reader`, `npm test -w unity-asset-reader-texture`, ...

Decoder WASM (`build:wasm` needs Docker, skip it unless C++/bindings changed):

```bash
npm run build:wasm -w texture2ddecoder-wasm && npm test -w texture2ddecoder-wasm
```

Tests: `tsx --test`, no frameworks. Style: TS strict, 2 spaces, double quotes, semicolons, JSDoc on exports.

## Workflows

Use the project skills in `.claude/skills/` rather than improvising:

- `implement-issue <N>`: issue → branch → code + tests → verified PR
- `review-implementation <PR>`: strict review against issue, rules and upstream; posts inline comments
- `fix-pr-comments <PR>`: triage and fix review comments, open follow-up issues

Never push to `main`, never force-push a branch under review, never merge a PR yourself.
