// Static server for the examples, plus a stand-in for jsDelivr's `/+esm` endpoint
// that serves this repo's own builds. Used by the Playwright smoke test and for
// trying `cdn.html` before the reader packages are on npm (#45).
//
//   npm run build && node examples/serve.mjs      then open http://localhost:8080/
//
// Routes:
//   /examples/<file>       the files in this directory, as they are
//   /npm/<name>/+esm       redirect to the package's browser ESM entry
//   /npm/<name>/<path>     a file of node_modules/<name>, bare imports in .js/.mjs
//                          rewritten to /npm/<dep>/+esm, as jsDelivr does
//
// No COOP/COEP or any other special header: the page must work without them (D6).
import { createServer } from "node:http";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const EXAMPLES = dirname(fileURLToPath(import.meta.url));
const NODE_MODULES = join(EXAMPLES, "..", "node_modules");
const PORT = Number(process.env.PORT ?? 8080);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".md": "text/markdown; charset=utf-8",
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

/** Bare specifiers (not `./`, `../`, `/` or a URL) point at /npm/<name>/+esm. */
function rewriteBareImports(source) {
  return source.replace(
    /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"'./][^"':]*)\2/g,
    (_, keyword, quote, spec) => `${keyword}${quote}/npm/${spec}/+esm${quote}`,
  );
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function serveNpm(res, rest) {
  // `name` or `name@version`: the version is ignored, the workspace build is served.
  const [first = "", ...path] = rest.split("/");
  const name = first.replace(/@.*$/, "");
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

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname === "/") {
    res.writeHead(302, { Location: "/examples/cdn.html?local" });
    return res.end();
  }
  if (pathname.startsWith("/npm/")) return serveNpm(res, decodeURIComponent(pathname.slice(5)));
  if (pathname.startsWith("/examples/")) {
    const file = inside(EXAMPLES, join(EXAMPLES, decodeURIComponent(pathname.slice(10))));
    if (file !== undefined) {
      return send(res, 200, readFileSync(file), TYPES[extname(file)] ?? "application/octet-stream");
    }
  }
  send(res, 404, "not found");
}).listen(PORT, () => {
  console.log(`examples: http://localhost:${PORT}/examples/cdn.html?local`);
});
