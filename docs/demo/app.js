// The page side of the demo (docs/index.html). It imports nothing: the reader
// runs in worker.js, which this file talks to with postMessage.
//
// `?local`: the Worker loads this repo's builds from `node examples/serve.mjs`
// instead of jsDelivr, and the samples come from the same server (the
// Playwright test, examples/tests/demo.spec.mts).
const LOCAL = new URLSearchParams(location.search).has("local");

// Our technical fixtures stay local in tests. Public examples are fetched at
// runtime from pinned revisions; third-party bundle data is never committed.
const SAMPLE_BASE = LOCAL
  ? new URL("/fixtures/bundles/editor/6000.3.25f1/", location.href).href
  : "https://cdn.jsdelivr.net/gh/fatal10110/unity-asset-reader@main/fixtures/bundles/editor/6000.3.25f1/";

const SAMPLES = [
  {
    label: "Brick wall: a textured cube (Unity 5, 85 KB)",
    urls: ["https://raw.githubusercontent.com/FiaDot/Unity5AssetBundleDemo/875ea8291326ba514998e4025737776f74944e96/Assets/StreamingAssets/WIN/resource_asset"],
    source: "https://github.com/FiaDot/Unity5AssetBundleDemo/tree/875ea8291326ba514998e4025737776f74944e96",
    license: "https://github.com/FiaDot/Unity5AssetBundleDemo/blob/875ea8291326ba514998e4025737776f74944e96/LICENSE",
    credit: "FiaDot / LEE GUNHO — Unity5AssetBundleDemo. ",
  },
  {
    label: "A script's data, text and a texture (MonoBehaviour, TextAsset, Texture2D, Mesh)",
    files: ["lz4/main", "lz4/shared", "lz4/texture"],
  },
  { label: "Sprites and sprite atlases", files: ["sprite/sprites"] },
  { label: "Compressed textures: BC1-BC7 and Crunch", files: ["block/windows"] },
  { label: "Compressed textures: ETC, EAC and ASTC", files: ["block/android"] },
  { label: "Audio, video and a font", files: ["lz4/audio", "lz4/video", "lz4/font"] },
];

// ponytail: at most this many rows are in the DOM; a bundle with more assets
// asks for a filter. A virtual list would lift it.
const MAX_ROWS = 1000;

const $ = (id) => document.getElementById(id);
const status = $("status");

// ---------------------------------------------------------------------------
// Worker calls

let worker;
let nextId = 0;
const pending = new Map();

function startWorker() {
  const url = new URL(LOCAL ? "worker.js?local" : "worker.js", new URL("demo/", location.href));
  const started = new Worker(url, { type: "module" });
  started.onmessage = ({ data: { id, ok, result, error, progress } }) => {
    const call = pending.get(id);
    if (call === undefined) return;
    if (progress !== undefined) return call.onProgress?.(progress);
    pending.delete(id);
    if (ok) call.resolve(result);
    else call.reject(Object.assign(new Error(error.message), { name: error.name, detail: error }));
  };
  started.onerror = (event) => {
    const error = new Error(event.message || "the Worker failed to load");
    for (const call of pending.values()) call.reject(error);
    pending.clear();
    // A failed Worker answers nothing more: start a new one on the next call.
    started.terminate();
    if (worker === started) worker = undefined;
  };
  return started;
}

/** Ask the Worker to run one of its handlers. */
function call(type, args = {}, { transfer = [], onProgress } = {}) {
  worker ??= startWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, type, ...args }, transfer);
  });
}

// ---------------------------------------------------------------------------
// Helpers

function setStatus(state, text) {
  status.dataset.state = state;
  status.textContent = text;
}

/** `UnsupportedError: ...`: the error class stays visible, so "not supported" reads apart from "corrupt". */
function errorText(error) {
  return `${error.name ?? "Error"}: ${error.message}`;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((child) => child !== undefined && child !== null));
  return node;
}

