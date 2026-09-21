import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { csharpFiles } from "../check-no-csharp.mjs";

const repo = mkdtempSync(join(tmpdir(), "no-csharp-"));
after(() => rmSync(repo, { recursive: true, force: true }));
const git = (...args) => execFileSync("git", args, { cwd: repo });
git("init", "-q");

test("clean repo passes", () => {
  writeFileSync(join(repo, "a.ts"), "");
  git("add", "a.ts");
  assert.deepEqual(csharpFiles(repo), []);
});

test("tracked .cs, .csproj and .sln files are reported", () => {
  for (const f of ["x.cs", "x.csproj", "x.sln"]) {
    writeFileSync(join(repo, f), "");
    git("add", f);
  }
  assert.deepEqual(csharpFiles(repo).sort(), ["x.cs", "x.csproj", "x.sln"]);
});

test("the CLI exits 1 on a tracked C# file", () => {
  const script = join(import.meta.dirname, "../check-no-csharp.mjs");
  assert.throws(() => execFileSync("node", [script], { cwd: repo, stdio: "pipe" }), { status: 1 });
});
