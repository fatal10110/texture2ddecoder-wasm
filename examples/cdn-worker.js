// The reader side of cdn.html, run as a module Worker. The parse path is sync
// (plan D4), so a big bundle parsed here never freezes the page.
//
// Import maps do not reach into Workers, so the packages are imported from
// jsDelivr's `/+esm` endpoint, which rewrites their bare imports (`fflate`,
// `unity-asset-reader`, `texture2ddecoder-wasm`, ...) to CDN URLs as well.

// cdn.html starts this file as `cdn-worker.js?local` when the page was opened
// with `?local`: the packages then come from `node examples/serve.mjs`, which
// serves this repo's own builds under /npm/<name>/+esm.
const LOCAL = new URL(import.meta.url).searchParams.has("local");
const CDN = "https://cdn.jsdelivr.net/npm";
// Each package has its own version (#192). These are the published ones
// (checked live, #150). jsDelivr's `/+esm` build of the texture package fixes
// its imports to one exact version each: `unity-asset-reader@1.0.0` and
// `texture2ddecoder-wasm@1.2.3`. CORE_VERSION must be that same version, or
// the Worker loads two copies of core. DECODER_VERSION is pinned to it too, so
// the WASM glue comes from the decoder release whose JS the texture package runs.
const CORE_VERSION = "1.0.0";
const TEXTURE_VERSION = "1.0.0";
const DECODER_VERSION = "1.2.3";

/** Base URL of a package: jsDelivr, or the local stand-in (which ignores versions). */
const packageUrl = (name, version) => (LOCAL ? `/npm/${name}` : `${CDN}/${name}@${version}`);

// Needs texture2ddecoder-wasm 1.2.3 or later: 1.2.2's initialize() refuses to
// run in a Worker (#149).
const ready = (async () => {
  const [reader, texture] = await Promise.all([
    import(`${packageUrl("unity-asset-reader", CORE_VERSION)}/+esm`),
    import(`${packageUrl("unity-asset-reader-texture", TEXTURE_VERSION)}/+esm`),
  ]);
  await texture.initTexture({
    wasmPath: `${packageUrl("texture2ddecoder-wasm", DECODER_VERSION)}/wasm`,
  });
  return { ...reader, ...texture };
})();

let env;

/** One row of the object list: what every object has, plus a Texture2D's header. */
function describe(lib, obj, index) {
  const row = {
    index,
    className: lib.classIdName(obj.type) ?? `class ${obj.type}`,
    pathId: String(obj.pathId), // bigint (D9); a string crosses postMessage everywhere
    size: obj.byteSize,
  };
  if (obj.type !== lib.ClassID.Texture2D) return row;
  try {
    const texture = obj.read();
    const format =
      Object.keys(lib.TextureFormat).find((k) => lib.TextureFormat[k] === texture.m_TextureFormat) ??
      String(texture.m_TextureFormat);
    row.texture = {
      name: texture.m_Name,
      format,
      width: texture.m_Width,
      height: texture.m_Height,
    };
  } catch (error) {
    row.texture = { error: String(error.message ?? error) };
  }
  return row;
}

const handlers = {
  /** Unpack and parse the picked files; list their objects. */
  async load(lib, { files }) {
    env = lib.load(files.map(({ name, data }) => ({ name, data: new Uint8Array(data) })));
    return { objects: env.objects.map((obj, index) => describe(lib, obj, index)) };
  },
  /** Decode one Texture2D of the last load to RGBA, top row first. */
  async decode(lib, { index }) {
    const obj = env?.objects[index];
    if (obj === undefined || obj.type !== lib.ClassID.Texture2D) {
      throw new Error(`object ${index} is not a Texture2D of the loaded files`);
    }
    const texture = obj.read();
    const { data, width, height } = await lib.decodeTexture2D(texture);
    // Transfer, not copy; only a view of a bigger buffer would carry extra bytes along.
    const rgba = data.byteLength === data.buffer.byteLength ? data : data.slice();
    return { name: texture.m_Name, width, height, rgba: rgba.buffer, transfer: [rgba.buffer] };
  },
};

self.onmessage = async ({ data: { id, type, ...args } }) => {
  try {
    const { transfer = [], ...result } = await handlers[type](await ready, args);
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error?.message ?? error) });
  }
};