const bytesText = (n) => `${n.toLocaleString("en-US")} B`;

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Draw RGBA pixels to a canvas, sized to the image. */
function drawRgba(canvas, rgba, width, height) {
  canvas.width = width;
  canvas.height = height;
  if (width > 0 && height > 0) {
    const image = new ImageData(new Uint8ClampedArray(rgba), width, height);
    canvas.getContext("2d").putImageData(image, 0, 0);
  }
}

// ---------------------------------------------------------------------------
// Value tree: bigint-safe, shows NaN / Infinity / -0, which JSON cannot

function leaf(value) {
  if (typeof value === "bigint") return el("span", { class: "bigint", title: "bigint" }, `${value}`);
  if (typeof value === "number") {
    return el("span", { class: "number" }, Object.is(value, -0) ? "-0" : String(value));
  }
  if (typeof value === "string") return el("span", { class: "string" }, JSON.stringify(value));
  return el("span", { class: "literal" }, String(value));
}

/** What a special marker of worker.js's `toTree` stands for, or undefined for plain data. */
function marker(value) {
  if ("$bytes" in value) {
    const more = value.$bytes > 64 ? ` ...` : "";
    return `bytes[${value.$bytes}] ${value.hex}${more}`;
  }
  if ("$typed" in value) {
    const more = value.length > value.items.length ? ", ..." : "";
    return `${value.$typed}(${value.length}) [${value.items.join(", ")}${more}]`;
  }
  if ("$more" in value) return `... ${value.$more} more`;
  if ("$deep" in value) return "... (nested too deep to show)";
  return undefined;
}

/**
 * A tree of `<details>` for objects and arrays, one line per value. Each line
 * carries `data-path` (`nested.v.x`, `ints.0`), which the test reads.
 */
function tree(value, { open = 2 } = {}) {
  const root = el("ul", { class: "tree" });
  const add = (list, key, item, path, depth) => {
    const li = el("li", { dataset: { path } });
    const label = key === undefined ? undefined : el("span", { class: "key" }, `${key}: `);
    if (item === null || typeof item !== "object") {
      li.append(...[label, leaf(item)].filter(Boolean));
    } else if (marker(item) !== undefined) {
      li.append(...[label, el("span", { class: "note" }, marker(item))].filter(Boolean));
    } else {
      const entries = Array.isArray(item) ? item.map((v, i) => [String(i), v]) : Object.entries(item);
      const summary = Array.isArray(item) ? `[${item.length}]` : `{${entries.length}}`;
      const details = el("details", { open: depth < open });
      details.append(el("summary", {}, ...[label, el("span", { class: "note" }, summary)].filter(Boolean)));
      const inner = el("ul");
      for (const [k, v] of entries) add(inner, k, v, path ? `${path}.${k}` : k, depth + 1);
      details.append(inner);
      li.append(details);
    }
    list.append(li);
  };
  if (value === null || typeof value !== "object" || marker(value) !== undefined) {
    add(root, undefined, value, "", 0);
  } else {
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value);
    for (const [k, v] of entries) add(root, k, v, k, 0);
    if (entries.length === 0) root.append(el("li", { class: "note" }, "(empty)"));
  }
  return root;
}

/** A definition list; `data-field` on each value is for the test. */
function infoList(rows) {
  const dl = el("dl", { class: "info" });
  for (const [field, label, value] of rows) {
    if (value === undefined) continue;
    dl.append(el("dt", {}, label), el("dd", { dataset: { field } }, String(value)));
  }
  return dl;
}

// ---------------------------------------------------------------------------
// Opening

let assets = [];
let selected = -1;
/** Whether an open has started: from then on the status line is its. */
let opened = false;
/**
 * Counts opens. A reply that started under an earlier load (a batch decode, a
 * details request) is dropped: its asset indexes point into another list.
 */
let loadId = 0;

