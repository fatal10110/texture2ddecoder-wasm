// The #183 usage block (`tests/types/usage.ts`): it compiles under the
// package's strict flags, its narrowing assertions hold, and it runs against
// the fixtures with UnityPy's names and paths (R12).

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { golden, loadFixture } from "../../../fixtures/helpers.js";
import { load } from "../src/env.js";
import { usage } from "./types/usage.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = dirname(HERE);
const USAGE = join(HERE, "types", "usage.ts");

test("the usage block compiles under strict, and switch (asset.type) narrows data", () => {
  // The package's own flags (tsconfig.base.json), plus node types for the
  // test file's `fetch` / `Response`, which the package source never sees.
  const config = ts.readConfigFile(join(PACKAGE, "tsconfig.json"), (f) => ts.sys.readFile(f));
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, PACKAGE);
  const program = ts.createProgram([USAGE], {
    ...options,
    noEmit: true,
    rootDir: undefined,
    types: ["node"],
  });
  assert.equal(options.strict, true);
  assert.equal(options.noUncheckedIndexedAccess, true);

  const problems = ts
    .getPreEmitDiagnostics(program)
    // `lzma1` ships TS sources that fail these flags; only this package counts.
    .filter((d) => !d.file || !relative(PACKAGE, d.file.fileName).startsWith(`..${sep}`))
    .map((d) => {
      const text = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      if (!d.file || d.start === undefined) return text;
      const { line } = d.file.getLineAndCharacterOfPosition(d.start);
      return `${relative(PACKAGE, d.file.fileName)}:${line + 1}: ${text}`;
    });
  assert.deepStrictEqual(problems, []);
});

test("the usage block runs against the fixtures with UnityPy's names and paths", async () => {
  const main = "editor/6000.3.25f1/sprite/sprites";
  const texture = "editor/6000.3.25f1/lz4/texture";
  const bytes = loadFixture(main);
  const server = createServer((_, res) => res.end(loadFixture(texture)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ui.bundle`;
  try {
    const g = golden(main);
    const firstPath = g.container![0]!.path;
    const result = await usage(bytes, loadFixture(texture), new Uint8Array(8), url, firstPath);

    assert.equal(result.rows.length, result.env.objects.length);
    const pathOf = new Map<string, string>();
    for (const e of g.container!) {
      if (!pathOf.has(`${e.file}/${e.pathId}`)) pathOf.set(`${e.file}/${e.pathId}`, e.path);
    }
    for (const row of result.rows) {
      const id = `${row.file}/${row.pathId}`;
      assert.equal(row.name, g.serialized![row.file]!.names[String(row.pathId)], id);
      assert.equal(row.path, pathOf.get(id), id);
      assert.ok(row.data !== undefined, id);
    }
    assert.ok(result.rows.some((r) => r.type === "Sprite" && r.path !== undefined));
    assert.deepStrictEqual(
      result.filtered.map((a) => a.type),
      result.rows.filter((r) => r.type === "Texture2D" || r.type === "Sprite").map((r) => r.type),
    );
    const first = g.container![0]!;
    const byPath = `${result.byPath?.file}/${result.byPath?.pathId}`;
    assert.equal(byPath, `${first.file}/${first.pathId}`);

    // `load([bytes, { name, data }])` and `open(url)` unpacked what was given.
    assert.deepStrictEqual(
      result.env2.files.map((f) => f.path),
      [...load(loadFixture(texture)).files.map((f) => f.path), "sharedassets0.assets.resS"],
    );
    assert.deepStrictEqual(
      result.env3.files.map((f) => f.path),
      Object.keys(golden(texture).files),
    );
  } finally {
    server.close();
  }
});
