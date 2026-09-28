// `open()` (#183): fetch from a local HTTP server, read a Blob / File / Response,
// name files after the URL, refuse a non-OK response, and use a caller's fetch.

import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { golden, loadFixture, sha256 } from "../../../fixtures/helpers.js";
import { load } from "../src/env.js";
import { open } from "../src/open.js";

const BUNDLE = "editor/6000.3.25f1/lz4/texture";
const bundle = loadFixture(BUNDLE);
/** The bundle's two nodes, to serve as loose files: a SerializedFile and its .resS. */
const [serialized, resS] = load(bundle).files as [
  { path: string; data: Uint8Array },
  { path: string; data: Uint8Array },
];

/** URL path -> body. Anything else is a 404. */
const ROUTES = new Map<string, Uint8Array>([
  ["/bundles/texture.bundle", bundle],
  [`/loose/${serialized.path}`, serialized.data],
  [`/loose/${resS.path}`, resS.data],
  ["/loose/my%20file.bin", new Uint8Array([7, 7, 7])],
]);

let base = "";
/** Request headers per URL path, for the custom-fetch test. */
const seen = new Map<string, IncomingHttpHeaders>();
const server = createServer((req, res) => {
  const path = new URL(req.url!, "http://x").pathname;
  seen.set(path, req.headers);
  const body = ROUTES.get(path);
  if (!body) {
    res.writeHead(404, "Not Found").end();
    return;
  }
  res.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const fileHashes = (files: { path: string; data: Uint8Array }[]) =>
  files.map(({ path, data }) => ({ path, sha256: sha256(data) }));
const expectedFiles = Object.entries(golden(BUNDLE).files).map(([path, { sha256 }]) => ({
  path,
  sha256,
}));

test("a URL string is fetched and loaded", async () => {
  const env = await open(`${base}/bundles/texture.bundle`);
  assert.deepStrictEqual(fileHashes(env.files), expectedFiles);
  assert.equal(env.get("assets/fixtures/texture/checker.png")?.name, "checker");
});

test("loose files are named after the URL's last path segment, without the query", async () => {
  const env = await open([
    `${base}/loose/${serialized.path}?v=3#top`,
    new URL(`${base}/loose/${resS.path}?cache=no`),
  ]);
  assert.deepStrictEqual(
    env.files.map((f) => f.path),
    [serialized.path, resS.path],
  );
  // The names are what lets the texture find its .resS.
  const [texture] = env.assets("Texture2D");
  assert.equal(texture!.data.imageData.length, 64);

  const decoded = await open(`${base}/loose/my%20file.bin`);
  assert.deepStrictEqual(
    decoded.files.map((f) => f.path),
    ["my file.bin"],
  );
});

test("a Request is fetched, a Response is read", async () => {
  const fromRequest = await open(new Request(`${base}/bundles/texture.bundle`));
  assert.deepStrictEqual(fileHashes(fromRequest.files), expectedFiles);

  const response = await fetch(`${base}/loose/${resS.path}`);
  const fromResponse = await open(response);
  assert.deepStrictEqual(
    fromResponse.files.map((f) => f.path),
    [resS.path],
  );
});

test("a Blob gets the default name, a File keeps its own", async () => {
  const env = await open([
    new File([serialized.data], serialized.path),
    new File([resS.data], resS.path),
    new Blob([new Uint8Array([1, 2])]),
  ]);
  assert.deepStrictEqual(
    env.files.map((f) => f.path),
    [serialized.path, resS.path, "input 2"],
  );
  const [texture] = env.assets("Texture2D");
  assert.equal(texture!.data.imageData.length, 64);

  const blob = await open(new Blob([bundle]));
  assert.deepStrictEqual(fileHashes(blob.files), expectedFiles);
});

test("bytes and { name, data } pass straight to load()", async () => {
  const env = await open([bundle, { name: resS.path, data: resS.data }]);
  assert.deepStrictEqual(
    env.files.map((f) => f.path),
    [...expectedFiles.map((f) => f.path), resS.path],
  );
});

test("a non-OK response throws, naming the URL and the status", async () => {
  const url = `${base}/bundles/missing.bundle`;
  await assert.rejects(open(url), { message: `${url}: HTTP 404 Not Found` });
  // A Response passed in is checked the same way.
  const response = await fetch(url);
  await assert.rejects(open(response), { message: `${url}: HTTP 404 Not Found` });
});

test("a failed fetch names the URL", async () => {
  // Nothing listens on port 1.
  await assert.rejects(open("http://127.0.0.1:1/a.bundle"), {
    message: /^http:\/\/127\.0\.0\.1:1\/a\.bundle: /,
  });
});

test("options.fetch is used instead of the global fetch", async () => {
  const calls: unknown[] = [];
  const sources = [`${base}/bundles/texture.bundle`, new Request(`${base}/loose/${resS.path}`)];
  const env = await open(sources, {
    fetch: (input) => {
      calls.push(input);
      return fetch(input as string | Request, { headers: { authorization: "Bearer t0k3n" } });
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0], `${base}/bundles/texture.bundle`);
  assert.ok(calls[1] instanceof Request);
  assert.equal(seen.get("/bundles/texture.bundle")?.authorization, "Bearer t0k3n");
  assert.equal(env.files.length, expectedFiles.length + 1);
});

test("a source that is none of the accepted kinds is refused", async () => {
  // @ts-expect-error - not an open() source
  await assert.rejects(open(42), TypeError);
  // @ts-expect-error - not an open() source
  await assert.rejects(open([{ size: "big" }]), { message: /^input 0: expected a URL/ });
});