async function openSources(sources, what) {
  opened = true;
  const load = ++loadId;
  setStatus("busy", `Opening ${what}...`);
  $("workspace").hidden = true;
  $("details").replaceChildren(
    el("div", { class: "empty-state" },
      el("span", { class: "empty-icon", "aria-hidden": "true" }, "▧"),
      el("h3", {}, "Select an asset"),
      el("p", { class: "muted" }, "Choose a name from the list to preview its image or inspect its data."),
    ),
  );
  $("gallery").replaceChildren();
  $("batch-status").textContent = "";
  $("batch-progress").hidden = true;
  selected = -1;
  try {
    const started = performance.now();
    const result = await call("open", { sources });
    if (load !== loadId) return; // a later open owns the page now
    const ms = (performance.now() - started).toFixed(0);
    assets = result.assets;
    showAssets(result.files);
    // Input that is no Unity file loads without an error, as a resource file: say so.
    const unknown = result.files.filter((f) => f.resource);
    if (assets.length === 0 && unknown.length > 0) {
      const names = unknown.map((f) => f.path).join(", ");
      setStatus("error", `0 assets. ${names}: not a Unity bundle or serialized file (kept as a resource file).`);
      return;
    }
    setStatus(
      "ready",
      `${assets.length} assets in ${result.files.length} files, read in ${ms} ms.`,
    );
  } catch (error) {
    if (load !== loadId) return;
    assets = [];
    $("workspace").hidden = true;
    $("intro").hidden = false;
    setStatus("error", errorText(error));
  }
}

function openFiles(fileList) {
  const files = [...fileList];
  if (files.length === 0) return;
  // `File`s go to the Worker as they are; `open()` reads them there.
  openSources(files, files.map((f) => f.name).join(", "));
}

$("file").addEventListener("change", () => openFiles($("file").files));

const dropzone = $("dropzone");
// A file dropped anywhere on the page opens; outside the zone the browser would navigate to it.
window.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("over");
});
window.addEventListener("dragleave", (event) => {
  if (event.relatedTarget === null) dropzone.classList.remove("over");
});
window.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("over");
  if (event.dataTransfer?.files.length) openFiles(event.dataTransfer.files);
});

$("url-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const urls = $("url")
    .value.split(/\s+/)
    .filter(Boolean)
    .map((url) => new URL(url, location.href).href);
  if (urls.length > 0) openSources(urls, urls.join(", "));
});

const sampleSelect = $("sample");
SAMPLES.forEach((sample, i) => sampleSelect.append(el("option", { value: String(i) }, sample.label)));
function showSampleCredit() {
  const sample = SAMPLES[Number(sampleSelect.value)];
  $("sample-credit").replaceChildren(...(sample.source
    ? [sample.credit, el("a", { href: sample.source }, "Source"), " · ",
      el("a", { href: sample.license }, "MIT license")]
    : ["Technical fixtures built with our own Unity project."]));
}
sampleSelect.addEventListener("change", showSampleCredit);
showSampleCredit();
$("sample-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const sample = SAMPLES[Number(sampleSelect.value)];
  const urls = sample.urls ?? sample.files.map((file) => SAMPLE_BASE + file);
  openSources(urls, `the sample "${sample.label}"`);
});

// ---------------------------------------------------------------------------
// Asset table

function showAssets(files) {
  $("workspace").hidden = false;
  $("intro").hidden = assets.length > 0;
  $("open-controls").open = assets.length === 0;
  $("files").textContent = `Files: ${files.map((f) => `${f.path} (${bytesText(f.size)})`).join(", ")}`;

  const counts = new Map();
  for (const asset of assets) counts.set(asset.typeName, (counts.get(asset.typeName) ?? 0) + 1);
  const typeFilter = $("type-filter");
  typeFilter.replaceChildren(
    el("option", { value: "" }, `All types (${assets.length})`),
    ...[...counts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, n]) => el("option", { value: name }, `${name} (${n})`)),
  );
  $("filter").value = "";
  $("paths").replaceChildren(
    ...[...new Set(assets.map((a) => a.path).filter(Boolean))].map((path) =>
      el("option", { value: path }),
    ),
  );
  renderRows();
}

