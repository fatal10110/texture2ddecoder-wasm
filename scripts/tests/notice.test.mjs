import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "../..");
const read = (path) => readFileSync(join(root, path), "utf8");

/** Upstream project URLs of the `Name -- https://...` stanzas in a NOTICE. */
function upstreams(notice) {
  return [...notice.matchAll(/^\S.* -- (https:\/\/\S+)/gm)].map((m) => m[1]);
}

// The per-package NOTICE files are authoritative (#75); the root one must not
// drop an upstream any of them names.
test("root NOTICE names every upstream of the per-package NOTICE files", () => {
  const rootNotice = read("NOTICE");
  const rootUpstreams = new Set(upstreams(rootNotice));
  for (const pkg of ["core", "texture", "node"]) {
    const named = upstreams(read(`packages/${pkg}/NOTICE`));
    assert.ok(named.length > 0, `packages/${pkg}/NOTICE lists no upstream`);
    for (const url of named) {
      // The decoder is a workspace package, not an upstream; the root NOTICE
      // points at its LICENSE instead. Its URL is this repo's until the rename (plan D8).
      if (url.endsWith("/fatal10110/texture2ddecoder-wasm")) continue;
      assert.ok(rootUpstreams.has(url), `root NOTICE is missing ${url} (packages/${pkg}/NOTICE)`);
    }
  }
});

test("root NOTICE points at every per-package notice file", () => {
  const rootNotice = read("NOTICE");
  for (const path of [
    "packages/core/NOTICE",
    "packages/texture/NOTICE",
    "packages/node/NOTICE",
    "packages/decoder/LICENSE",
  ]) {
    assert.ok(rootNotice.includes(path), `root NOTICE does not mention ${path}`);
  }
});

/** The body of a Markdown file's `## <heading>` section, up to the next `## `. */
function section(markdown, heading) {
  const body = markdown.split(new RegExp(`^## ${heading}$`, "m"))[1];
  assert.ok(body !== undefined, `no "## ${heading}" section`);
  return body.split(/^## /m)[0];
}

/** `owner/repo` of every codec source line (`ATC: MIT License - Perfare/AssetStudio`). */
function decoderCodecSources() {
  const license = read("packages/decoder/LICENSE");
  return [...license.matchAll(/^[\w ()]+: [\w ]+ - (\S+\/\S+)$/gm)].map((m) => m[1]);
}

/** The projects the `// Ported from` lines under `packages/<pkg>/src` name, e.g. "AssetStudio". */
function portedProjects(pkg) {
  const projects = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith(".ts")) {
        for (const line of read(path).split("\n")) {
          if (!line.startsWith("// Ported from ")) continue;
          // A source path is "<Project>[.<Module>]/<file>": "AssetStudio.Utility/…" is
          // AssetStudio. A second file of the same project ("and HalfHelper.cs") has no
          // slash. "based on AssetsTools.NET's …" names the upstream of a UnityPy port.
          for (const m of line.matchAll(/(?:from|and) ([A-Za-z]+)(?:\.[A-Za-z]+)?\//g)) {
            projects.add(m[1]);
          }
          for (const m of line.matchAll(/based on ([A-Za-z]+(?:\.NET)?)'s/g)) projects.add(m[1]);
        }
      }
    }
  };
  walk(`packages/${pkg}/src`);
  return projects;
}

// #207: the root README credits every upstream, with its link and license.
test("root README Acknowledgements link every upstream with its license", () => {
  const credits = section(read("README.md"), "Acknowledgements");
  const urls = new Set(upstreams(read("NOTICE")));
  for (const pkg of ["core", "texture", "node"]) {
    for (const url of upstreams(read(`packages/${pkg}/NOTICE`))) urls.add(url);
  }
  for (const source of decoderCodecSources()) urls.add(`https://github.com/${source}`);
  urls.delete("https://github.com/fatal10110/texture2ddecoder-wasm");
  assert.ok(urls.size >= 8, `expected at least 8 upstreams, found ${urls.size}`);
  for (const url of urls) {
    const row = credits.split("\n").find((line) => line.includes(`](${url}`));
    assert.ok(row, `root README Acknowledgements do not link ${url}`);
    assert.match(row, /MIT|Apache-2\.0|zlib|public domain/, `no license next to ${url}`);
  }
});

test("root README Acknowledgements name every project a Ported from line cites", () => {
  const credits = section(read("README.md"), "Acknowledgements");
  const projects = new Set();
  for (const pkg of ["core", "texture", "node"]) {
    for (const project of portedProjects(pkg)) projects.add(project);
  }
  assert.ok(projects.has("AssetStudio") && projects.has("UnityPy"), [...projects].join(", "));
  for (const project of projects) {
    assert.ok(credits.includes(project), `root README Acknowledgements do not name ${project}`);
  }
});

test("each reader package README credits its NOTICE upstreams and ported sources", () => {
  for (const pkg of ["core", "texture", "node"]) {
    const readme = `packages/${pkg}/README.md`;
    const credits = section(read(readme), "Acknowledgements");
    for (const url of upstreams(read(`packages/${pkg}/NOTICE`))) {
      if (url.endsWith("/fatal10110/texture2ddecoder-wasm")) {
        assert.ok(credits.includes("texture2ddecoder-wasm"), `${readme} does not credit the decoder`);
        continue;
      }
      assert.ok(credits.includes(`](${url})`), `${readme} Acknowledgements do not link ${url}`);
    }
    for (const project of portedProjects(pkg)) {
      assert.ok(credits.includes(project), `${readme} Acknowledgements do not name ${project}`);
    }
  }
});

test("decoder README credits texture2ddecoder, Emscripten and every codec source", () => {
  const credits = section(read("packages/decoder/README.md"), "License & Credits");
  const sources = decoderCodecSources();
  assert.equal(sources.length, 8, `packages/decoder/LICENSE codec lines: ${sources.join(", ")}`);
  for (const source of ["K0lb3/texture2ddecoder", "emscripten-core/emscripten", ...sources]) {
    assert.ok(
      credits.includes(`](https://github.com/${source}`),
      `packages/decoder/README.md License & Credits do not link ${source}`,
    );
  }
});
