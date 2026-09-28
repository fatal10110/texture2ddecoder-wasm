# Releasing

Maintainer procedure for publishing to npm. The versioning policy is at the top of
[CHANGELOG.md](CHANGELOG.md).

Every package has its own version, and **a release is a version bump**: change the `version` in
the package's `package.json` and its `CHANGELOG.md` section, open a PR (its dry run shows what
will publish), merge, and the [Release workflow](.github/workflows/release.yml) publishes it.

| Package | Directory | Publish order |
|---|---|---|
| `texture2ddecoder-wasm` | `packages/decoder` | 1 |
| `unity-asset-reader` | `packages/core` | 2 |
| `unity-asset-reader-texture` | `packages/texture` | 3 |
| `unity-asset-reader-node` | `packages/node` | 4 |

Releases are published by the workflow, never from a laptop. It publishes with
[trusted publishing](https://docs.npmjs.com/trusted-publishers): npm authenticates the job by its
GitHub OIDC token, so the repo holds no npm token, and npm attaches a
[provenance statement](https://docs.npmjs.com/generating-provenance-statements) to every package
by itself. The only exception is the first publish, authenticated by a token, below.

## Steps

1. **Bump**, in a PR to `main`, for each package that ships:
   ```bash
   npm version <version> --no-git-tag-version -w <name>
   npm install --package-lock-only
   ```
   - `CHANGELOG.md`: in the package's section, `### <version> - Unreleased` becomes
     `### <version> - <YYYY-MM-DD>`. `scripts/tests/release.test.mjs` fails when the section has
     no heading for the version on disk.
   - When a package needs a new version of another package of this repo, raise its range too
     (the texture package's `texture2ddecoder-wasm` range, a feature package's peer range on
     `unity-asset-reader` after a new core major). Bump both in the same PR; the workflow
     publishes the dependency first. Or release the dependency in an earlier PR.
   - The docs for the release are in the PR or already on `main` (package READMEs, QUICK_START,
     bundler guide). A tarball without a README shows an empty page on npmjs.com.
2. **Check the PR's Release run.** A PR that changes a `packages/*/package.json` runs the
   workflow as a dry run: its notice lists exactly the `name@version`s the merge will publish,
   then it runs the whole gate and `npm publish --dry-run` for each. It fails when a package needs
   a range that neither npm nor an earlier package of the same release satisfies.
3. **Merge** once CI and the dry run are green. The push to `main` runs the workflow for real: it
   publishes the packages whose version changed in that push, then tags each one
   `<name>@<version>`.
4. **Watch the Release run** (Actions → Release). If it fails, see [When a release
   fails](#when-a-release-fails).
5. **GitHub release**, optional, from the tag, with the version's `CHANGELOG.md` section as notes:
   ```bash
   gh release create <name>@<version> --title "<name> <version>" --notes-file <file with that section>
   ```
6. **After the publish.** `examples/cdn-worker.js`: `CORE_VERSION` and `TEXTURE_VERSION` match
   published readers, and `DECODER_VERSION` (`1`) resolves to a decoder the texture package's
   range allows; check the live jsDelivr path (#150). The next change to a package opens a new
   `### <next version> - Unreleased` heading in its section of `CHANGELOG.md`, without touching
   the `version`: that would publish it.

Since merging a version change publishes, a `version` changes only in a release PR, never in a
feature PR.

## What the workflow does

`.github/workflows/release.yml` runs on:

| Event | What it releases | Publishes |
|---|---|---|
| `push` to `main` changing a `packages/*/package.json` | each package whose `version` differs from the commit before the push (`github.event.before`) | for real, in the `npm` environment |
| `pull_request` changing a `packages/*/package.json` | what the merge would release: the versions that differ from the PR's base | `npm publish --dry-run`; no environment, no secrets, no OIDC token |
| `workflow_dispatch` (Actions → Release → *Run workflow*) | each package whose current `name@version` is not on npm | `--dry-run` while `dry_run` is ticked (the default); for real, in the `npm` environment, when it is not |

A change to anything else, docs included, does not run it. In every case a `name@version` that is
already on npm is dropped, so a run with nothing left ends green with a notice.

1. **Plan** (`scripts/check-release.mjs`), before anything is built: the packages to release, in
   publish order. It fails when one of them has a range on another package of this repo
   (`dependencies`, `peerDependencies`) that no version on npm satisfies and no package published
   earlier in the same run satisfies either, naming the package, the range and what npm has.
   Nothing is published then.
2. **Gate:** `npm ci`, `npm run build:wasm` (Docker, the pinned emsdk of #57; the decoder tarball
   ships `wasm/`), `npm run verify` with `REQUIRE_WASM=1` (nothing may skip), and
   `npm test -w texture2ddecoder-wasm`. The submodule is checked out.
3. **Publish** each package, in order, with `npm publish -w <name> --access public` on Node 22
   and `npm@^11.5.1` (trusted publishing needs npm CLI 11.5.1 or later and Node 22.14.0 or later,
   [npm docs](https://docs.npmjs.com/trusted-publishers), checked 2026-09-28). Each reader
   package's `prepublishOnly` (`npm run verify --prefix ../..`) reruns the gate once more, and
   the decoder's rebuilds its WASM and bundle. A `name@version` already on npm is skipped.
4. **Tag** each package that got published, also when a later one failed: an annotated tag
   `<name>@<version>` (for example `texture2ddecoder-wasm@1.2.3`) on the released commit, pushed
   by a separate `tag` job, the only one with `contents: write`. An existing tag is skipped. Tags
   are records only; nothing runs on them.

The plan and the gate are one composite action (`.github/actions/release-gate`), used by both the
dry-run job and the publish job, so a PR's dry run plans and gates exactly like the push that
publishes it. Runs of the same ref queue (`concurrency.queue: max`); none is cancelled or dropped.

npm's trusted publisher checks the repository, the workflow file name and the environment, not
the ref. The `npm` environment admits only the `main` branch (see
[One-time setup](#github-environment-npm)), so a run on any other branch, including one that edits
its own copy of `release.yml`, either names no environment, which npm refuses, or names `npm`,
which GitHub does not start there.

The decoder's releases before 1.2.3 were tagged `v1.0.1` ... `v1.2.2`. Those tags stay as they
are; the `<name>@<version>` tags never collide with them.

## When a release fails

- **Outside the code** (network, npm outage, a trusted-publisher typo): fix it and *Re-run failed
  jobs*. The re-run plans again against the same commits and skips what is on npm already. Or run
  the workflow by hand on `main` with `dry_run` unticked: it publishes every version not on npm.
- **The code or the packaging:** fix it on `main` and release the next patch version. Deprecate
  any package that did get out at the broken version:
  `npm deprecate <name>@<version> "broken release, use <next>"`.
- **A plan with no usable base** (a push that force-pushed `main`, so the commit before it is
  gone) fails before anything is built. Run the workflow by hand on `main`, dry run first.
- **Only the tag job failed** (for example a tag ruleset without a bypass for GitHub Actions): the
  packages are on npm. Re-run the job, or tag the commit by hand:
  `git tag -a <name>@<version> -m "<name>@<version>" <commit> && git push origin <name>@<version>`.

## One-time setup

### GitHub environment `npm`

Settings → Environments → *New environment* `npm` (or edit the existing one), then under
*Deployment branches and tags* choose *Selected branches and tags* and have exactly one rule: type
**branch**, pattern `main`. No tag rules.

GitHub creates the `npm` environment by itself the first time a job names it, but then with no
branch rule, so any branch could deploy to it. Create it, or add the `main` rule to it, before the
first run of the workflow.

### Protect `main`

A push to `main` that changes a version publishes, so only reviewed changes may reach it: Settings
→ Rules → Rulesets → *New branch ruleset* targeting the default branch, with *Require a pull
request before merging*, *Require status checks to pass* (the CI checks) and *Block force pushes*,
bypassed by no one (or only by maintainers).

If a tag ruleset restricts creating tags, add the *GitHub Actions* app to its bypass list, or the
tag job cannot push the release tags.

### Trusted publisher, per package

npm links a trusted publisher to a package that **already exists** on the registry: the setting
lives in the package's own settings page (npmjs.com → the package → Settings → Trusted
publishing), and the `npm trust` command (npm 11.15.0 or later) requires that "the package you're
configuring must already exist on the npm registry"
([npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/), checked 2026-09-27).

- `unity-asset-reader`, `unity-asset-reader-texture` and `unity-asset-reader-node` are new names,
  so they can only be linked after the bootstrap publish below.
- `texture2ddecoder-wasm` is on npm already (1.2.2). Its trusted publisher can be linked before
  the bootstrap (it then publishes by OIDC, which npm tries before the token) or with the other
  three right after it.

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

### Bootstrap: the first publish, with a token

None of the three reader names is on npm yet, so none can have a trusted publisher yet, and the
first publish needs a token. The ways to do it, least bad first:

| Option | Cost |
|---|---|
| **Token in the workflow, once.** Publish the first release through this workflow, authenticated by a token in the **repository** secret `NPM_TOKEN` (maintainer decision 2026-09-28, #194; the secret is added already). | A repository secret is readable by every workflow job of the repo, not only by the `npm` environment's: only the `publish` job references it today, but any workflow merged to `main` could. So it lives for the first publish only and is deleted right after it. npm's token page selects from packages and scopes that exist, so for three new names it has to be an *All packages* token, which can publish every package of the account; keep its expiry short. In return the first release is built and gated exactly like every later one and still gets provenance (token publishes from GitHub Actions with `id-token: write` support it; the job sets `NPM_CONFIG_PROVENANCE=true`). |
| Placeholder publish from a laptop (for example a `0.0.0` of each name), then link the publishers, then release 1.0.0 through the workflow. | Three empty versions stay on npm for good (unpublishing one blocks reusing that version number), and each name's first version is junk. |
| `npm publish` of 1.0.0 from a laptop. | 1.0.0 has no provenance (npm generates it only in a supported CI runner), is built on one machine outside the gate, and needs Docker locally for the WASM. |

Do the first. See the next section for the order.

## The first release: decoder 1.2.3, then readers 1.0.0

The versions are on `main` already (`texture2ddecoder-wasm` 1.2.3, the three readers 1.0.0), so no
push will release them: the first release is a manual run. It publishes all four in one run, in
order: `texture2ddecoder-wasm@1.2.3` first (it carries the BC3 fix #137 and the Worker fix #149,
which the texture package's `^1.2.3` range and goldens rely on), then the readers.

Before it: set up the `npm` environment with its `main` branch rule and protect `main` (above).
If the environment does not exist yet, the first run creates it, without the rule. The repository
secret `NPM_TOKEN` is added already. It must hold a granular access token that can publish all
four names: *Read and write*, *All packages* (three names are new), *Bypass 2FA* ticked (a CI job
cannot answer a 2FA prompt). The publish step writes it to the job's `~/.npmrc` as a reference to
the environment variable, never the value, only when the secret is set, and warns. The `dry-run`
job never reads it.

1. **`NPM_TOKEN` repository secret** (already added). Optionally, a dry run first: Actions →
   Release → *Run workflow* on `main`, `dry_run` ticked. Its notice must list
   `texture2ddecoder-wasm@1.2.3 unity-asset-reader@1.0.0 unity-asset-reader-texture@1.0.0
   unity-asset-reader-node@1.0.0`, and the gate and every `npm publish --dry-run` must pass.
2. **Run the Release workflow by hand** on `main` with `dry_run` unticked. It publishes the four
   with the token and tags them.
3. **Link the trusted publisher of each of the four packages** (above).
4. **Delete the `NPM_TOKEN` secret** (Settings → Secrets and variables → Actions) and revoke the
   token on npmjs.com, right away: a repository secret is readable by every workflow job in the
   repo, not only the `npm` environment's. With the secret gone the publish step passes no token
   and npm uses OIDC. Then set *disallow tokens* per package (above).

Do step 3 before step 4. The other way round, a release in between has neither a token nor a
matching trusted publisher and fails with `ENEEDAUTH`. Once step 3 is done, a release works
whether or not the secret is still set, because npm tries the OIDC token before a configured one.

## After the repo rename

The repo is to be renamed to `unity-asset-reader` (plan D8). Two things follow it, before the
next release:

- `repository.url` in every `package.json`. GitHub redirects the old URL, but npm checks
  provenance against `repository.url`, which has to be the repository the job runs in. Keep each
  package's `repository.directory`. Changing it is not a version change, so it publishes nothing.
- Each package's trusted publisher. It names the repository, so it has to name the new one. npm's
  docs say an existing connection cannot be changed, only deleted and added again
  ([npm docs](https://docs.npmjs.com/trusted-publishers)); do that per package.