function renderRows() {
  const text = $("filter").value.trim().toLowerCase();
  const type = $("type-filter").value;
  const shown = assets.filter(
    (a) =>
      (type === "" || a.typeName === type) &&
      (text === "" ||
        [a.name, a.path ?? "", a.typeName, a.pathId, a.file].some((s) => s.toLowerCase().includes(text))),
  );
  const body = $("assets").tBodies[0];
  body.replaceChildren(
    ...shown.slice(0, MAX_ROWS).map((a) => {
      const typeText = a.type === "Other" ? a.typeName : a.type;
      const name = el(
        "button",
        { type: "button", class: "link", onclick: () => select(a.index) },
        a.name || (a.nameError ? "(name unreadable)" : "(unnamed)"),
      );
      return el(
        "tr",
        { dataset: { index: String(a.index) }, "aria-selected": String(a.index === selected) },
        el("td", {}, typeText),
        el("td", { title: a.nameError }, name),
        el("td", { class: "path" }, a.path ?? ""),
        el("td", { class: "id mono" }, a.pathId),
        el("td", { class: "file mono" }, a.file),
        el("td", { class: "num" }, a.byteSize.toLocaleString("en-US")),
      );
    }),
  );
  $("asset-count").textContent =
    shown.length === assets.length ? `(${assets.length})` : `(${shown.length} of ${assets.length})`;
  const note = $("row-note");
  $("empty-assets").hidden = shown.length > 0;
  note.hidden = shown.length <= MAX_ROWS;
  note.textContent = `Showing the first ${MAX_ROWS} of ${shown.length}; filter to see the rest.`;
}

$("filter").addEventListener("input", renderRows);
$("type-filter").addEventListener("change", renderRows);
$("clear-filters").addEventListener("click", () => {
  $("filter").value = "";
  $("type-filter").value = "";
  renderRows();
  $("filter").focus();
});

$("get-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const path = $("get-path").value.trim();
  if (path === "") return;
  const load = loadId;
  try {
    const { index } = await call("get", { path });
    if (load !== loadId) return;
    if (index < 0) {
      setStatus("ready", `env.get: no loaded bundle lists "${path}".`);
      return;
    }
    setStatus("ready", `env.get("${path}") is ${assets[index].typeName} "${assets[index].name}".`);
    await select(index);
  } catch (error) {
    if (load === loadId) setStatus("error", errorText(error));
  }
});

// ---------------------------------------------------------------------------
// Details

let detailsRequest = 0;

async function select(index) {
  selected = index;
  for (const tr of $("assets").tBodies[0].rows) {
    tr.setAttribute("aria-selected", String(Number(tr.dataset.index) === index));
  }
  const panel = $("details");
  const asset = assets[index];
  panel.replaceChildren(el("p", { class: "muted" }, `Reading ${asset.typeName} "${asset.name}"...`));
  const request = ++detailsRequest;
  const load = loadId;
  let result;
  try {
    result = await call("details", { index });
  } catch (error) {
    if (request !== detailsRequest || load !== loadId) return;
    panel.replaceChildren(heading(asset), el("p", { class: "error", role: "alert" }, errorText(error)));
    return;
  }
  if (request !== detailsRequest || load !== loadId) return; // another asset or file was chosen meanwhile
  panel.replaceChildren(heading(asset), ...renderDetails(result));
  panel.focus({ preventScroll: true });
  if (matchMedia("(max-width: 960px)").matches) {
    panel.scrollIntoView({ behavior: "instant", block: "start" });
  }
}

function heading(asset) {
  return el(
    "div",
    {},
    el("h3", {}, `${asset.typeName} "${asset.name}"`),
    el("details", { class: "metadata" }, el("summary", {}, "Asset information"), infoList([
      ["path", "Container path", asset.path ?? "(none)"],
      ["pathId", "Path ID", asset.pathId],
      ["file", "File", asset.file],
      ["byteSize", "Object size", bytesText(asset.byteSize)],
    ])),
  );
}

