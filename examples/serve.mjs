// Static server for the examples and the docs/ demo, plus a stand-in for
// jsDelivr's `/+esm` endpoint that serves this repo's own builds. Used by the
// Playwright tests and for trying the pages on this repo's builds (#45, #209).
//
//   npm run build && node examples/serve.mjs      then open http://127.0.0.1:8080/
//
// Routes:
//   /examples/<file>       the files in this directory, as they are
//   /docs/<file>           the GitHub Pages site (the demo, docs/index.html), as it is
//   /fixtures/bundles/<f>  the fixture bundles, which the demo's samples load with `?local`
//   /npm/<name>/+esm       redirect to the package's browser ESM entry
//   /npm/<name>/<path>     a file of node_modules/<name>, bare imports in .js/.mjs
//                          rewritten to /npm/<dep>/+esm, as jsDelivr does
//
// Only the packages the pages' Workers load are served (SERVED), and only on 127.0.0.1.
// No COOP/COEP or any other special header: the page must work without them (D6).
import { createServer } from "node:http";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const EXAMPLES = dirname(fileURLToPath(import.meta.url));
const NODE_MODULES = join(EXAMPLES, "..", "node_modules");
/** The GitHub Pages site (docs/index.html, the demo) and the fixture bundles its samples load. */
const DOCS = join(EXAMPLES, "..", "docs");
const FIXTURE_BUNDLES = join(EXAMPLES, "..", "fixtures", "bundles");

/** npm package name, unscoped: nothing served here needs a scope. */
const NPM_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * The packages cdn-worker.js imports, and what they import in turn (their
 * `dependencies` and `peerDependencies`). Nothing else under node_modules is served.
 */
export const SERVED = new Set();
for (const queue = ["unity-asset-reader", "unity-asset-reader-texture"]; queue.length > 0; ) {
  const name = queue.shift();
  if (SERVED.has(name)) continue;
  SERVED.add(name);
  const pkg = JSON.parse(readFileSync(join(NODE_MODULES, name, "package.json"), "utf8"));
  queue.push(...Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }));
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".md": "text/markdown; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/** `file` if it is a file inside `root` (symlinks resolved), else undefined. */
function inside(root, file) {
  try {
    const real = realpathSync(file);
    const base = realpathSync(root);
    return real.startsWith(base + sep) && statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** The ESM entry a browser gets: `exports["."]` (browser, import, default), then `module`. */
function esmEntry(pkg) {
  const pick = (target) =>
    typeof target === "string" || target == null
      ? target
      : pick(target.browser ?? target.import ?? target.default);
  const exported = pkg.exports?.["."] ?? pkg.exports;
  return pick(typeof exported === "object" ? exported : undefined) ?? pkg.module ?? pkg.main;
}

/** A bare specifier: not `./`, `../`, `/` or a URL. */
const BARE = String.raw`([^'"./][^'":]*)`;
// Statement-shaped only, as jsDelivr's Rollup rewrite: `import ... from "x"`,
// `export ... from "x"` and `import "x"` at the start of a line, and a literal
// `import("x")`. A line that does not start with import/export stays as it is.
// ponytail: a line-based match, not a parser. A quoted `from "x"` in a comment or
// template literal on an import/export line, or `import("x")` inside a string, is
// still rewritten; no served module has one. Use a tokenizer if one ever does.
const STATIC_IMPORT = new RegExp(
  String.raw`^(\s*(?:import|export)\b[^;'"]*?\bfrom\s*|\s*import\s*)(['"])${BARE}\2`,
  "gm",
);
const DYNAMIC_IMPORT = new RegExp(String.raw`(\bimport\(\s*)(['"])${BARE}\2(\s*\))`, "g");

/** Point bare imports at /npm/<name>/+esm, as jsDelivr's `/+esm` does. */
export function rewriteBareImports(source) {
  return source
    .replace(STATIC_IMPORT, (_, head, quote, spec) => `${head}${quote}/npm/${spec}/+esm${quote}`)
    .replace(
      DYNAMIC_IMPORT,
      (_, head, quote, spec, tail) => `${head}${quote}/npm/${spec}/+esm${quote}${tail}`,
    );
}

/** URL prefix -> folder served as it is. */
const STATIC = [
  ["/examples/", EXAMPLES],
  ["/docs/", DOCS],
  ["/fixtures/bundles/", FIXTURE_BUNDLES],
];

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function serveNpm(res, rest) {
  // `name` or `name@version`: the version is ignored, the workspace build is served.
  const [first = "", ...path] = rest.split("/");
  const name = first.replace(/@.*$/, "");
  if (!NPM_NAME.test(name) || !SERVED.has(name)) return send(res, 404, `not served: ${name}`);
  const root = join(NODE_MODULES, name);
  if (path.join("/") === "+esm") {
    let entry;
    try {
      entry = esmEntry(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
    } catch {
      return send(res, 404, `no package ${name}`);
    }
    res.writeHead(302, { Location: `/npm/${name}/${entry.replace(/^\.\//, "")}` });
    return res.end();
  }
  const file = inside(root, join(root, ...path));
  if (file === undefined) return send(res, 404, `not found: ${name}/${path.join("/")}`);
  const ext = extname(file);
  const body = readFileSync(file);
  if (ext === ".js" || ext === ".mjs") {
    return send(res, 200, rewriteBareImports(body.toString("utf8")), TYPES[ext]);
  }
  return send(res, 200, body, TYPES[ext] ?? "application/octet-stream");
}

/**
 * The examples server; not listening yet. Run this file to listen on
 * 127.0.0.1:$PORT (default 8080).
 */
export function createExamplesServer() {
  return createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    } catch {
      return send(res, 400, "malformed URL");
    }
    if (pathname === "/") {
      res.writeHead(302, { Location: "/examples/cdn.html?local" });
      return res.end();
    }
    if (pathname.startsWith("/npm/")) return serveNpm(res, pathname.slice(5));
    for (const [prefix, root] of STATIC) {
      if (!pathname.startsWith(prefix)) continue;
      const rest = pathname.slice(prefix.length);
      const file = inside(root, join(root, rest === "" ? "index.html" : rest));
      if (file !== undefined) {
        return send(res, 200, readFileSync(file), TYPES[extname(file)] ?? "application/octet-stream");
      }
    }
    send(res, 404, "not found");
  });
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  createExamplesServer().listen(port, "127.0.0.1", () => {
    console.log(`examples: http://127.0.0.1:${port}/examples/cdn.html?local`);
    console.log(`demo:     http://127.0.0.1:${port}/docs/?local`);
  });
}
