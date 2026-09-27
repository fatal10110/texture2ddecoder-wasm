// examples/serve.mjs (#35): serves only what cdn-worker.js loads, survives bad URLs,
// and rewrites import statements only.
import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, test } from "node:test";
import { createExamplesServer, rewriteBareImports, SERVED } from "../../examples/serve.mjs";

const server = createExamplesServer();
let port;
before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});
after(() => server.close());

/** GET a raw path (no URL normalization, so `..%2F` reaches the server as sent). */
function get(path) {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location }));
    })
      .on("error", reject)
      .end();
  });
}

test("serves the packages cdn-worker.js loads, and their dependencies", async () => {
  assert.deepEqual([...SERVED].sort(), [
    "fflate",
    "lzma1",
    "texture2ddecoder-wasm",
    "unity-asset-reader",
    "unity-asset-reader-texture",
  ]);
  assert.deepEqual(await get("/npm/unity-asset-reader@1.0.0/+esm"), {
    status: 302,
    location: "/npm/unity-asset-reader/dist/index.mjs",
  });
  assert.equal((await get("/npm/fflate/package.json")).status, 200);
});

test("nothing outside the served packages is reachable", async () => {
  for (const path of [
    "/npm/..%2Fpackage.json",
    "/npm/..%2Fdocs%2Funity-asset-reader-plan.md",
    "/npm/%2E%2E/package.json",
    "/npm/fflate/..%2F..%2Fpackage.json",
    "/npm/fflate/%2E%2E/%2E%2E/package.json",
    "/npm/typescript/package.json",
    "/examples/..%2Fpackage.json",
  ]) {
    assert.equal((await get(path)).status, 404, path);
  }
});

test("a malformed escape is a 400, and the server keeps running", async () => {
  assert.equal((await get("/npm/%E0%A4%A")).status, 400);
  assert.equal((await get("/examples/cdn.html")).status, 200);
});

test("only import statements are rewritten, not comments or strings", () => {
  const source = [
    `import { a } from 'fflate';`,
    `import {`,
    `  b,`,
    `} from "lzma1";`,
    `export { c } from "unity-asset-reader";`,
    `import "side-effect";`,
    `import { d } from "./local.js";`,
    `const e = await import("texture2ddecoder-wasm");`,
    ` * we just cannot read it" from "this file is broken`,
    `const f = 'not supported" from "corrupt';`,
  ].join("\n");
  assert.equal(
    rewriteBareImports(source),
    [
      `import { a } from '/npm/fflate/+esm';`,
      `import {`,
      `  b,`,
      `} from "/npm/lzma1/+esm";`,
      `export { c } from "/npm/unity-asset-reader/+esm";`,
      `import "/npm/side-effect/+esm";`,
      `import { d } from "./local.js";`,
      `const e = await import("/npm/texture2ddecoder-wasm/+esm");`,
      ` * we just cannot read it" from "this file is broken`,
      `const f = 'not supported" from "corrupt';`,
    ].join("\n"),
  );
});
