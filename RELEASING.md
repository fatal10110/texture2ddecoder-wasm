# Releasing

Maintainer procedure for publishing to npm. The versioning policy (all four packages in
lockstep) is at the top of [CHANGELOG.md](CHANGELOG.md).

| Package | Directory | Released |
|---|---|---|
| `unity-asset-reader-decoder` | `packages/decoder` | first, with the other three, same version |
| `unity-asset-reader` | `packages/core` | with the other three, same version |
| `unity-asset-reader-texture` | `packages/texture` | with the other three, same version |
| `unity-asset-reader-node` | `packages/node` | with the other three, same version |

Releases are published by the [Release workflow](.github/workflows/release.yml), never from a
laptop. Pushing a tag `v<version>` runs it; it checks the tag against the four versions, runs the
full gate, and publishes all four packages to npm with
[trusted publishing](https://docs.npmjs.com/trusted-publishers): npm authenticates the job by its
GitHub OIDC token, so the repo holds no npm token, and it attaches a
[provenance statement](https://docs.npmjs.com/generating-provenance-statements) to every package
by itself. The only exception is the one-time bootstrap of the first publish, below.

## What the workflow does

`.github/workflows/release.yml`, one job on `ubuntu-latest`:

1. **Tools.** Node 22 (latest 22.x) and `npm@^11.5.1`. Trusted publishing needs npm CLI 11.5.1 or
   later and Node 22.14.0 or later
   ([npm docs](https://docs.npmjs.com/trusted-publishers), checked 2026-09-27); the job fails if
   the Node it got is older.
2. **Version guard** (`scripts/check-release.mjs`): fails if the four `package.json` versions
   differ from each other or if the tag is not `v<that version>`. A real publish runs only from a
   tag. The root test `scripts/tests/release.test.mjs` runs the same guard plus the range checks
   in every `npm run verify`, so drift shows up in CI long before tag time.
3. **Gate:** `npm ci`, `npm run build:wasm` (Docker, the pinned emsdk of #57; the decoder tarball
   ships `wasm/`), `npm run verify` with `REQUIRE_WASM=1` (nothing may skip), and
   `npm test -w unity-asset-reader-decoder`. The submodule is checked out.
4. **Publish** in dependency order: decoder, core, texture, node, each with
   `npm publish -w <name> --access public`. Each reader package's
   `prepublishOnly` (`npm run verify --prefix ../..`) reruns the gate once more, and the decoder's
   rebuilds its WASM and bundle. A `name@version` that is already on npm is skipped, so a run
   that failed halfway can simply be re-run.

Permissions are `contents: read` and `id-token: write`. The workflow does not create the GitHub
release (that would need `contents: write`); step 5 below does it by hand.

Every run that is not a dry run uses the GitHub environment `npm`, which admits only `v*.*.*`
tags (see [One-time setup](#github-environment-npm)). npm's trusted publisher checks the
repository, the workflow file name and the environment, but not the ref, so the environment is
what stops a branch that edits its own copy of `release.yml` (adding a `pull_request` or branch
`push` trigger, say) from publishing: its run either names no environment, which npm refuses, or
names `npm`, which GitHub starts only on a `v*.*.*` tag.

**Dry run.** Actions → Release → *Run workflow* on any branch, with `dry_run` ticked (the
default): the same job, but `npm publish --dry-run`, and the tag check is skipped when the ref is
a branch. It runs outside the `npm` environment, so it sees no npm secret. Use it after changing
the workflow or the packaging. GitHub only offers *Run workflow* for a workflow that is on the
default branch, so the first dry run is possible after the PR that adds it is merged. `dry_run` unticked is refused unless the run is on a `v<version>` tag.

## One-time setup

### GitHub environment `npm`

Settings → Environments → *New environment* `npm`, then under *Deployment branches and tags*
choose *Selected branches and tags* and add one rule of type **tag** with the pattern `v*.*.*`.
No branch rule. The bootstrap token below is a secret of this environment, never a repository
secret: jobs outside the environment cannot read it.

The rule admits any tag that matches, and a tag push runs the `release.yml` of the tagged commit.
To keep that to maintainers, add a tag ruleset (Settings → Rules → Rulesets → *New tag ruleset*,
target `v*.*.*`, restrict creations, updates and deletions) that only maintainers can bypass.

### Trusted publisher, per package

npm links a trusted publisher to a package that **already exists** on the registry: the setting
lives in the package's own settings page (npmjs.com → the package → Settings → Trusted
publishing), and the `npm trust` command (npm 11.15.0 or later) requires that "the package you're
configuring must already exist on the npm registry"
([npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/), checked 2026-09-27). So the four
names are linked right after the bootstrap publish below, not before.

For each of `unity-asset-reader-decoder`, `unity-asset-reader`, `unity-asset-reader-texture` and
`unity-asset-reader-node`, on npmjs.com as a maintainer with 2FA:

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

### Bootstrap: the first publish of the four names

None of the four names is on npm yet, so none can have a trusted publisher yet, and the first
publish needs a token. The ways to do it, least bad first:

| Option | Cost |
|---|---|
| **Token in the workflow, once.** Publish 1.0.0 through this workflow, authenticated by a short-lived token in the `npm` environment's secret `NPM_BOOTSTRAP_TOKEN`. | For about an hour a write token sits in the environment's secrets, readable only by a job in the `npm` environment, which starts only on a `v*.*.*` tag. npm's token page selects from packages and scopes that exist, so for four new names it has to be an *All packages* token, which can publish every package of the account; keep its expiry at the minimum (1 day). In return 1.0.0 is built and gated exactly like every later release and still gets provenance (token publishes from GitHub Actions with `id-token: write` support it; the job sets `NPM_CONFIG_PROVENANCE=true`). |
| Placeholder publish from a laptop (for example a `0.0.0` of each name), then link the publishers, then release 1.0.0 by tag. | Four empty versions stay on npm for good (unpublishing one blocks reusing that version number), and each name's first version is junk. |
| `npm publish` of 1.0.0 from a laptop. | 1.0.0 has no provenance (npm generates it only in a supported CI runner), is built on one machine outside the gate, and needs Docker locally for the WASM. |

Do the first:

1. Create a granular access token on npmjs.com: *Read and write*, *All packages*, expiry 1 day,
   *Bypass 2FA* ticked (a CI job cannot answer a 2FA prompt).
2. Add it as the secret `NPM_BOOTSTRAP_TOKEN` of the `npm` environment (Settings →
   Environments → `npm` → *Environment secrets*; not a repository secret). The publish step
   writes it to the job's `~/.npmrc` only when it is set, and warns.
3. Release 1.0.0 with the steps below (tag `v1.0.0`).
4. Set up the trusted publisher of each of the four packages (above).
5. Delete the `NPM_BOOTSTRAP_TOKEN` secret and revoke the token on npmjs.com. With the secret
   gone the publish step passes no token and npm uses OIDC. Then set *disallow tokens* per
   package (above).

npm tries the OIDC token before any configured token, so steps 4 and 5 can happen in either
order without breaking a release in between.

## Steps

1. **Bump.** In a PR to `main`:
   - Set all four versions at once and commit the lockfile with them:
     ```bash
     npm version <version> --no-git-tag-version -w unity-asset-reader \
       -w unity-asset-reader-texture -w unity-asset-reader-node -w unity-asset-reader-decoder
     npm install --package-lock-only
     ```
     The feature packages' peer range on `unity-asset-reader` stays `^<major>`, and the texture
     package's dependency on `unity-asset-reader-decoder` is `^<major>.<minor>.<patch>` of the
     same major; raise it to the new version when the texture package relies on a decoder change
     of this release. `scripts/tests/release.test.mjs` fails on a half-done bump.
   - `CHANGELOG.md`: the heading `## <version> - Unreleased` becomes `## <version> - <YYYY-MM-DD>`.
   - The docs for the release are on `main` (package READMEs, QUICK_START, bundler guide). A
     tarball without a README shows an empty page on npmjs.com.
   - Optional: *Run workflow* with `dry_run` on the PR branch once the workflow is on `main`;
     it builds and `npm publish --dry-run`s all four tarballs.
2. **Merge** the PR once CI is green.
3. **Tag** the merge commit on `main` and push the tag:
   ```bash
   git fetch origin main
   git tag -a v<version> -m "v<version>" origin/main
   git push origin v<version>
   ```
4. **Watch the Release run** (Actions → Release). It publishes all four, even if only one
   changed. If it fails:
   - Something outside the code (network, npm outage, trusted-publisher typo): fix it and
     *Re-run all jobs*. Packages already on npm at that version are skipped.
   - The code or the packaging: do not move the tag. Fix on `main` and release the next patch
     version of all four. Deprecate any package that did get out at the broken version:
     `npm deprecate <name>@<version> "incomplete release, use <next>"`.
5. **GitHub release.** Create it from the tag with the version's `CHANGELOG.md` section as notes:
   ```bash
   gh release create v<version> --title "v<version>" --notes-file <file with that section>
   ```
6. **After the publish.**
   - `examples/cdn-worker.js`: `VERSION` matches the published version; check the live jsDelivr
     path (#150).
   - The next change that ships opens a new `## <next version> - Unreleased` heading in
     `CHANGELOG.md`, and bumps the version with it so the release test keeps passing.

### Old decoder tags

The tags `v1.0.1`, `v1.2.0`, `v1.2.1` and `v1.2.2` already exist: they are releases of the decoder
under its old name, `texture2ddecoder-wasm`. `v1.0.0` is free, so the 1.0.0 release is not
affected, but a family release 1.0.1 or 1.2.0-1.2.2 cannot be tagged `v<version>` while those
tags exist (the push is refused). They have to be renamed before the family reaches 1.0.1 (#179).

### Deprecating `texture2ddecoder-wasm`

Once, after `unity-asset-reader-decoder@1.0.0` is on npm, by hand, from a shell logged in to npm
as a maintainer of the old name (2FA prompts; the workflow has no rights on that package):

```bash
npm deprecate texture2ddecoder-wasm "Renamed to unity-asset-reader-decoder; same API. Install unity-asset-reader-decoder instead."
```

Without a version range this marks every published version, including the untagged 1.0.0 of
the old name. The package stays installable; npm prints the message on install. See the
CHANGELOG.md 1.0.0 entry for the migration.

## After the repo rename

The repo is to be renamed to `unity-asset-reader` (plan D8). Two things follow it, before the
next release:

- `repository.url` in every `package.json`. GitHub redirects the old URL, but npm checks
  provenance against `repository.url`, which has to be the repository the job runs in. Keep each
  package's `repository.directory`.
- Each package's trusted publisher. It names the repository, so it has to name the new one. npm's
  docs say an existing connection cannot be changed, only deleted and added again
  ([npm docs](https://docs.npmjs.com/trusted-publishers)); do that per package.
