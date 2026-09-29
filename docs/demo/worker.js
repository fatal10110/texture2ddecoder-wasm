// The reader side of the demo page (docs/index.html), run as a module Worker.
// Parsing is sync (plan D4), so a big bundle parsed here never freezes the
// page. The page sends files or URLs and gets plain data back: asset rows,
// details trees, RGBA pixels.
//
// Import maps do not reach into Workers, so the packages come from jsDelivr's
// `/+esm` endpoint, which rewrites their own bare imports (`fflate`,
// `unity-asset-reader`, `texture2ddecoder-wasm`, ...) to CDN URLs too.
//
// The page starts this file as `worker.js?local` when it was opened with
// `?local`: the packages then come from `node examples/serve.mjs`, which
// serves this repo's builds under /npm/<name>/+esm (the Playwright test).

const LOCAL = new URL(import.meta.url).searchParams.has("local");
const CDN = LOCAL ? `${self.location.origin}/npm` : "https://cdn.jsdelivr.net/npm";

/**
 * The versions to import. The published major lines, `@1`; but jsDelivr's
 * `/+esm` build of the texture package imports core and the decoder at one
 * exact version each (`unity-asset-reader@1.0.1/+esm`). Importing core as
 * `@1` would load a second copy of it, so the exact versions are read from
 * the headers jsDelivr sends with the texture build: `x-jsd-version`, and a
 * `link: </npm/<name>@<version>/+esm>; rel="modulepreload"` per import. The
 * WASM comes from that same decoder release, whose JS glue the texture
 * package runs. Without those headers `@1` stays.
 */
async function resolveVersions() {
  const versions = {
    "unity-asset-reader": "1",
    "unity-asset-reader-texture": "1",
    "texture2ddecoder-wasm": "1",
  };
  try {
    const response = await fetch(`${CDN}/unity-asset-reader-texture@1/+esm`, { method: "HEAD" });
    const own = response.headers.get("x-jsd-version");
    if (own) versions["unity-asset-reader-texture"] = own;
    const link = response.headers.get("link") ?? "";
    for (const [, name, version] of link.matchAll(/<\/npm\/([a-z0-9._-]+)@([^/>]+)\/\+esm>/g)) {
      if (name in versions) versions[name] = version;
    }
  } catch {
    // Offline or blocked: the `@1` imports below report the real error.
  }
  return versions;
}

const ready = (async () => {
  // The local server serves one build per package and ignores versions; its
  // rewritten imports carry none, so neither do these, or core loads twice.
  const versions = LOCAL ? {} : await resolveVersions();
  const url = (name) => (LOCAL ? `${CDN}/${name}` : `${CDN}/${name}@${versions[name]}`);
  const [reader, texture] = await Promise.all([
    import(`${url("unity-asset-reader")}/+esm`),
    import(`${url("unity-asset-reader-texture")}/+esm`),
  ]);
  // Needs texture2ddecoder-wasm 1.2.3 or later: 1.2.2 refuses to run in a Worker (#149).
  const wasmPath = `${url("texture2ddecoder-wasm")}/wasm`;
  await texture.initTexture({ wasmPath });
  return { ...reader, ...texture, versions, wasmPath };
})();

/** The last load: its env, its assets in `env.assets()` order, and each asset's index. */
let current;

/** Largest array or byte run sent to the page whole; longer ones are cut, with a count. */
const MAX_ITEMS = 256;
const MAX_BYTES = 64;
const MAX_DEPTH = 40;

/**
 * A copy of `value` the page can render and `postMessage` can clone: bigints
 * stay bigints (exact, D9), byte arrays become `{ $bytes, hex }`, other typed
 * arrays `{ $typed, length, items }`, long arrays end in `{ $more }`, a Map
 * becomes its entries. Nothing is lost silently: every cut says how much.
 */
function toTree(value, depth = 0) {
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_DEPTH) return { $deep: true };
  if (value instanceof Uint8Array) {
    return { $bytes: value.length, hex: hex(value.subarray(0, MAX_BYTES)) };
  }
  if (ArrayBuffer.isView(value)) {
    const items = Array.from(value.subarray(0, MAX_ITEMS));
    return { $typed: value.constructor.name, length: value.length, items };
  }
  if (value instanceof Map) return toTree([...value], depth);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => toTree(item, depth + 1));
    if (value.length > MAX_ITEMS) items.push({ $more: value.length - MAX_ITEMS });
    return items;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = toTree(item, depth + 1);
  return out;
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}

