// Browser test of the GitHub Pages demo, docs/index.html (#209): samples
// opened through open() in a Worker, the asset table and its filters,
// env.get, image previews with their imageInfo, TextAsset text, MonoBehaviour
// fields, raw media bytes, "decode all images" and error display.
//
// By default the page runs with `?local`: the Worker takes the packages from
// serve.mjs (this repo's builds behind a stand-in for jsDelivr's `/+esm`) and
// the samples from /fixtures/bundles/, so CI tests the code of the commit and
// not the CDN. `CDN_LIVE=1` opens the page without `?local`: packages from
// jsDelivr, samples from jsDelivr's GitHub endpoint (`main`). That needs the
// network and checks what is published, so CI does not run it.
//
// Every expected value comes from fixtures/goldens.json (the UnityPy oracle, R12).
import { expect, test, type Download, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
// Types only: Playwright loads fixtures/helpers.ts as CommonJS (the root
// package.json has no "type"), where its `import.meta.url` does not parse.
import type { Golden, GoldenSerialized, GoldenTexture } from "../../fixtures/helpers.ts";

const LIVE = process.env.CDN_LIVE === "1";
// The first open fetches the packages and the WASM; a cold jsDelivr cache takes seconds.
const LOAD_TIMEOUT = LIVE ? 60_000 : 15_000;

const GOLDENS: Record<string, Golden> = JSON.parse(
  readFileSync(new URL("../../fixtures/goldens.json", import.meta.url), "utf8"),
).fixtures;

const EDITOR = "editor/6000.3.25f1";

/** The one SerializedFile golden of a fixture (each sample bundle holds one). */
function serialized(fixture: string): GoldenSerialized {
  const files = Object.values(GOLDENS[`${EDITOR}/${fixture}`]!.serialized ?? {});
  expect(files, `${fixture}: SerializedFiles`).toHaveLength(1);
  return files[0]!;
}

/** Number of objects in some fixtures, from the goldens. */
function objectCount(...fixtures: string[]): number {
  return fixtures
    .map((f) => Object.values(GOLDENS[`${EDITOR}/${f}`]!.objects).flat().length)
    .reduce((a, b) => a + b, 0);
}

/** The typetree dump of the object called `name` in `fixture`. */
function typetreeOf(fixture: string, name: string): Record<string, unknown> {
  const found = Object.values(serialized(fixture).typetrees ?? {})
    .map((entry) => (entry as { value: Record<string, unknown> }).value)
    .filter((value) => value.m_Name === name);
  expect(found, `${fixture}: objects called ${name}`).toHaveLength(1);
  return found[0]!;
}

function goldenTexture(fixture: string, name: string): GoldenTexture {
  const found = Object.values(serialized(fixture).textures ?? {}).filter((t) => t.name === name);
  expect(found, `${fixture}: textures called ${name}`).toHaveLength(1);
  return found[0]!;
}

/** Rows in reverse order, as `reverseRows` in fixtures/helpers.ts. */
function reverseRows(rgba: Uint8Array, width: number): Uint8Array {
  const stride = width * 4;
  const out = new Uint8Array(rgba.length);
  for (let from = 0; from < rgba.length; from += stride) {
    out.set(rgba.subarray(from, from + stride), rgba.length - from - stride);
  }
  return out;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** What the init script records in the page. */
interface Recorded {
  /** Every `ImageData` put on the `#preview` canvas, as it was passed. */
  previews: { width: number; height: number; data: number[] }[];
}

declare global {
  interface Window {
    recorded: Recorded;
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const recorded: Recorded = { previews: [] };
    window.recorded = recorded;
    // The pixels as the page hands them over: reading the canvas back would
    // not give them exactly, since canvases store alpha premultiplied.
    const put = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (
      this: CanvasRenderingContext2D,
      ...args: Parameters<typeof put>
    ) {
      const [image] = args;
      if (this.canvas.id === "preview") {
        recorded.previews.push({
          width: image.width,
          height: image.height,
          data: Array.from(image.data),
        });
      }
      return put.apply(this, args);
    } as typeof put;
  });
  const response = await page.goto(LIVE ? "/docs/" : "/docs/?local");
  expect(response?.ok()).toBe(true);
  await expect(page.locator("#status")).toHaveText(/^Ready/, { timeout: LOAD_TIMEOUT });
});

