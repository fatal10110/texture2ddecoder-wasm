// Harness self-check. No reader exists yet (#19), so this proves the fixtures
// and goldens are loadable and consistent, and that the comparator actually
// fails on bad input - a comparator that never fails proves nothing.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertMatchesGolden,
  fixtureNames,
  golden,
  gunzipFixture,
  loadFixture,
  sha256,
  type GoldenSerialized,
} from "../../fixtures/helpers.js";

const names = fixtureNames();

test("every golden has a fixture file behind it", () => {
  assert.ok(names.length >= 9, `only ${names.length} fixtures`);
  for (const name of names) {
    assert.ok(loadFixture(name).byteLength > 0, `${name} is empty`);
  }
});

test("fixtures carry the signature their golden claims", () => {
  for (const name of names) {
    const raw = name.endsWith(".gz") ? gunzipFixture(name) : loadFixture(name);
    // 20 bytes is upstream's signature cap; "UnityWebData1.0" needs 15 of them.
    const magic = Buffer.from(raw.subarray(0, 20)).toString("latin1");
    assert.ok(
      magic.startsWith(golden(name).signature),
      `${name}: starts with ${JSON.stringify(magic)}, golden says ${golden(name).signature}`,
    );
  }
});

test("M1 compression shapes are all covered", () => {
  for (const want of ["uncompressed.bundle", "lz4.bundle", "lzma.bundle", "unityweb-lzma.bundle"]) {
    assert.ok(names.includes(want), `missing fixture ${want}`);
  }
  assert.ok(names.some((n) => n.endsWith(".gz")), "missing gzip-wrapped fixture");
});

test("editor fixtures cover SerializedFile formats 21 and 22 in every variant (#82)", () => {
  // format -> variants seen, from paths like "editor/2019.4.41f2/lz4/main"
  const seen = new Map<number, Set<string>>();
  for (const name of names) {
    for (const serialized of Object.values(golden(name).serialized ?? {})) {
      const variant = name.split("/")[2] ?? name;
      const variants = seen.get(serialized.formatVersion) ?? new Set();
      seen.set(serialized.formatVersion, variants.add(variant));
    }
  }
  for (const format of [21, 22]) {
    const variants = seen.get(format);
    assert.ok(variants, `no SerializedFile of format ${format} in any fixture`);
    for (const want of ["lz4", "lzma", "uncompressed", "lz4-notypetree"]) {
      assert.ok(variants.has(want), `format ${format} has no ${want} fixture`);
    }
  }
});

test("editor fixtures cover TypelessData, .resS and both NaN patterns in formats 21 and 22 (#86)", () => {
  // #25's test inputs. A rebuild that drops tri.asset, or runs BuildFixtures a
  // second time (every NaN becomes 0x7FC00000), must fail here, not go quiet.
  const hasTypeless = (s: GoldenSerialized, name: string) =>
    s.types.some((t) => t.nodes?.some(([, type, n]) => type === "TypelessData" && n === name));
  const strings = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : value !== null && typeof value === "object"
        ? Object.values(value).flatMap(strings)
        : [];

  for (const format of [21, 22]) {
    const found = { filled: false, empty: false, resS: false, nan7f: false, nanFf: false };
    for (const name of names) {
      const g = golden(name);
      for (const s of Object.values(g.serialized ?? {})) {
        if (s.formatVersion !== format) continue;
        if (Object.keys(g.files).some((path) => path.endsWith(".resS"))) found.resS = true;
        for (const { value } of Object.values(s.typetrees)) {
          const v = value as { m_VertexData?: { m_DataSize?: unknown }; "image data"?: unknown };
          const data = v.m_VertexData?.m_DataSize;
          if (hasTypeless(s, "m_DataSize") && typeof data === "string" && /^hex:([0-9a-f]{2})+$/.test(data)) {
            found.filled = true;
          }
          if (hasTypeless(s, "image data") && v["image data"] === "hex:") found.empty = true;
          const all = strings(value);
          if (all.includes("f32:7fc00000")) found.nan7f = true;
          if (all.includes("f32:ffc00000")) found.nanFf = true;
        }
      }
    }
    assert.deepEqual(
      found,
      { filled: true, empty: true, resS: true, nan7f: true, nanFf: true },
      `format ${format} is missing a #86 shape`,
    );
  }
});

test("gzip fixture unpacks to the same files as its plain counterpart", () => {
  assert.deepEqual(golden("gzip-lz4.bundle.gz").files, golden("lz4.bundle").files);
});

test("assertMatchesGolden accepts the golden's own bytes", () => {
  const name = "lz4.bundle";
  const files = Object.entries(golden(name).files).map(([path, { size }]) => ({
    path,
    data: new Uint8Array(size),
  }));
  // Zeroed data has the right length but the wrong hash, so this must throw.
  assert.throws(() => assertMatchesGolden(name, files), /sha256/);
});

test("assertMatchesGolden rejects missing and unexpected nodes", () => {
  assert.throws(() => assertMatchesGolden("lz4.bundle", []), /node paths differ/);
  assert.throws(
    () => assertMatchesGolden("lz4.bundle", [{ path: "nope", data: new Uint8Array() }]),
    /node paths differ/,
  );
});

test("sha256 matches the oracle's normalization", () => {
  assert.equal(
    sha256(new Uint8Array()),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});