/** An error as the page shows it: the class name (`UnsupportedError`, ...) and its message. */
function describeError(error) {
  return {
    name: error?.name ?? "Error",
    message: String(error?.message ?? error),
    kind: error?.kind,
    found: error?.found === undefined ? undefined : String(error.found),
  };
}

/** `fn()`, or the error it threw, described. */
function attempt(fn) {
  try {
    return { value: fn() };
  } catch (error) {
    return { error: describeError(error) };
  }
}

/** The key of an asset in `current.indexOf`: its file and path id. */
const assetKey = (file, pathId) => `${file}\0${pathId}`;

/** One row of the asset table. */
function row(lib, asset, index) {
  const name = attempt(() => asset.name);
  const path = attempt(() => asset.path);
  return {
    index,
    type: asset.type,
    typeName: asset.typeName,
    name: name.value ?? "",
    nameError: name.error?.message,
    path: path.value,
    pathId: String(asset.pathId), // bigint (D9); a decimal string sorts and filters as text
    file: asset.file,
    byteSize: asset.byteSize,
    image: lib.isImage(asset),
  };
}

/** The name of a value of one of core's constant objects (`BuildTarget`, ...), or the number. */
function constName(table, value) {
  return Object.keys(table).find((key) => table[key] === value) ?? String(value);
}

/** A file name for an asset's raw bytes, from what they start with. */
function mediaFile(asset, bytes) {
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  const base = asset.name || `${asset.typeName}-${asset.pathId}`;
  switch (asset.type) {
    case "AudioClip":
      return { name: `${base}.${magic === "FSB5" ? "fsb" : "bin"}`, mime: "application/octet-stream" };
    case "VideoClip": {
      const ext = /\.([a-z0-9]+)$/i.exec(asset.data.originalPath ?? "")?.[1]?.toLowerCase();
      return { name: `${base}.${ext ?? "bin"}`, mime: ext ? `video/${ext}` : "application/octet-stream" };
    }
    case "Font":
      return magic === "OTTO"
        ? { name: `${base}.otf`, mime: "font/otf" }
        : { name: `${base}.ttf`, mime: "font/ttf" };
    default:
      return { name: `${base}.ogv`, mime: "video/ogg" }; // MovieTexture: Ogg Theora
  }
}

/** The byte field of each class whose details offer a download of the raw bytes. */
const MEDIA = { AudioClip: "audioData", VideoClip: "videoData", Font: "fontData", MovieTexture: "movieData" };

/** A copy that owns its buffer, so it can be transferred without dragging the rest along. */
function own(bytes) {
  return bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
}

/** Nearest-neighbour downscale of RGBA to at most `max` pixels a side, for a thumbnail. */
function thumbnail(rgba, width, height, max) {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(w * h * 4);
  if (width === 0 || height === 0) return { rgba: out, width: w, height: h };
  for (let y = 0; y < h; y++) {
    const from = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const i = (from * width + Math.min(width - 1, Math.floor(x / scale))) * 4;
      out.set(rgba.subarray(i, i + 4), (y * w + x) * 4);
    }
  }
  return { rgba: out, width: w, height: h };
}

