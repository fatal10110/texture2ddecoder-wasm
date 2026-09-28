// initialize() inside a browser Web Worker scope (#149): no `window`, no `document`, no
// `process`, only `WorkerGlobalScope`. The scope is emulated in a Node worker_threads Worker
// (see web-worker-entry.mjs), so these run without a browser.
import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import ts from "typescript";
import { decode_bc1 } from "../src/index.js";

type Reply = { ok: true; out: Uint8Array | null } | { ok: false; message: string };

// The worker gets the decoder as plain JS (see web-worker-entry.mjs for why).
const decoderJs = ts.transpileModule(
  readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } },
).outputText;

function inWebWorker(job: { wasmPath?: string; bc1?: Uint8Array }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./web-worker-entry.mjs", import.meta.url), {
      workerData: { ...job, decoderJs },
    });
    worker.once("message", (reply: Reply) => {
      void worker.terminate();
      resolve(reply);
    });
    worker.once("error", reject);
  });
}

const wasmDir = new URL("../wasm", import.meta.url).href;
// One BC1 block: red and blue endpoints, all four palette entries used.
const bc1 = new Uint8Array([0x00, 0xf8, 0x1f, 0x00, 0xe4, 0xe4, 0xe4, 0xe4]);

describe("initialize() in a Web Worker scope", () => {
  it("loads the glue from wasmPath instead of rejecting the environment", async () => {
    const reply = await inWebWorker({
      wasmPath: new URL("../missing-wasm", import.meta.url).href,
    });
    assert.strictEqual(reply.ok, false);
    const message = reply.ok ? "" : reply.message;
    assert.doesNotMatch(message, /Unsupported environment/);
    assert.match(
      message,
      /Failed to load WASM module from file:.*\/missing-wasm\/texture2ddecoder\.js/,
    );
  });

  it("requires wasmPath, like the main thread", async () => {
    const reply = await inWebWorker({});
    assert.strictEqual(reply.ok, false);
    assert.match(reply.ok ? "" : reply.message, /requires wasmPath/);
  });

  // #171: `import("/wasm/...")` is left to the bundler or the module's own URL to resolve (the
  // Vite dev server turns it into a `?import` request it refuses for `public/`). Here the
  // decoder is a data: module, which cannot resolve a root-relative specifier at all.
  it("resolves a root-relative wasmPath against the Worker's location", async () => {
    // The wasm directory as a root-relative path; `location` is the entry's file: URL.
    const rootRelative = new URL(wasmDir).pathname;
    assert.ok(rootRelative.startsWith("/") && !rootRelative.startsWith("//"));
    const reply = await inWebWorker({ wasmPath: rootRelative, bc1 });
    assert.ok(reply.ok, reply.ok ? "" : reply.message);
    assert.deepStrictEqual(reply.out, await decode_bc1(bc1, 4, 4));
  });

  it("initializes from wasmPath and decodes like Node does", async () => {
    const reply = await inWebWorker({ wasmPath: wasmDir, bc1 });
    assert.ok(reply.ok, reply.ok ? "" : reply.message);
    assert.ok(reply.out);
    assert.deepStrictEqual(reply.out, await decode_bc1(bc1, 4, 4));
  });
});
