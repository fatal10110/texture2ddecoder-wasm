// No C# in the repo (D2/R2): `node scripts/check-no-csharp.mjs` exits 1 and lists any tracked C# file.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * @param {string} cwd a git working tree
 * @returns {string[]} tracked `.cs` / `.csproj` / `.sln` files
 */
export function csharpFiles(cwd) {
  const out = execFileSync("git", ["ls-files", "*.cs", "*.csproj", "*.sln"], { cwd, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = csharpFiles(process.cwd());
  for (const f of found) console.error(`✗ C# file tracked: ${f}`);
  process.exit(found.length ? 1 : 0);
}
