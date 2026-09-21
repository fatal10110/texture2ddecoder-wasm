# AGENTS.md

Two npm packages, one repo (repo will be renamed to `unity-asset-reader`).

| Package | Path | State | What |
|---|---|---|---|
| `texture2ddecoder-wasm` | repo root | published, stable | WASM bindings (emscripten, C++ submodule `texture2ddecoder/`) decoding BC/ETC/PVRTC/ASTC/ATC/Crunch textures to **BGRA**. Node + browser. |
| `unity-asset-reader` | `unity-asset-reader/` | in development | Browser-first Unity AssetBundle reader. TS parser hand-ported from AssetStudio (MIT); WASM only for leaf C/C++ codecs. Uses the root package as an optional peer for texture decode. |

Work on the reader stays inside `unity-asset-reader/`. Do not change the root package unless the task says so; it must keep building and passing.

## Read before you work

| You need | Read |
|---|---|
| Architecture, locked decisions D1–D9, layout, milestones, test strategy | [docs/unity-asset-reader-plan.md](docs/unity-asset-reader-plan.md) |
| **Rules you will be reviewed against** (hard rules R1–R13, design, code style, tests, git/PR format) | [docs/unity-asset-reader-rules.md](docs/unity-asset-reader-rules.md) |
| Dev setup, branch/commit conventions, root package standards | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Root package API and usage | [README.md](README.md), [QUICK_START.md](QUICK_START.md), [BUNDLER_GUIDE.md](BUNDLER_GUIDE.md) |
| What to build | GitHub issues: `gh issue view <N>`. Epics: M0 #6 · M1 #10 · M2 #21 · M3 #28 · M4 #36 · M5 #42 · M6+ #46 |

The plan wins over everything else. If an issue, the rules, or this file contradicts it, stop and say so instead of picking a side.

## Non-negotiables

Full list with reasons is in the rules doc; these are the ones that cannot be undone after the fact:

1. **Never copy, import, or test against `@arkntools/unity-js`.** It is AGPL-3.0 and would relicense this package and every app shipping it.
2. **No C# in the repo, no C# compiled to WASM.** AssetStudio C# is read-only reference, cloned *outside* the repo and hand-ported to TS. WASM is built from C/C++ only. `git ls-files '*.cs' '*.csproj' '*.sln'` must print nothing.
3. **Ported files keep attribution:** first line `// Ported from AssetStudio/<path>.cs (MIT, © Perfare / RazTools / Razviar)`.
4. **Reader core is isomorphic and sync:** no `node:*`/`fs`/`Buffer`/`process`/DOM in `unity-asset-reader/src/`, input is `Uint8Array`, no `async` in the parse path. Node-only code goes in `unity-asset-reader/node/`.
5. **No third-party game data committed.** Fixtures come from our own Unity projects; goldens come from the UnityPy oracle script, never from this library's own output.
6. **No new runtime dependency** beyond plan §1 without asking.
7. **Scope = the issue.** Smallest code that meets its Tasks and Acceptance. No speculative abstractions. Extra ideas become follow-up issues.

## Commands

Reader (from `unity-asset-reader/`):

```bash
npm run build && npm test && npm run check:browser
```

Root package (from repo root; `build:wasm` needs Docker, skip it unless C++/bindings changed):

```bash
npm run build:rollup && npm test
```

Tests: `tsx --test`, no frameworks. Style: TS strict, 2 spaces, double quotes, semicolons, JSDoc on exports.

## Workflows

Use the project skills in `.claude/skills/` rather than improvising:

- `implement-issue <N>`: issue → branch → code + tests → verified PR
- `review-implementation <PR>`: strict review against issue, rules and upstream; posts inline comments
- `fix-pr-comments <PR>`: triage and fix review comments, open follow-up issues

Never push to `main`, never force-push a branch under review, never merge a PR yourself.
