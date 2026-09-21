import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

test("a DOM global does not typecheck under the package tsconfig", () => {
  const result = spawnSync("npx", ["tsc", "-p", "tests/tsconfig.dom-probe.json"], {
    cwd: packageRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  assert.notStrictEqual(result.status, 0, "expected tsc to reject document.createElement");
  assert.match(result.stdout + result.stderr, /Cannot find name 'document'/);
});
