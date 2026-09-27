// Worker body for web-worker.test.ts. It runs in a Node `worker_threads` Worker, makes the
// global scope look like a browser Web Worker (`WorkerGlobalScope` exists, `window`,
// `document` and `process` do not), then loads the decoder, runs initialize() and optionally
// one BC1 decode, and posts the outcome back.
//
// Plain JS, and the decoder arrives already transpiled: tsx does not hook worker threads, and
// its require hook needs `process`, which is gone by the time the decoder loads (the decoder
// detects its environment on load).
import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";

/** @type {{ decoderJs: string, wasmPath?: string, bc1?: Uint8Array }} */
const job = workerData;

Object.defineProperty(globalThis, "WorkerGlobalScope", {
  value: class WorkerGlobalScope {},
  configurable: true,
});
// Every Worker scope has `self` and `self.location` (the worker script's URL). The emsdk 4.0.7
// glue reads `self.location.href` in worker mode before preferring its own import.meta.url.
globalThis.self = globalThis;
globalThis.location = new URL(import.meta.url);
delete globalThis.process;

// The glue fetches the .wasm next to itself (`new URL(..., import.meta.url)`), which a browser
// does over HTTP. Node's fetch has no `file:` support, so stand in for the browser's here.
globalThis.fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.protocol !== "file:") throw new TypeError(`unexpected fetch of ${url.href}`);
  return new Response(await readFile(url), { headers: { "content-type": "application/wasm" } });
};

try {
  const decoder = await import(`data:text/javascript,${encodeURIComponent(job.decoderJs)}`);
  await decoder.initialize(job.wasmPath === undefined ? undefined : { wasmPath: job.wasmPath });
  const out = job.bc1 ? await decoder.decode_bc1(job.bc1, 4, 4) : null;
  parentPort.postMessage({ ok: true, out });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  });
}
