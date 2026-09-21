// Runs the texture2ddecoder-wasm tests only when its WASM output is present.
// Building it needs Docker (`npm run build:wasm`), which CI and fresh clones do
// not have, so the root `test` script would otherwise always be red.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const wasm = "packages/texture2ddecoder-wasm/wasm/texture2ddecoder.wasm";

if (!existsSync(wasm)) {
  console.log(`skipping texture2ddecoder-wasm tests: ${wasm} not built (run: npm run build:wasm)`);
  process.exit(0);
}

const result = spawnSync("npm", ["test", "-w", "texture2ddecoder-wasm"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
