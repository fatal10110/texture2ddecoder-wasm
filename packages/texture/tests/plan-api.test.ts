import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

// tsx strips types and the package tsconfig leaves tests/ out, so nothing else
// would notice `decodeTexture2D(obj.read())` no longer compiling (#32 review).
test("plan section 3's decode loop typechecks against the published types", () => {
  const result = spawnSync("npx", ["tsc", "-p", "tests/tsconfig.plan-api.json"], {
    cwd: packageRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