const handlers = {
  /** Open files (`File`s) or URLs with `open()` and list every asset. */
  async open(lib, { sources }) {
    current = undefined;
    const env = await lib.open(sources);
    const assets = [...env.assets()];
    const indexOf = new Map(assets.map((asset, i) => [assetKey(asset.file, asset.pathId), i]));
    current = { env, assets, indexOf };
    return {
      files: env.files.map(({ path, data }) => ({ path, size: data.length })),
      assets: assets.map((asset, i) => row(lib, asset, i)),
    };
  },

  /** `env.get(path)`: the index of the asset a container path names, or -1. */
  async get(lib, { path }) {
    const asset = loaded().env.get(path);
    return { index: asset ? current.indexOf.get(assetKey(asset.file, asset.pathId)) : -1 };
  },

  /** What the details panel shows for one asset. */
  async details(lib, { index }) {
    const asset = loaded().assets[index];
    if (asset === undefined) throw new Error(`no asset ${index} in the last load`);
    const base = { row: row(lib, asset, index) };

    if (lib.isImage(asset)) {
      const info = attempt(() => lib.imageInfo(asset));
      if (info.error) return { ...base, kind: "image", error: info.error };
      const described = {
        ...info.value,
        platformName: constName(lib.BuildTarget, info.value.platform),
      };
      if (info.value.kind === "Sprite") {
        described.sprite = {
          ...info.value.sprite,
          rotationName: constName(lib.SpritePackingRotation, info.value.sprite.rotation),
        };
      }
      try {
        const started = performance.now();
        const image = await lib.decodeImage(asset);
        const ms = performance.now() - started;
        const rgba = own(image.rgba);
        return {
          ...base,
          kind: "image",
          info: toTree(described),
          ms,
          width: image.width,
          height: image.height,
          rgba: rgba.buffer,
          transfer: [rgba.buffer],
        };
      } catch (error) {
        return { ...base, kind: "image", info: toTree(described), error: describeError(error) };
      }
    }

    const data = asset.data; // throws (with file, class and path id) when it cannot be read
    if (asset.type === "TextAsset") {
      const bytes = data.bytes;
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (text.includes("\0")) text = undefined;
      } catch {
        text = undefined;
      }
      if (text !== undefined) return { ...base, kind: "text", text, size: bytes.length };
      return { ...base, kind: "hex", hex: hexDump(bytes.subarray(0, 4096)), size: bytes.length };
    }

    if (asset.type === "MonoBehaviour") {
      const { fields, ...header } = data;
      // The script's class name, from the MonoScript the header points at, when it is loaded.
      const found = attempt(() => asset.env.resolve(data.script, asset.reader));
      let script;
      if (found.value?.status === "found") {
        script = attempt(() => found.value.object.read().m_ClassName).value;
      }
      return { ...base, kind: "mono", script, header: toTree(header), fields: toTree(fields) };
    }

    const field = MEDIA[asset.type];
    if (field !== undefined) {
      const { [field]: raw, ...meta } = data;
      const bytes = own(raw ?? new Uint8Array(0));
      return {
        ...base,
        kind: "media",
        field,
        meta: toTree(meta),
        size: bytes.length,
        download: { ...mediaFile(asset, bytes), bytes: bytes.buffer },
        transfer: [bytes.buffer],
      };
    }

    return { ...base, kind: "data", data: toTree(data) };
  },

  /**
   * `images(env, { onError: "skip" })`: decode every Texture2D and Sprite,
   * posting a thumbnail per image as it is done.
   */
  async decodeAll(lib, _args, progress) {
    const { env, indexOf } = loaded();
    // Each image's place among them, for the progress: a skipped image still counts as done.
    const order = new Map();
    for (const a of env.assets("Texture2D", "Sprite")) order.set(assetKey(a.file, a.pathId), order.size);
    const total = order.size;
    let decoded = 0;
    progress({ done: 0, total });
    for await (const image of lib.images(env, { onError: "skip" })) {
      decoded++;
      const key = assetKey(image.file, image.pathId);
      const thumb = thumbnail(image.rgba, image.width, image.height, 96);
      progress(
        {
          done: order.get(key) + 1,
          total,
          image: {
            index: indexOf.get(key),
            name: image.name,
            kind: image.kind,
            width: image.width,
            height: image.height,
            thumb: { width: thumb.width, height: thumb.height, rgba: thumb.rgba.buffer },
          },
        },
        [thumb.rgba.buffer],
      );
    }
    return { decoded, skipped: total - decoded, total };
  },

  /** The package versions this Worker imported. */
  async versions(lib) {
    return { versions: lib.versions, wasmPath: lib.wasmPath };
  },
};

function loaded() {
  if (current === undefined) throw new Error("nothing is loaded");
  return current;
}

/** Classic hex dump: offset, 16 bytes, ASCII. */
function hexDump(bytes) {
  const lines = [];
  for (let at = 0; at < bytes.length; at += 16) {
    const line = bytes.subarray(at, at + 16);
    const ascii = Array.from(line, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."));
    lines.push(`${at.toString(16).padStart(8, "0")}  ${hex(line).padEnd(47)}  ${ascii.join("")}`);
  }
  return lines.join("\n");
}

self.onmessage = async ({ data: { id, type, ...args } }) => {
  const progress = (value, transfer = []) => self.postMessage({ id, progress: value }, transfer);
  try {
    const handler = handlers[type];
    if (handler === undefined) throw new Error(`unknown request ${type}`);
    const { transfer = [], ...result } = await handler(await ready, args, progress);
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (error) {
    self.postMessage({ id, ok: false, error: describeError(error) });
  }
};
