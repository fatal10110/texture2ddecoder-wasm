// Checks the user docs (#44): every link resolves, and each reader package's
// API reference names every export of its entry point.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "../..");
const read = (path) => readFileSync(join(root, path), "utf8");

/** Where a package README's links into this repo point: they must work on npmjs.com too. */
const REPO_BLOB = "https://github.com/fatal10110/texture2ddecoder-wasm/blob/main/";

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
test("texture2ddecoder-wasm README links CONTRIBUTING.md through the repo URL", () => {
  const readme = "packages/texture2ddecoder-wasm/README.md";
  const targets = links(read(readme)).filter((t) => t.includes("CONTRIBUTING"));
  assert.ok(targets.length > 0, `${readme} no longer links CONTRIBUTING.md`);
  for (const target of targets) {
    assert.ok(target.startsWith(REPO_BLOB), `${readme}: ${target} is not a repo URL`);
    checkRepoTarget(readme, target.slice(REPO_BLOB.length));
  }
});