/** Open the sample whose label matches `label`, and wait for its assets. */
async function openSample(page: Page, label: RegExp, assets: number): Promise<void> {
  const option = page.locator("#sample option").filter({ hasText: label });
  await page.selectOption("#sample", (await option.getAttribute("value"))!);
  await page.getByRole("button", { name: "Try a sample" }).click();
  await expect(page.locator("#status")).toHaveText(new RegExp(`^${assets} assets in `), {
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.locator("#assets tbody tr")).toHaveCount(assets);
}

/** The table row of the asset called `name` of type `type`. */
const rowOf = (page: Page, type: string, name: string) =>
  page
    .locator("#assets tbody tr")
    .filter({ has: page.locator("td:first-child", { hasText: new RegExp(`^${type}$`) }) })
    .filter({ has: page.getByRole("button", { name, exact: true }) });

async function choose(page: Page, type: string, name: string): Promise<void> {
  await rowOf(page, type, name).getByRole("button", { name, exact: true }).click();
  await expect(page.locator("#details h3").first()).toHaveText(`${type} "${name}"`);
}

/** The `imageInfo` value the details panel shows for `field`. */
const info = (page: Page, field: string) => page.locator(`#image-info [data-field="${field}"]`);

/** The last preview, compared with the golden hash (bottom row first). */
async function expectPreview(page: Page, width: number, height: number, rgbaSha256: string) {
  await expect.poll(() => page.evaluate(() => window.recorded.previews.length)).toBeGreaterThan(0);
  const image = await page.evaluate(() => window.recorded.previews.at(-1)!);
  expect([image.width, image.height]).toEqual([width, height]);
  expect(sha256(reverseRows(Uint8Array.from(image.data), width))).toBe(rgbaSha256);
}

async function downloadBytes(download: Download): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of (await download.createReadStream())!) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

