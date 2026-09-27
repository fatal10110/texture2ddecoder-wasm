# Releasing

Maintainer procedure for publishing to npm. The versioning policy (all four packages in
lockstep) is at the top of [CHANGELOG.md](CHANGELOG.md).

| Package | Directory | Released |
|---|---|---|
| `unity-asset-reader` | `packages/core` | with the other three, same version |
| `unity-asset-reader-texture` | `packages/texture` | with the other three, same version |
| `unity-asset-reader-node` | `packages/node` | with the other three, same version |
| `unity-asset-reader-decoder` | `packages/decoder` | with the other three, same version |

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
either. The decoder's own `prepublishOnly` rebuilds its WASM and bundle, as before.

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
   - Versions: the four `package.json` files carry the same version (the root test
     `scripts/tests/release.test.mjs` fails otherwise), the feature packages' peer range on
     `unity-asset-reader` is `^<major>`, and the texture package's dependency on
     `unity-asset-reader-decoder` is `^<major>.<minor>.<patch>` of the same major. For a new
     version, set all four at once and commit the lockfile with them:
     ```bash
     npm version <version> --no-git-tag-version -w unity-asset-reader \
       -w unity-asset-reader-texture -w unity-asset-reader-node -w unity-asset-reader-decoder
     npm install --package-lock-only
     ```
     Raise the texture package's decoder range to the new version when it relies on a decoder
     change of that release.
   - Names: `npm view <name>` answers 404 for a name nobody has published yet (checked for the
     three reader names on 2026-09-27; check `unity-asset-reader-decoder` too). The scoped
     fallback is `@unity-asset-reader/{core,texture,node,decoder}` (plan D7); names are final at
     first publish.
   - Tarballs: `npm pack --dry-run -w <name>` lists `dist/`, `LICENSE`, `NOTICE` (and
     `LICENSE-APACHE` for the texture package), plus `README.md` and `package.json`. The
     decoder's lists `dist/`, `wasm/`, `scripts/copy-wasm.js`, `LICENSE`, `README.md` and
     `package.json`.
2. **Decoder first, then core, then the feature packages.** One command each, so what a package
   depends or peers on is on npm before it:
   ```bash
   npm publish -w unity-asset-reader-decoder --provenance
   npm publish -w unity-asset-reader --provenance
   npm publish -w unity-asset-reader-texture --provenance
   npm publish -w unity-asset-reader-node --provenance
   ```
   All four go out even if only one changed. If one fails, fix the cause and publish the rest
   at the same version; never publish a package at a version the others do not have.
3. **Tag and release notes.** Tag the published commit and create a GitHub release whose notes
   are the version's `CHANGELOG.md` section. The existing `v1.0.1` ... `v1.2.2` tags are
   releases of the decoder under its old name, and npm already has an untagged 1.0.0 of that
   name, so a bare `v1.0.0` would be ambiguous. New tags name the family:
   `unity-asset-reader@<version>`, one tag for all four packages.
4. **After the publish.**
   - `examples/cdn-worker.js`: `VERSION` matches the published version; check the live jsDelivr
     path (#150).
   - First publish only: deprecate the old decoder name with a pointer to the new one
     (maintainer, by hand; see CHANGELOG.md 1.0.0).
   - The next change that ships opens a new `## <next version> - Unreleased` heading in
     `CHANGELOG.md`, and bumps the version with it so the release test keeps passing.

## After the repo rename

The repo is to be renamed to `unity-asset-reader` (plan D8). GitHub redirects the old URL, but
provenance does not follow redirects, so update `repository.url` in every `package.json` to the
new one before the next publish. Keep each package's `repository.directory`.
