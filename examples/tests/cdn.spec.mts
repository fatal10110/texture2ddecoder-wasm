// Smoke test of examples/cdn.html (#35, plan §5): a bundle picked in the page
// is read in a Worker and its Texture2D drawn to the canvas, from plain static
// hosting with no COOP/COEP, while the page keeps painting frames.
//
// The packages come from serve.mjs (`?local`), this repo's builds behind a
// stand-in for jsDelivr's `/+esm`: the reader packages are not on npm until
// #45, so the jsDelivr URLs themselves cannot be tested yet.
import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// Types only: Playwright loads fixtures/helpers.ts as CommonJS (the root
// package.json has no "type"), where its `import.meta.url` does not parse.
import type { Golden, GoldenTexture } from "../../fixtures/helpers.ts";

const FIXTURES = new URL("../../fixtures/", import.meta.url);
const GOLDENS: Record<string, Golden> = JSON.parse(
  readFileSync(new URL("goldens.json", FIXTURES), "utf8"),
).fixtures;

const fixturePath = (name: string) => fileURLToPath(new URL(`bundles/${name}`, FIXTURES));

/** Rows in reverse order, as `reverseRows` in fixtures/helpers.ts. */
function reverseRows(rgba: Uint8Array, width: number): Uint8Array {
  const stride = width * 4;
  const out = new Uint8Array(rgba.length);
  for (let from = 0; from < rgba.length; from += stride) {
    out.set(rgba.subarray(from, from + stride), rgba.length - from - stride);
  }
  return out;
}

/** What the init script records in the page. */
interface Smoke {
  /** `requestAnimationFrame` timestamps, from the start. */
  frames: number[];
  /** Every `ImageData` the page put on a canvas, as it was passed. */
  images: { width: number; height: number; data: number[] }[];
}

declare global {
  interface Window {
    smoke: Smoke;
  }
}

/** The golden of the one texture called `name` in fixture `fixture`. */
function goldenTexture(fixture: string, name: string): GoldenTexture {
  const found = Object.values(GOLDENS[fixture]!.serialized ?? {})
    .flatMap((file) => Object.values(file.textures ?? {}))
    .filter((texture) => texture.name === name);
  expect(found, `${fixture}: textures called ${name}`).toHaveLength(1);
  return found[0]!;
}

/** The last image the page put on the canvas, compared with its golden. */
async function expectLastImage(page: Page, texture: GoldenTexture): Promise<number[]> {
  const image = await page.evaluate(() => window.smoke.images.at(-1));
  expect(image).toBeDefined();
  expect([image!.width, image!.height]).toEqual([texture.width, texture.height]);
  // The page gets top-down rows; the goldens hash Unity's bottom-up order.
  const rgba = reverseRows(Uint8Array.from(image!.data), image!.width);
  expect(createHash("sha256").update(rgba).digest("hex")).toBe(texture.rgbaSha256);
  return image!.data;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const smoke: Smoke = { frames: [], images: [] };
    window.smoke = smoke;
    const tick = (time: number) => {
      smoke.frames.push(time);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // Record the pixels as the page hands them over: reading the canvas back
    // would not give them exactly, since canvases store alpha premultiplied.
    const put = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (
      this: CanvasRenderingContext2D,
      ...args: Parameters<typeof put>
    ) {
      const [image] = args;
      smoke.images.push({ width: image.width, height: image.height, data: Array.from(image.data) });
      return put.apply(this, args);
    } as typeof put;
  });
});

test("cdn.html reads a bundle in a Worker and draws its Texture2D", async ({ page }) => {
  const workers: string[] = [];
  page.on("worker", (worker) => workers.push(worker.url()));

  const response = await page.goto("/examples/cdn.html?local");
  expect(response?.ok()).toBe(true);

  await test.step("static hosting: no COOP/COEP, not cross-origin isolated (D6)", async () => {
    const headers = response!.headers();
    expect(headers["cross-origin-opener-policy"]).toBeUndefined();
    expect(headers["cross-origin-embedder-policy"]).toBeUndefined();
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
  });

  // LZ4 bundle; the RGBA32 pixels are in its .resS node. Decoded in TS, but
  // initTexture still loads the WASM.
  const lz4 = "editor/6000.3.25f1/lz4/texture";
  const checker = goldenTexture(lz4, "checker");
  const start = await page.evaluate(() => performance.now());
  await page.setInputFiles("#file", fixturePath(lz4));
  await expect(page.locator("#caption")).toHaveText("checker: 4 x 4");
  const end = await page.evaluate(() => performance.now());

  await test.step("the objects are listed", async () => {
    const objects = Object.values(GOLDENS[lz4]!.objects).flat();
    const rows = page.locator("#objects tbody tr");
    await expect(rows).toHaveCount(objects.length);
    await expect(rows.filter({ hasText: "Texture2D" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "AssetBundle" })).toHaveCount(1);
  });

  await test.step("the canvas gets the golden pixels", async () => {
    await expectLastImage(page, checker);
    const size = await page.evaluate(() => {
      const canvas = document.getElementById("canvas") as HTMLCanvasElement;
      return [canvas.width, canvas.height];
    });
    expect(size).toEqual([4, 4]);
  });

  await test.step("the reader runs in the Worker, the page keeps painting (D4)", async () => {
    expect(workers.some((url) => new URL(url).pathname === "/examples/cdn-worker.js")).toBe(true);
    // The page's own resource timeline: nothing of the packages is loaded on the main thread.
    const mainThread = await page.evaluate(() =>
      performance.getEntriesByType("resource").map((entry) => entry.name),
    );
    expect(mainThread.filter((url) => new URL(url).pathname.startsWith("/npm/"))).toEqual([]);
    // From picking the file to the drawn texture - Worker start, module and
    // WASM loading, parse, decode - frames kept coming.
    const frames = await page.evaluate(
      ({ from, to }) => window.smoke.frames.filter((time) => time >= from && time <= to),
      { from: start, to: end },
    );
    expect(frames.length).toBeGreaterThan(0);
    const times = [start, ...frames, end];
    const longestGap = Math.max(...times.slice(1).map((time, i) => time - times[i]!));
    expect(longestGap).toBeLessThan(250);
  });

  await test.step("block formats decode through the WASM in the Worker", async () => {
    const windows = "editor/6000.3.25f1/block/windows";
    await page.setInputFiles("#file", fixturePath(windows));
    // The first Texture2D is drawn at once: DXT1 Crunch.
    await expect(page.locator("#caption")).toHaveText("28_DXT1Crunched: 32 x 16");
    await expectLastImage(page, goldenTexture(windows, "28_DXT1Crunched"));

    await page.getByRole("row", { name: /10_DXT1\b/ }).getByRole("button", { name: "Show" }).click();
    await expect(page.locator("#caption")).toHaveText("10_DXT1: 32 x 16");
    const dxt1 = await expectLastImage(page, goldenTexture(windows, "10_DXT1"));
    // DXT1 is opaque, so the canvas holds exactly what was put on it.
    const onCanvas = await page.evaluate(() => {
      const canvas = document.getElementById("canvas") as HTMLCanvasElement;
      return Array.from(canvas.getContext("2d")!.getImageData(0, 0, 32, 16).data);
    });
    expect(onCanvas).toEqual(dxt1);
  });

  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
});