test("a script's data, text and a texture: table, env.get, image, TextAsset, MonoBehaviour", async ({
  page,
}) => {
  const fixtures = ["lz4/main", "lz4/shared", "lz4/texture"];
  const total = objectCount(...fixtures);
  await openSample(page, /MonoBehaviour, TextAsset/, total);

  await test.step("the table lists every asset with its container path and path id", async () => {
    const container = fixtures.flatMap((f) => GOLDENS[`${EDITOR}/${f}`]!.container ?? []);
    expect(container.length).toBeGreaterThan(0);
    for (const entry of container) {
      const row = page.locator("#assets tbody tr").filter({ hasText: entry.pathId });
      await expect(row).toHaveCount(1);
      await expect(row.locator("td.path")).toHaveText(entry.path);
      await expect(row.locator("td.file")).toHaveText(entry.file);
    }
  });

  await test.step("text and type filters", async () => {
    await page.selectOption("#type-filter", "TextAsset");
    await expect(page.locator("#assets tbody tr")).toHaveCount(1);
    await page.selectOption("#type-filter", "");
    await page.fill("#filter", "checker");
    await expect(page.locator("#assets tbody tr")).toHaveCount(1);
    await page.fill("#filter", "");
    await page.locator("#filter").dispatchEvent("input");
    await expect(page.locator("#assets tbody tr")).toHaveCount(total);
  });

  const checker = goldenTexture("lz4/texture", "checker");
  await test.step("env.get finds an asset by container path, in any case", async () => {
    const entry = GOLDENS[`${EDITOR}/lz4/texture`]!.container!.find(
      (e) => e.pathId === Object.keys(serialized("lz4/texture").textures!)[0],
    )!;
    await page.fill("#get-path", entry.path.toUpperCase());
    await page.getByRole("button", { name: "Find" }).click();
    await expect(page.locator("#details h3").first()).toHaveText('Texture2D "checker"');
  });

  await test.step("a Texture2D: canvas preview and its imageInfo", async () => {
    await expectPreview(page, checker.width, checker.height, checker.rgbaSha256!);
    await expect(info(page, "size")).toHaveText(`${checker.width} x ${checker.height}`);
    // TextureFormat 4 is RGBA32.
    expect(checker.format).toBe(4);
    await expect(info(page, "formatName")).toHaveText("RGBA32 (4)");
    await expect(info(page, "compression")).toHaveText("none");
    await expect(info(page, "encodedSize")).toHaveText(`${checker.imageSize} B`);
    // The fixture keeps its pixels in the bundle's .resS node (fixtures/README.md).
    await expect(info(page, "streamed")).toHaveText("yes");
    await expect(info(page, "platform")).toHaveText(
      new RegExp(`\\(${serialized("lz4/texture").targetPlatform}\\)$`),
    );

    const [png] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download PNG" }).click(),
    ]);
    expect(png.suggestedFilename()).toBe("checker.png");
    const bytes = await downloadBytes(png);
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]); // \x89PNG
  });

  await test.step("a TextAsset shows its text", async () => {
    await choose(page, "TextAsset", "hello");
    const golden = typetreeOf("lz4/shared", "hello");
    await expect(page.locator("#text-content")).toHaveText(golden.m_Script as string);
  });

  await test.step("a MonoBehaviour shows its fields, 64-bit values exact", async () => {
    await choose(page, "MonoBehaviour", "data");
    const golden = typetreeOf("lz4/main", "data");
    const field = (path: string) => page.locator(`#fields li[data-path="${path}"] > span:last-child`);
    await expect(field("i32")).toHaveText(String(golden.i32));
    // Below -2^53 and UInt64 max: a Number would round them.
    await expect(field("i64")).toHaveText(golden.i64 as string);
    await expect(field("u64")).toHaveText(golden.u64 as string);
    await expect(field("text")).toHaveText(JSON.stringify(golden.text));
    const nested = golden.nested as { a: number; b: string };
    await expect(field("nested.a")).toHaveText(String(nested.a));
    await expect(field("nested.b")).toHaveText(JSON.stringify(nested.b));
    const ints = golden.ints as number[];
    for (const [i, value] of ints.entries()) await expect(field(`ints.${i}`)).toHaveText(String(value));
    const script = typetreeOf("lz4/main", "FixtureData");
    await expect(page.locator('#details [data-field="script"]')).toHaveText(
      script.m_ClassName as string,
    );
  });

  await test.step("another class shows its data", async () => {
    await choose(page, "Mesh", "tri");
    await expect(page.locator('#data li[data-path="m_Name"] > span:last-child')).toHaveText('"tri"');
  });

  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
});

test("sprites: preview and sprite info; decode all images", async ({ page }) => {
  const golden = serialized("sprite/sprites");
  await openSample(page, /^Sprites/, objectCount("sprite/sprites"));

  await test.step("a sprite packed into an atlas", async () => {
    const [, sprite] = Object.entries(golden.sprites!).find(([, s]) => s.name === "r_b")!;
    await choose(page, "Sprite", "r_b");
    await expectPreview(page, sprite.width, sprite.height, sprite.rgbaSha256);
    await expect(info(page, "kind")).toHaveText("Sprite");
    await expect(info(page, "size")).toHaveText(`${sprite.width} x ${sprite.height}`);
    // settingsRaw: bit 0 packed, bit 1 rectangle packing, bits 2-5 the rotation.
    const packing = (sprite.settingsRaw >> 1) & 1 ? "rectangle" : "tight";
    await expect(info(page, "packed")).toHaveText(
      sprite.settingsRaw & 1 ? `yes, ${packing}` : "no",
    );
    await expect(info(page, "rotation")).toHaveText(
      new RegExp(`\\(${(sprite.settingsRaw >> 2) & 0xf}\\)$`),
    );
    // The `r_` sprites are packed into the "rect" atlas (fixtures/README.md).
    await expect(info(page, "atlas")).toHaveText("rect");
    await expect(info(page, "pivot")).not.toBeEmpty();
    await expect(info(page, "spriteRect")).not.toBeEmpty();
  });

  await test.step("decode all images: every Texture2D and Sprite", async () => {
    const images = Object.keys(golden.textures!).length + Object.keys(golden.sprites!).length;
    await page.getByRole("button", { name: "Decode all images" }).click();
    await expect(page.locator("#batch-status")).toHaveText(
      `${images} decoded, 0 skipped (of ${images}).`,
      { timeout: LOAD_TIMEOUT },
    );
    await expect(page.locator("#gallery li")).toHaveCount(images);
    await expect(page.locator("#batch-progress")).toHaveJSProperty("value", images);
    // A thumbnail opens its image.
    await page.locator("#gallery").getByRole("button", { name: "tight" }).first().click();
    await expect(page.locator("#details h3").first()).toHaveText(/^(Texture2D|Sprite) "tight"$/);
  });
});