function renderDetails(result) {
  switch (result.kind) {
    case "image":
      return renderImage(result);
    case "text":
      return [
        el("h3", {}, `Text (${bytesText(result.size)}, UTF-8)`),
        el("pre", { id: "text-content" }, result.text),
      ];
    case "hex":
      return [
        el("h3", {}, `Binary (${bytesText(result.size)})`),
        el("p", { class: "muted small" }, "Not UTF-8 text; the first 4 KiB as hex:"),
        el("pre", { id: "hex-content" }, result.hex),
      ];
    case "mono":
      return [
        el("h3", {}, "Script"),
        infoList([["script", "Class", result.script ?? "(MonoScript not loaded)"]]),
        el("h3", {}, "Fields"),
        result.fields === undefined
          ? el("p", { class: "muted" }, "No fields: the bundle was built without type trees.")
          : el("div", { id: "fields" }, tree(result.fields)),
        el("h3", {}, "Header"),
        tree(result.header, { open: 1 }),
      ];
    case "media": {
      const { name, mime, bytes } = result.download;
      return [
        el("h3", {}, "Metadata"),
        tree(result.meta, { open: 1 }),
        el("h3", {}, "Raw bytes"),
        el(
          "p",
          {},
          `${result.field}: ${bytesText(result.size)}, as stored (not decoded). `,
          el(
            "button",
            { type: "button", onclick: () => download(new Blob([bytes], { type: mime }), name) },
            `Download ${name}`,
          ),
        ),
      ];
    }
    default:
      return [el("h3", {}, "Data"), el("div", { id: "data" }, tree(result.data))];
  }
}

