# Releasing

Maintainer procedure for publishing to npm. The versioning policy (reader packages in lockstep,
`texture2ddecoder-wasm` on its own line) is at the top of [CHANGELOG.md](CHANGELOG.md).

| Package | Directory | Released |
|---|---|---|
| `unity-asset-reader` | `packages/core` | with the other two reader packages, same version |
| `unity-asset-reader-texture` | `packages/texture` | with the other two reader packages, same version |
| `unity-asset-reader-node` | `packages/node` | with the other two reader packages, same version |
| `texture2ddecoder-wasm` | `packages/texture2ddecoder-wasm` | only when it changed since its last npm version |

## Release gate

Every publish starts from a clean checkout of `main` and passes the root verification:

```bash
git submodule update --init --recursive
npm ci
npm run build:wasm               # Docker; without the WASM the texture decode tests skip
REQUIRE_WASM=1 npm run verify    # build, test, check:browser, no-C# guard; nothing may skip
```

Each reader package also has `"prepublishOnly": "npm run verify --prefix ../.."`, so
`npm publish` reruns the root `verify` and refuses to publish when it fails. Keep
`REQUIRE_WASM=1` set in the shell that publishes, so the rerun does not skip the decode tests
either. `texture2ddecoder-wasm`'s own `prepublishOnly` rebuilds its WASM and bundle, as before.

## Provenance

`npm publish --provenance` works only inside a supported CI runner (GitHub Actions with
`permissions: id-token: write`, or GitLab CI). From a local shell npm refuses with
`Automatic provenance generation not supported`. So run the publish commands below from a
GitHub Actions job on the tagged commit, with an npm automation token (`NODE_AUTH_TOKEN`) or,
once the packages exist on npm, a trusted-publisher link. The job must run the release gate
first (it needs Docker for `build:wasm`, which `ubuntu-latest` has); `prepublishOnly` then
reruns it per package.

npm checks the provenance against `repository.url`: the URL in `package.json` has to be the
repository the job runs in. Publish before the repo rename, or do the rename step below first.

## Steps

1. **Pre-flight.**
   - The docs for the release are on `main` (package READMEs, QUICK_START, bundler guide: #44).
     A tarball without a README shows an empty page on npmjs.com.
   - `CHANGELOG.md`: in the headings of what ships, `### <version> - Unreleased` becomes
     `### <version> - <YYYY-MM-DD>`.
   - Versions: the three reader `package.json` files carry the same version (the root test
     `scripts/tests/release.test.mjs` fails otherwise), and the feature packages' peer range on
     `unity-asset-reader` is `^<major>`. For a new version, set all three at once and commit the
     lockfile with them:
     ```bash
     npm version <version> --no-git-tag-version \
       -w unity-asset-reader -w unity-asset-reader-texture -w unity-asset-reader-node
     npm install --package-lock-only
     ```
   - Names: `npm view <name>` answers 404 for a name nobody has published yet (checked for the
     three reader names on 2026-09-27). The scoped fallback is
     `@unity-asset-reader/{core,texture,node}` (plan D7); names are final at first publish.
   - Tarballs: `npm pack --dry-run -w <name>` lists `dist/`, `LICENSE`, `NOTICE` (and
     `LICENSE-APACHE` for the texture package), plus `README.md` and `package.json`.
2. **Decoder first, if it changed.** Compare `packages/texture2ddecoder-wasm/package.json`'s
   version with `npm view texture2ddecoder-wasm version`. If the local one is newer:
   ```bash
   npm publish -w texture2ddecoder-wasm --provenance
   ```
   Publishing it before the reader packages means a fresh install of
   `unity-asset-reader-texture` already resolves the fixed decoder.
3. **Reader packages, core first.** One command each, so core is on npm before the packages
   that peer on it:
   ```bash
   npm publish -w unity-asset-reader --provenance
   npm publish -w unity-asset-reader-texture --provenance
   npm publish -w unity-asset-reader-node --provenance
   ```
   All three go out even if only one changed. If one fails, fix the cause and publish the rest
   at the same version; never publish a reader package at a version the others do not have.
4. **Tag and release notes.** Tag the published commit and create a GitHub release whose notes
   are the version's `CHANGELOG.md` section. The existing `v1.0.1` ... `v1.2.2` tags are
   `texture2ddecoder-wasm` releases, and `v1.0.0` is taken by it too, so new tags name the
   package: `unity-asset-reader@<version>` for the lockstep reader release (one tag for all
   three) and `texture2ddecoder-wasm@<version>` for a decoder release.
5. **After the publish.**
   - `examples/cdn-worker.js`: `READER_VERSION` matches the published reader version; check the
     live jsDelivr path (#150).
   - A decoder release with a fix the texture package relies on: raise the texture package's
     `texture2ddecoder-wasm` floor to it (for 1.2.3: #147).
   - The next change that ships opens a new `### <next version> - Unreleased` heading in
     `CHANGELOG.md`, and bumps the version with it so the release test keeps passing.

## After the repo rename

The repo is to be renamed to `unity-asset-reader` (plan D8). GitHub redirects the old URL, but
provenance does not follow redirects, so update `repository.url` in every `package.json` to the
new one before the next publish. Keep each reader package's `repository.directory` and add
`"directory": "packages/texture2ddecoder-wasm"` to the decoder's, which has none yet.