test("block-compressed textures decode through the WASM", async ({ page }) => {
  const fixture = "block/windows";
  await openSample(page, /BC1-BC7/, objectCount(fixture));
  for (const name of ["10_DXT1", "25_BC7", "28_DXT1Crunched"]) {
    const texture = goldenTexture(fixture, name);
    await choose(page, "Texture2D", name);
    await expectPreview(page, texture.width, texture.height, texture.rgbaSha256!);
    await expect(info(page, "formatName")).toHaveText(new RegExp(`\\(${texture.format}\\)$`));
  }
});

test("audio, video and font: metadata and the raw bytes", async ({ page }) => {
  const fixtures = ["lz4/audio", "lz4/video", "lz4/font"];
  await openSample(page, /Audio, video/, objectCount(...fixtures));
  const raw = fixtures.flatMap((f) => Object.values(serialized(f).rawData ?? {}));
  const cases: [string, string, string][] = [
    ["VideoClip", "clip", "clip.webm"],
    ["AudioClip", "tone-pcm", "tone-pcm.fsb"],
    ["Font", "glyphs", "glyphs.ttf"],
  ];
  for (const [type, name, file] of cases) {
    await choose(page, type, name);
    const golden = raw.find((r) => r.name === name)!;
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: `Download ${file}` }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(file);
    const bytes = await downloadBytes(download);
    expect(bytes.length).toBe(golden.size);
    expect(sha256(bytes)).toBe(golden.sha256);
  }
});

test("the reader runs in the Worker, with one copy of core", async ({ page }) => {
  const worker = page.workers().find((w) => new URL(w.url()).pathname === "/docs/demo/worker.js");
  expect(worker).toBeDefined();
  // The page itself loads no package (D4: the sync parse stays off the page's thread).
  const onPage = await page.evaluate(() =>
    performance.getEntriesByType("resource").map((entry) => entry.name),
  );
  expect(onPage.filter((url) => /\/npm\/unity-asset-reader/.test(url))).toEqual([]);
  // Core imported by the Worker and by the texture package's `/+esm` build is one module
  // URL. On jsDelivr that needs the exact version the texture build pins, which the
  // Worker reads from its headers; `@1` would load a second copy.
  const inWorker = await worker!.evaluate(() =>
    performance.getEntriesByType("resource").map((entry) => entry.name),
  );
  const core = inWorker.filter((url) =>
    /^\/npm\/unity-asset-reader(@[^/]*)?\//.test(new URL(url).pathname),
  );
  expect(core, "unity-asset-reader modules loaded in the Worker").toHaveLength(1);
  if (LIVE) {
    expect(new URL(core[0]!).pathname).toMatch(/^\/npm\/unity-asset-reader@\d+\.\d+\.\d+\/\+esm$/);
    await expect(page.locator("#versions")).toHaveText(
      /unity-asset-reader@\d+\.\d+\.\d+, unity-asset-reader-texture@\d+\.\d+\.\d+, texture2ddecoder-wasm@\d+\.\d+\.\d+ from jsDelivr/,
    );
  }
});

test("an error is shown with its class and message", async ({ page }) => {
  await page.setInputFiles("#file", {
    name: "broken.bundle",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("UnityFS\0truncated"),
  });
  await expect(page.locator("#status")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#status")).toHaveText(/^CorruptError: broken\.bundle: /);
});

test("the raw decoder demo is still there, and linked", async ({ page }) => {
  await page.getByRole("link", { name: "Raw decoder demo" }).click();
  await expect(page).toHaveURL(/\/docs\/decoder\.html$/);
  await expect(page.locator("h1")).toContainText("texture2ddecoder-wasm");
});
