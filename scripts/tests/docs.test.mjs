// Checks the user docs (#44): every link resolves, and each reader package's
// API reference names every export of its entry point.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "../..");
const read = (path) => readFileSync(join(root, path), "utf8");

/** Where a package README's links into this repo point: they must work on npmjs.com too. */
const REPO_BLOB = "https://github.com/fatal10110/unity-asset-reader/blob/main/";

test("package repository metadata points at the renamed repo (#199)", () => {
  for (const pkg of ["core", "texture", "node", "decoder"]) {
    const { repository } = JSON.parse(read(`packages/${pkg}/package.json`));
    assert.equal(repository.type, "git");
    assert.equal(repository.url, "https://github.com/fatal10110/unity-asset-reader.git");
    assert.equal(repository.directory, `packages/${pkg}`);
  }
});

/** Docs that live in the repo only: relative links, resolved against the file. */
const REPO_DOCS = ["README.md", "QUICK_START.md", "BUNDLER_GUIDE.md"];

/** READMEs that ship in a tarball, where a relative link has no file to point at. */
const PACKAGE_READMES = {
  core: "packages/core/README.md",
  texture: "packages/texture/README.md",
  node: "packages/node/README.md",
};

/** Markdown with fenced and inline code removed, so code is never read as a link. */
function prose(markdown) {
  return markdown.replace(/^```[\s\S]*?^```$/gm, "").replace(/`[^`\n]*`/g, "");
}

/** Every link target of a Markdown file, in order. */
function links(markdown) {
  return [...prose(markdown).matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
}

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces to hyphens. */
function slug(heading) {
  return heading
    .replace(/`/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

/** The anchors of a Markdown file's headings (outside code blocks). */
function anchors(markdown) {
  const headings = markdown.replace(/^```[\s\S]*?^```$/gm, "").matchAll(/^#{1,6} +(.+)$/gm);
  return new Set([...headings].map((m) => slug(m[1].trim())));
}

/**
 * Check one link that points into the repo: the file exists, and an anchor in
 * it names a heading of that file.
 *
 * @param from the doc the link is in, repo-relative
 * @param target the repo-relative path, with an optional `#anchor`
 */
function checkRepoTarget(from, target) {
  const [path, anchor] = target.split("#");
  const file = path === "" ? from : path;
  assert.ok(existsSync(join(root, file)), `${from}: link to ${target}: ${file} does not exist`);
  if (anchor !== undefined && file.endsWith(".md")) {
    assert.ok(
      anchors(read(file)).has(anchor),
      `${from}: link to ${target}: ${file} has no heading #${anchor}`,
    );
  }
}

/** The names a TypeScript entry point exports, types included. */
function exportsOf(source) {
  const names = [];
  for (const [, list] of source.matchAll(/^export (?:type )?\{([^}]*)\}/gm)) {
    for (const item of list.split(",")) {
      const name = item.trim().replace(/^type /, "").split(/ as /).pop()?.trim();
      if (name) names.push(name);
    }
  }
  for (const [, name] of source.matchAll(
    /^export (?:async )?(?:function|class|const|interface|type) ([A-Za-z_$][\w$]*)/gm,
  )) {
    names.push(name);
  }
  return names;
}

for (const doc of REPO_DOCS) {
  test(`${doc}: every relative link resolves`, () => {
    for (const target of links(read(doc))) {
      if (/^[a-z]+:/.test(target)) continue;
      // Resolve against the doc's own folder, then back to repo-relative.
      const [path, anchor] = target.split("#");
      const resolved = path === "" ? doc : relative(root, join(root, dirname(doc), path));
      checkRepoTarget(doc, anchor === undefined ? resolved : `${resolved}#${anchor}`);
    }
  });
}

for (const [pkg, readme] of Object.entries(PACKAGE_READMES)) {
  test(`${readme}: links work outside the repo and resolve`, () => {
    const targets = links(read(readme));
    assert.ok(targets.length > 0, `${readme} has no links`);
    for (const target of targets) {
      if (target.startsWith("#")) {
        checkRepoTarget(readme, target);
      } else if (target.startsWith(REPO_BLOB)) {
        checkRepoTarget(readme, target.slice(REPO_BLOB.length));
      } else {
        assert.match(target, /^https?:\/\//, `${readme}: relative link ${target} is dead on npm`);
      }
    }
  });

  test(`${readme}: the API reference names every export of packages/${pkg}/src/index.ts`, () => {
    const names = exportsOf(read(`packages/${pkg}/src/index.ts`));
    assert.ok(names.length > 0, `no exports found in packages/${pkg}/src/index.ts`);
    const section = read(readme).split(/^## API reference$/m)[1];
    assert.ok(section, `${readme} has no "## API reference" section`);
    const reference = section.split(/^## /m)[0];
    const documented = new Set([...reference.matchAll(/`([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
    const missing = names.filter((name) => !documented.has(name));
    assert.deepEqual(missing, [], `${readme}: API reference does not name ${missing.join(", ")}`);
  });
}

// #44 comment: the decoder README moved into packages/ with #55, where a
// relative CONTRIBUTING.md link has no file behind it.
test("decoder README links CONTRIBUTING.md through the repo URL", () => {
  const readme = "packages/decoder/README.md";
  const targets = links(read(readme)).filter((t) => t.includes("CONTRIBUTING"));
  assert.ok(targets.length > 0, `${readme} no longer links CONTRIBUTING.md`);
  for (const target of targets) {
    assert.ok(target.startsWith(REPO_BLOB), `${readme}: ${target} is not a repo URL`);
    checkRepoTarget(readme, target.slice(REPO_BLOB.length));
  }
});

// #208: the support tables say what the code supports, so they are checked
// against the code's own lists: the class reader registry, the texture
// package's format maps and the WASM bindings. A table that leaves one out, or
// lists one the code does not have, fails.

/** A Markdown section: the lines after `heading`, up to the next heading of its level or higher. */
function section(markdown, heading) {
  const level = heading.match(/^#+/)[0].length;
  const lines = markdown.replace(/^```[\s\S]*?^```$/gm, "").split("\n");
  const start = lines.indexOf(heading);
  assert.ok(start >= 0, `no "${heading}" heading`);
  const next = lines.findIndex((line, i) => i > start && (line.match(/^(#+) /)?.[1].length ?? 99) <= level);
  return lines.slice(start + 1, next < 0 ? undefined : next).join("\n");
}

/**
 * Cell `column` (1 is the first) of every body row of every Markdown table in `text`
 * (header and rule skipped).
 */
function tableCells(text, column = 1) {
  const cells = [];
  let row = 0;
  for (const line of text.split("\n")) {
    row = line.startsWith("|") ? row + 1 : 0;
    if (row > 2) cells.push(line.split("|")[column].trim());
  }
  return cells;
}

/** A top-level `const` of a TypeScript source, from `const <name>` to its closing `]);` or `};`. */
function declaration(source, name) {
  const start = source.search(new RegExp(`^(?:export )?const ${name}\\b`, "m"));
  assert.ok(start >= 0, `no const ${name}`);
  const length = source.slice(start).search(/^(?:\]\);|\}(?: as const)?;)$/m);
  assert.ok(length > 0, `no end to const ${name}`);
  return source.slice(start, start + length);
}

/** The keys of packages/core's `CLASS_READERS`: the classes with a hand-written reader. */
function classReaders() {
  const body = declaration(read("packages/core/src/classes/registry.ts"), "CLASS_READERS");
  const names = [...body.split("= {")[1].matchAll(/^ {2}(\w+): /gm)].map((m) => m[1]);
  assert.ok(names.length > 0, "no entries found in CLASS_READERS");
  return names;
}

/** Every name of packages/core's `TextureFormat`. */
function textureFormats() {
  const body = declaration(read("packages/core/src/classes/TextureFormat.ts"), "TextureFormat");
  const names = [...body.matchAll(/^ {2}(\w+): \d+,$/gm)].map((m) => m[1]);
  assert.ok(names.length > 0, "no entries found in TextureFormat");
  return names;
}

/** The `TextureFormat`s packages/texture decodes: the keys of its plain, block and Crunch maps. */
function decodedFormats() {
  const convert = read("packages/texture/src/convert.ts");
  const decode = read("packages/texture/src/decode.ts");
  const keys = (body) => [...body.matchAll(/\[TextureFormat\.(\w+),/g)].map((m) => m[1]);
  const names = [
    ...keys(declaration(convert, "BYTES_PER_PIXEL")),
    ...keys(declaration(decode, "BLOCK")),
    ...keys(declaration(decode, "CRUNCHED")),
  ];
  assert.ok(names.length > 0, "no decoded formats found in packages/texture");
  return names;
}

/** Every identifier written in backticks in `text`. */
function codeNames(text) {
  return new Set([...text.matchAll(/`(\w+)`/g)].map((m) => m[1]));
}

const sorted = (names) => [...names].sort();
const ROOT_SUPPORT = "## Supported formats and Unity versions";

test("core README: the Classes table lists exactly the classes of CLASS_READERS", () => {
  const table = section(read(PACKAGE_READMES.core), "### Classes");
  const rows = tableCells(table).map((cell) => cell.match(/^`(\w+)`/)?.[1] ?? cell);
  assert.deepEqual(sorted(rows), sorted(classReaders()));
});

test("core README: the version-stripped table lists exactly the classes of CLASS_READERS", () => {
  const table = section(read(PACKAGE_READMES.core), "### Version-stripped files");
  const rows = tableCells(table).map((cell) => cell.match(/^`(\w+)`$/)?.[1] ?? cell);
  assert.deepEqual(sorted(rows), sorted(classReaders()));
});

test("root README: the supported formats section names every class of CLASS_READERS", () => {
  const named = codeNames(section(read("README.md"), ROOT_SUPPORT));
  const missing = classReaders().filter((name) => !named.has(name));
  assert.deepEqual(missing, [], `README.md does not name ${missing.join(", ")}`);
});

test("texture README: the format table lists exactly the TextureFormats the package decodes", () => {
  const all = new Set(textureFormats());
  const decoded = decodedFormats();
  const unknown = decoded.filter((name) => !all.has(name));
  assert.deepEqual(unknown, [], `decoded formats missing from TextureFormat: ${unknown}`);
  // Only the Formats column counts: other cells name formats too (the 3DS row's decoder).
  const formats = tableCells(section(read(PACKAGE_READMES.texture), "## Texture formats"), 2);
  const listed = [...codeNames(formats.join(" "))].filter((name) => all.has(name));
  assert.deepEqual(sorted(listed), sorted(decoded));
});

test("texture and root README: every TextureFormat not decoded is listed as not supported", () => {
  const decoded = new Set(decodedFormats());
  const refused = textureFormats().filter((name) => !decoded.has(name));
  assert.ok(refused.length > 0, "every TextureFormat decodes: update this test");
  for (const [doc, heading] of [
    [PACKAGE_READMES.texture, "## Not supported"],
    ["README.md", ROOT_SUPPORT],
  ]) {
    const named = codeNames(section(read(doc), heading));
    const missing = refused.filter((name) => !named.has(name));
    assert.deepEqual(missing, [], `${doc}: "${heading}" does not list ${missing.join(", ")}`);
  }
});

test("decoder README: Supported Formats has one row per function the WASM exports", () => {
  const bindings = read("packages/decoder/wasm_bindings.cpp");
  const exported = [...bindings.matchAll(/^\s*function\("(\w+)"/gm)].map((m) => m[1]);
  assert.ok(exported.length > 0, "no function() bindings in wasm_bindings.cpp");
  const table = section(read("packages/decoder/README.md"), "## Supported Formats");
  const rows = table.split("\n").filter((line) => line.startsWith("|")).slice(2);
  const functions = rows.map((row) => row.split("|")[2].trim().match(/^`(\w+)`$/)?.[1] ?? row);
  assert.deepEqual(sorted(functions), sorted(exported));
});
