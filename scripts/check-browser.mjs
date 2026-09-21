// Browser-safety and dependency-direction guard (R4, R14).
//
//   node scripts/check-browser.mjs [core|texture|texture2ddecoder-wasm ...]
//
// With no arguments every guarded package is checked. Exits 1 and prints every
// problem found, so a red run says what to fix.
import { build } from "esbuild";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Reader packages (core and feature packages), as import specifiers. */
const READER = /^unity-asset-reader(-[\w-]+)?(\/|$)/;
/** A subpath of a reader package: a deep import, never allowed (R14). */
const READER_DEEP = /^unity-asset-reader(-[\w-]+)?\//;

/** What each package is held to. `browser`: bundle for browsers. `noReader`: R14. */
export const PACKAGES = {
  core: { browser: true, noReader: true },
  texture: { browser: true, noReader: false },
  "texture2ddecoder-wasm": { browser: false, noReader: true },
};

// Preceded by `.` or a word char means a property or a longer name (`ArrayBuffer`).
const NODE_GLOBALS = [/(?<![.\w])Buffer\b/, /(?<![.\w])process\b/, /globalThis\.process\b/, /__dirname/];

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(ts|mjs|js)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

/**
 * Check one package directory.
 *
 * @param {string} root package directory (contains `src/`)
 * @param {{ browser: boolean, noReader: boolean }} rules what to enforce
 * @returns {Promise<string[]>} one message per problem; empty when clean
 */
export async function checkPackage(root, { browser, noReader }) {
  const problems = [];

  const files = sourceFiles(join(root, "src"));
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const [, spec] of text.matchAll(/(?:from|import\s*\(?|require\s*\()\s*["']([^"']+)["']/g)) {
      if (READER_DEEP.test(spec)) problems.push(`${file}: deep import "${spec}" (R14: public entry points only)`);
      else if (noReader && READER.test(spec)) problems.push(`${file}: imports "${spec}" (R14: core/decoder import no reader package)`);
    }
  }

  if (browser) {
    try {
      const { outputFiles } = await build({
        // Every source file, not just index.ts: files not yet wired to the entry count too (R4).
        entryPoints: files.filter((f) => !f.endsWith(".d.ts")),
        outdir: join(root, ".check-browser"),
        bundle: true,
        platform: "browser",
        format: "esm",
        write: false,
        logLevel: "silent",
        external: ["unity-asset-reader", "texture2ddecoder-wasm", "texture2ddecoder-wasm/*"],
      });
      const out = outputFiles.map((f) => f.text).join("\n");
      for (const re of NODE_GLOBALS) {
        const hit = out.match(re);
        if (hit) problems.push(`${root}: bundle references ${hit[0]} (R4: node-only global)`);
      }
    } catch (e) {
      // esbuild reports `Could not resolve "fs"` for node builtins on platform=browser.
      for (const err of e.errors ?? [e]) {
        const at = err.location ? `${err.location.file}:${err.location.line}: ` : "";
        problems.push(`${at}${err.text ?? err.message}`);
      }
    }
  }

  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(PACKAGES);
  const repo = resolve(fileURLToPath(import.meta.url), "../..");
  let failed = false;
  for (const name of names) {
    const rules = PACKAGES[name];
    if (!rules) throw new Error(`unknown package "${name}", expected one of ${Object.keys(PACKAGES)}`);
    const problems = await checkPackage(join(repo, "packages", name), rules);
    for (const p of problems) console.error(`✗ ${name}: ${p}`);
    if (problems.length) failed = true;
    else console.log(`✓ ${name}`);
  }
  process.exit(failed ? 1 : 0);
}