function renderImage(result) {
  const out = [];
  const info = result.info;
  if (info !== undefined) {
    const sprite = info.sprite;
    const rect = (r) => `x ${r.x}, y ${r.y}, ${r.width} x ${r.height}`;
    out.push(
      el(
        "details",
        { id: "image-info" },
        el("summary", {}, "Image information"),
        infoList([
          ["kind", "Kind", info.kind],
          ["size", "Size", `${info.width} x ${info.height}`],
          ["formatName", "Format", `${info.formatName} (${info.format})`],
          ["compression", "Compression", info.compression],
          ["mipCount", "Mip levels", info.mipCount],
          ["colorSpace", "Colour space", info.colorSpace],
          ["platform", "Platform", `${info.platformName} (${info.platform})`],
          ["streamed", "Streamed (.resS)", info.streamed ? "yes" : "no"],
          ["encodedSize", "Encoded size", bytesText(info.encodedSize)],
          ["readable", "Readable", info.readable ? "yes" : "no"],
          [
            "wrapMode",
            "Wrap U / V / W",
            `${info.wrapMode.u} / ${info.wrapMode.v} / ${info.wrapMode.w}`,
          ],
          ["filterMode", "Filter mode", info.filterMode],
          ["spriteRect", "Sprite rect", sprite && rect(sprite.rect)],
          ["textureRect", "Texture rect", sprite && rect(sprite.textureRect)],
          ["pivot", "Pivot", sprite && `${sprite.pivot.x}, ${sprite.pivot.y}`],
          ["pixelsPerUnit", "Pixels per unit", sprite?.pixelsPerUnit],
          ["packed", "Packed", sprite && (sprite.packed ? `yes, ${sprite.packingMode}` : "no")],
          ["rotation", "Packing rotation", sprite && `${sprite.rotationName} (${sprite.rotation})`],
          ["atlas", "Atlas", sprite && (sprite.atlas ?? "(none)")],
          ["texture", "Cut from", sprite && `${sprite.texture.name} (${sprite.texture.width} x ${sprite.texture.height})`],
        ]),
      ),
    );
  }
  if (result.error !== undefined) {
    out.push(el("p", { class: "error", role: "alert" }, errorText(result.error)));
    return out;
  }
  const canvas = el("canvas", { id: "preview", "aria-label": "Decoded image preview" });
  drawRgba(canvas, result.rgba, result.width, result.height);
  const scale = Math.max(1, Math.floor(256 / Math.max(result.width, result.height, 1)));
  canvas.style.width = `${result.width * scale}px`;
  const stage = el("div", {
    id: "preview-stage", class: "preview-stage", dataset: { background: "checker" },
    tabindex: 0, "aria-label": "Image preview; scroll to inspect a zoomed image",
  }, canvas);
  const zoom = el("select", {
    "aria-label": "Zoom",
    onchange: () => {
      const fit = zoom.value === "fit";
      canvas.style.width = `${result.width * (fit ? scale : Number(zoom.value))}px`;
      canvas.style.maxWidth = fit ? "100%" : "none";
    },
  }, ...[["fit", "Fit"], ["1", "100%"], ["2", "200%"], ["4", "400%"]].map(
    ([value, label]) => el("option", { value }, label),
  ));
  const background = el("select", {
    "aria-label": "Background",
    onchange: () => { stage.dataset.background = background.value; },
  }, ...[["checker", "Checkerboard"], ["dark", "Dark"], ["light", "Light"]].map(
    ([value, label]) => el("option", { value }, label),
  ));
  const name = (info?.name || "image").replace(/[\\/:*?"<>|]/g, "_");
  out.unshift(
    el(
      "div",
      { class: "preview-wrap" },
      el("div", { class: "preview-toolbar" },
        el("label", {}, "Zoom", zoom),
        el("label", {}, "Background", background),
        el("button", {
          type: "button",
          disabled: result.width === 0 || result.height === 0,
          onclick: () => canvas.toBlob((blob) => blob && download(blob, `${name}.png`), "image/png"),
        }, "Download PNG"),
      ),
      stage,
      el(
        "p",
        { class: "muted small" },
        `${result.width} x ${result.height}, decoded in ${result.ms.toFixed(1)} ms.`,
      ),
    ),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Batch

$("decode-all").addEventListener("click", async () => {
  const button = $("decode-all");
  const progress = $("batch-progress");
  const note = $("batch-status");
  const gallery = $("gallery");
  const load = loadId;
  button.disabled = true;
  gallery.replaceChildren();
  progress.hidden = false;
  progress.value = 0;
  note.textContent = "Decoding...";
  try {
    const result = await call(
      "decodeAll",
      {},
      {
        onProgress: ({ done, total, image }) => {
          if (load !== loadId) return; // another file was opened: openSources cleared the batch
          progress.max = Math.max(total, 1);
          progress.value = done;
          note.textContent = `${done} of ${total}`;
          if (image === undefined) return;
          const canvas = el("canvas");
          drawRgba(canvas, image.thumb.rgba, image.thumb.width, image.thumb.height);
          gallery.append(
            el(
              "li",
              {},
              el(
                "button",
                {
                  type: "button",
                  title: `${image.kind} ${image.name}, ${image.width} x ${image.height}`,
                  onclick: () => select(image.index),
                },
                canvas,
                el("span", {}, image.name || "(unnamed)"),
              ),
            ),
          );
        },
      },
    );
    if (load !== loadId) return;
    progress.value = progress.max;
    note.textContent = `${result.decoded} decoded, ${result.skipped} skipped (of ${result.total}).`;
  } catch (error) {
    if (load === loadId) note.textContent = errorText(error);
  } finally {
    button.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Start: load the packages now, so the first open does not wait for them.

call("versions")
  .then(({ versions, wasmPath }) => {
    const list = Object.entries(versions).map(([name, v]) => `${name}@${v}`);
    $("versions").textContent = LOCAL
      ? "Packages: this repository's builds (?local)."
      : `Packages: ${list.join(", ")} from jsDelivr; WASM from ${wasmPath}.`;
    // Unless an open started meanwhile and owns the status now.
    if (!opened) {
      setStatus("ready", "Ready. Open a file, a URL or a sample.");
    }
  })
  .catch((error) => setStatus("error", `The reader did not load. ${errorText(error)}`));
