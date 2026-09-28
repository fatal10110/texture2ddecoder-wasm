# Releasing

Maintainer procedure for publishing to npm. The versioning policy (reader packages in lockstep,
`texture2ddecoder-wasm` on its own line) is at the top of [CHANGELOG.md](CHANGELOG.md).

There are two release families. Each has its own version line and its own tag:

| Family (tag) | Packages, in publish order | Directory | Released |
|---|---|---|---|
| `unity-asset-reader@<version>` | `unity-asset-reader`, `unity-asset-reader-texture`, `unity-asset-reader-node` | `packages/core`, `packages/texture`, `packages/node` | together, same version, even when only one changed |
| `texture2ddecoder-wasm@<version>` | `texture2ddecoder-wasm` | `packages/decoder` | only when it changed since its last npm version |

`unity-asset-reader-texture` depends on `texture2ddecoder-wasm` with a `^<version>` range. The
decoder version that range names has to be on npm before the readers are released; the release
guard refuses a readers tag otherwise.

Releases are published by the [Release workflow](.github/workflows/release.yml), never from a
laptop. Pushing a release tag runs it; it checks the tag against the family's versions, runs the
full gate, and publishes the family's packages to npm with
[trusted publishing](https://docs.npmjs.com/trusted-publishers): npm authenticates the job by its
GitHub OIDC token, so the repo holds no npm token, and it attaches a
[provenance statement](https://docs.npmjs.com/generating-provenance-statements) to every package
by itself. The only exception is the one-time bootstrap of the three reader names, below.

## This round: decoder 1.2.3, then readers 1.0.0

1. `texture2ddecoder-wasm@1.2.3` (tag `texture2ddecoder-wasm@1.2.3`). It carries the BC3 fix
   (#137) and the Worker fix (#149). Its trusted publisher can be linked before this release,
   since the package exists on npm.
2. `unity-asset-reader@1.0.0` (tag `unity-asset-reader@1.0.0`), after 1.2.3 is on npm. The
   texture package depends on `texture2ddecoder-wasm@^1.2.3`, and its goldens rely on #137. This
   is the first publish of the three reader names, so it uses the bootstrap below.

## What the workflow does

`.github/workflows/release.yml`, one job on `ubuntu-latest`:

1. **Tools.** Node 22 (latest 22.x) and `npm@^11.5.1`. Trusted publishing needs npm CLI 11.5.1 or
   later and Node 22.14.0 or later
   ([npm docs](https://docs.npmjs.com/trusted-publishers), checked 2026-09-27); the job fails if
   the Node it got is older.
2. **Version guard** (`scripts/check-release.mjs`). The tag names the family. It fails when the
   tag is not `unity-asset-reader@<version>` or `texture2ddecoder-wasm@<version>`, when the
   family's `package.json` versions differ from each other or from the tag, or, for the readers,
   when no version of the texture package's `texture2ddecoder-wasm` range is on npm yet
   (`npm view`). A real publish runs only from a tag. The root test
   `scripts/tests/release.test.mjs` runs the same guard plus the range checks in every
   `npm run verify`, so drift shows up in CI long before tag time.
3. **Gate:** `npm ci`, `npm run build:wasm` (Docker, the pinned emsdk of #57; the decoder tarball
   ships `wasm/`), `npm run verify` with `REQUIRE_WASM=1` (nothing may skip), and
   `npm test -w texture2ddecoder-wasm`. The submodule is checked out. Both families run the whole
   gate.
4. **Publish** the family's packages in dependency order (readers: core, texture, node), each with
   `npm publish -w <name> --access public`. Each reader package's `prepublishOnly`
   (`npm run verify --prefix ../..`) reruns the gate once more, and the decoder's rebuilds its
   WASM and bundle. A `name@version` that is already on npm is skipped, so a run that failed
   halfway can simply be re-run.

Permissions are `contents: read` and `id-token: write`. The workflow does not create the GitHub
release (that would need `contents: write`); step 5 below does it by hand.

Every run that is not a dry run uses the GitHub environment `npm`, which admits only the two
release tag patterns (see [One-time setup](#github-environment-npm)). npm's trusted publisher
checks the repository, the workflow file name and the environment, but not the ref, so the
environment is what stops a branch that edits its own copy of `release.yml` (adding a
`pull_request` or branch `push` trigger, say) from publishing: its run either names no
environment, which npm refuses, or names `npm`, which GitHub starts only on a release tag.

**Dry run.** Actions → Release → *Run workflow* on any branch, with a `family` chosen and
`dry_run` ticked (the default): the same job, but `npm publish --dry-run`, and the tag check is
skipped when the ref is a branch. A readers dry run still fails while its decoder range is not on
npm, as the real run would. It runs outside the `npm` environment, so it sees no npm secret. Use
it after changing the workflow or the packaging. GitHub only offers *Run workflow* for a workflow
that is on the default branch. `dry_run` unticked is refused unless the run is on a release tag,
and `family` must then be the tag's.

## One-time setup

### GitHub environment `npm`

Settings → Environments → *New environment* `npm`, then under *Deployment branches and tags*
choose *Selected branches and tags* and add two rules of type **tag**, with the patterns
`unity-asset-reader@*.*.*` and `texture2ddecoder-wasm@*.*.*`. No branch rule. The bootstrap token
below is a secret of this environment, never a repository secret: jobs outside the environment
cannot read it.

The rules admit any tag that matches, and a tag push runs the `release.yml` of the tagged commit.
To keep that to maintainers, add a tag ruleset (Settings → Rules → Rulesets → *New tag ruleset*,
targeting both patterns, restrict creations, updates and deletions) that only maintainers can
bypass.

### Trusted publisher, per package

npm links a trusted publisher to a package that **already exists** on the registry: the setting
lives in the package's own settings page (npmjs.com → the package → Settings → Trusted
publishing), and the `npm trust` command (npm 11.15.0 or later) requires that "the package you're
configuring must already exist on the npm registry"
([npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/), checked 2026-09-27).

- `texture2ddecoder-wasm` is on npm already (1.2.2), so its trusted publisher can be linked
  **now**, before its 1.2.3 release. It needs no token.
- `unity-asset-reader`, `unity-asset-reader-texture` and `unity-asset-reader-node` are new names,
  so they are linked right after the bootstrap publish below, not before.

For each package, on npmjs.com as a maintainer with 2FA:

| Field | Value |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `fatal10110` |
| Repository | `texture2ddecoder-wasm` (the current name; see [After the repo rename](#after-the-repo-rename)) |
| Workflow filename | `release.yml` (file name only, with the extension; all fields are case-sensitive) |
| Environment name | `npm` |

or, from a shell logged in to npm with 2FA:

```bash
npm trust github <name> --file release.yml --repo fatal10110/texture2ddecoder-wasm --env npm --allow-publish
```

npm does not validate the entry when it is saved; a typo shows up as `ENEEDAUTH` at publish time.
Then, per package, Settings → Publishing access → *Require two-factor authentication and disallow
tokens*: trusted publishing keeps working, and no leaked token can publish.

### Bootstrap: the first publish of the three reader names

None of the three reader names is on npm yet, so none can have a trusted publisher yet, and the
first publish needs a token. The decoder does not: link its trusted publisher (above) and release
it by tag. The ways to do it for the readers, least bad first:

| Option | Cost |
|---|---|
| **Token in the workflow, once.** Publish the readers' 1.0.0 through this workflow, authenticated by a short-lived token in the `npm` environment's secret `NPM_BOOTSTRAP_TOKEN`. | For about an hour a write token sits in the environment's secrets, readable only by a job in the `npm` environment, which starts only on a release tag. npm's token page selects from packages and scopes that exist, so for three new names it has to be an *All packages* token, which can publish every package of the account; keep its expiry at the minimum (1 day). In return 1.0.0 is built and gated exactly like every later release and still gets provenance (token publishes from GitHub Actions with `id-token: write` support it; the job sets `NPM_CONFIG_PROVENANCE=true`). |
| Placeholder publish from a laptop (for example a `0.0.0` of each name), then link the publishers, then release 1.0.0 by tag. | Three empty versions stay on npm for good (unpublishing one blocks reusing that version number), and each name's first version is junk. |
| `npm publish` of 1.0.0 from a laptop. | 1.0.0 has no provenance (npm generates it only in a supported CI runner), is built on one machine outside the gate, and needs Docker locally for the WASM. |

Do the first:

1. Release `texture2ddecoder-wasm@1.2.3` first, through its trusted publisher (no token).
2. Create a granular access token on npmjs.com: *Read and write*, *All packages*, expiry 1 day,
   *Bypass 2FA* ticked (a CI job cannot answer a 2FA prompt).
3. Add it as the secret `NPM_BOOTSTRAP_TOKEN` of the `npm` environment (Settings →
   Environments → `npm` → *Environment secrets*; not a repository secret). The publish step
   writes it to the job's `~/.npmrc` only when it is set, and warns.
4. Release the readers' 1.0.0 with the steps below (tag `unity-asset-reader@1.0.0`).
5. Set up the trusted publisher of each of the three reader packages (above).
6. Delete the `NPM_BOOTSTRAP_TOKEN` secret and revoke the token on npmjs.com. With the secret
   gone the publish step passes no token and npm uses OIDC. Then set *disallow tokens* per
   package (above).

Do step 5 before step 6. The other way round, a release in between has neither a token nor a
matching trusted publisher and fails with `ENEEDAUTH`. Once step 5 is done, a release works
whether or not the secret is still set, because npm tries the OIDC token before any configured
token.

## Steps

Release one family at a time. When both changed and the readers need the new decoder, release
the decoder first and wait until it is on npm.

1. **Bump.** In a PR to `main`:
   - Readers: set all three versions at once and commit the lockfile with them:
     ```bash
     npm version <version> --no-git-tag-version \
       -w unity-asset-reader -w unity-asset-reader-texture -w unity-asset-reader-node
     npm install --package-lock-only
     ```
     The feature packages' peer range on `unity-asset-reader` stays `^<major>`.
   - Decoder: `npm version <version> --no-git-tag-version -w texture2ddecoder-wasm`, then
     `npm install --package-lock-only`. When the texture package relies on a change of this
     decoder release, raise its `texture2ddecoder-wasm` range to `^<version>` too.
   - `scripts/tests/release.test.mjs` fails on a half-done bump, and when the texture package's
     range does not admit the workspace decoder.
   - `CHANGELOG.md`: in the section of the family that ships, `### <version> - Unreleased`
     becomes `### <version> - <YYYY-MM-DD>`.
   - The docs for the release are on `main` (package READMEs, QUICK_START, bundler guide). A
     tarball without a README shows an empty page on npmjs.com.
   - Optional: *Run workflow* with `dry_run` and the family on the PR branch; it builds and
     `npm publish --dry-run`s the family's tarballs.
2. **Merge** the PR once CI is green.
3. **Tag** the merge commit on `main` and push the tag. `<family>` is `unity-asset-reader` or
   `texture2ddecoder-wasm`:
   ```bash
   git fetch origin main
   git tag -a <family>@<version> -m "<family>@<version>" origin/main
   git push origin <family>@<version>
   ```
4. **Watch the Release run** (Actions → Release). For the readers it publishes all three, even if
   only one changed. If it fails:
   - Something outside the code (network, npm outage, trusted-publisher typo, the decoder not on
     npm yet): fix it and *Re-run all jobs*. Packages already on npm at that version are skipped.
   - The code or the packaging: do not move the tag. Fix on `main` and release the next patch
     version of the family. Deprecate any package that did get out at the broken version:
     `npm deprecate <name>@<version> "incomplete release, use <next>"`.
5. **GitHub release.** Create it from the tag with the version's `CHANGELOG.md` section as notes:
   ```bash
   gh release create <family>@<version> --title "<family> <version>" --notes-file <file with that section>
   ```
6. **After the publish.**
   - `examples/cdn-worker.js`: `READER_VERSION` matches the published readers, and
     `DECODER_VERSION` (`1`) resolves to a decoder the texture package's range allows; check the
     live jsDelivr path (#150).
   - The next change that ships opens a new `### <next version> - Unreleased` heading in its
     family's section of `CHANGELOG.md`, and bumps the version with it so the release test keeps
     passing.

The decoder's earlier releases were tagged `v1.0.1` ... `v1.2.2`. Those tags stay as they are;
new releases use the family tags above, so the two never collide.

## After the repo rename

The repo is to be renamed to `unity-asset-reader` (plan D8). Two things follow it, before the
next release:

- `repository.url` in every `package.json`. GitHub redirects the old URL, but npm checks
  provenance against `repository.url`, which has to be the repository the job runs in. Keep each
  package's `repository.directory`.
- Each package's trusted publisher. It names the repository, so it has to name the new one. npm's
  docs say an existing connection cannot be changed, only deleted and added again
  ([npm docs](https://docs.npmjs.com/trusted-publishers)); do that per package.
