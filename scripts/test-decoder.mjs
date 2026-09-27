// Runs the unity-asset-reader-decoder tests only when its WASM output is present.
// Building it needs Docker (`npm run build:wasm`), which CI and fresh clones do
// not have, so the root `test` script would otherwise always be red.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const wasm = "packages/decoder/wasm/texture2ddecoder.wasm";

if (!existsSync(wasm)) {
  console.log(`skipping unity-asset-reader-decoder tests: ${wasm} not built (run: npm run build:wasm)`);
  process.exit(0);
}

const result = spawnSync("npm", ["test", "-w", "unity-asset-reader-decoder"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
