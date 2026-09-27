// MovieTexture (#41): no fixture editor (2019.4 and later) writes one with a
// movie in it, so the reader is checked against hand-built layouts from Unity's
// type trees (UnityPy's TPK data), version gate by version gate.

import assert from "node:assert/strict";
import { test } from "node:test";

import { readMovieTexture, type MovieTexture } from "../src/classes/MovieTexture.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";
import { BuildTarget } from "../src/serialized/BuildTarget.js";
import { ClassID } from "../src/serialized/ClassID.js";
import type { UnityVersion } from "../src/serialized/SerializedFile.js";
import {
  build,
  readerOf,
  template,
  versionRefusal,
  withTail,
  type Origin,
  type Writer,
} from "./media.js";

const FROM = template("editor/6000.3.25f1/lz4/font", ClassID.Font);
const reader = (bytes: Uint8Array, origin: Origin) =>
  readerOf(FROM, bytes, { classId: ClassID.MovieTexture, ...origin });

const MOVIE = Uint8Array.of(0x4f, 0x67, 0x67, 0x53, 7); // "OggS" and one more byte

/** 3.4 (TPK 3.4.0): the movie fields right after m_Name. */
const L3_4 = (w: Writer, wide: boolean): MovieTexture => ({
  m_Name: w.str("intro"),
  m_Loop: w.pad(w.bool(true)),
  m_AudioClip: w.pptr(0, 9n, wide),
  m_MovieData: w.pad(w.bytes(MOVIE)),
});

/** 3.5 to 2017.2 (TPK 3.5.0, 5.0.0): m_ColorSpace after the movie. */
const L3_5 = (w: Writer, wide: boolean): MovieTexture => ({
  ...L3_4(w, wide),
  m_ColorSpace: w.i32(1),
});

/** 2017.3 to 2019.2 (TPK 2017.3.0b1): the Texture fallback fields first. */
const L2017_3 = (w: Writer): MovieTexture => ({
  m_Name: w.str("intro"),
  m_ForcedFallbackFormat: w.i32(4),
  m_DownscaleFallback: w.pad(w.bool(false)),
  m_Loop: w.pad(w.bool(true)),
  m_AudioClip: w.pptr(0, 9n),
  m_MovieData: w.pad(w.bytes(MOVIE)),
  m_ColorSpace: w.i32(1),
});

/** 2019.3 to 2020.1 (TPK 2019.3.0a2): the Texture fields alone. */
const L2019_3 = (w: Writer): MovieTexture => ({
  m_Name: w.str("intro"),
  m_ForcedFallbackFormat: w.i32(4),
  m_DownscaleFallback: w.pad(w.bool(false)),
});

/** 2020.2 to 2023.1 (TPK 2020.2.0a11). */
const L2020_2 = (w: Writer): MovieTexture => ({
  m_Name: w.str("intro"),
  m_ForcedFallbackFormat: w.i32(4),
  m_DownscaleFallback: w.bool(false),
  m_IsAlphaChannelOptional: w.pad(w.bool(true)),
});

/** 2023.2 on (TPK 2023.2.0a18; the class is gone from 6000.6). */
const L2023_2 = (w: Writer): MovieTexture => ({
  m_Name: w.str("intro"),
  m_IsAlphaChannelOptional: w.pad(w.bool(true)),
});

const LAYOUTS: { unity: UnityVersion; format: number; layout: (w: Writer) => MovieTexture }[] = [
  { unity: [3, 4, 0, 1], format: 8, layout: (w) => L3_4(w, false) },
  { unity: [3, 5, 0, 1], format: 9, layout: (w) => L3_5(w, false) },
  { unity: [4, 7, 2, 1], format: 9, layout: (w) => L3_5(w, false) },
  { unity: [5, 0, 0, 1], format: 15, layout: (w) => L3_5(w, true) },
  { unity: [2017, 2, 0, 1], format: 17, layout: (w) => L3_5(w, true) },
  { unity: [2017, 3, 0, 1], format: 17, layout: L2017_3 },
  { unity: [2019, 2, 0, 1], format: 20, layout: L2017_3 },
  { unity: [2019, 3, 0, 1], format: 21, layout: L2019_3 },
  { unity: [2020, 1, 0, 1], format: 22, layout: L2019_3 },
  { unity: [2020, 2, 0, 1], format: 22, layout: L2020_2 },
  { unity: [2023, 1, 0, 1], format: 22, layout: L2020_2 },
  { unity: [2023, 2, 0, 1], format: 22, layout: L2023_2 },
  { unity: [6000, 3, 25, 1], format: 22, layout: L2023_2 },
];

for (const { unity, format, layout } of LAYOUTS) {
  test(`Unity ${unity.slice(0, 3).join(".")}: the player layout of Unity's type tree`, () => {
    const { bytes, expected } = build(layout);
    const r = reader(bytes, { unity, format });
    const movie = readMovieTexture(r);
    assert.deepEqual(Object.keys(movie), Object.keys(expected));
    assert.deepEqual(movie, expected);
    assert.equal(r.remaining, 0);
  });
}

test("obj.read() of a MovieTexture is readMovieTexture: the movie, a view into the object", () => {
  const { bytes, expected } = build(L2017_3);
  const r = reader(bytes, { unity: [2018, 4, 36, 1], format: 17 });
  const movie = r.read<MovieTexture>();
  assert.deepEqual(movie, expected);
  assert.deepEqual(movie.m_MovieData, MOVIE);
  assert.equal(movie.m_MovieData!.buffer, bytes.buffer);
});

test('read(): a MovieTexture with a bad m_Name length throws CorruptError, not ""', () => {
  // registry.test.ts's NAMED table does this for every class with a fixture;
  // MovieTexture has none, so a hand-built object stands in.
  const { bytes } = build(L2017_3);
  const size = bytes.length;
  const cases: [number, string][] = [
    [-1, "m_Name byte count -1 at offset 0 is negative"],
    [size, `m_Name byte count ${size} at offset 0 exceeds the ${size - 4} bytes left`],
  ];
  for (const [length, message] of cases) {
    const copy = bytes.slice();
    new DataView(copy.buffer).setInt32(0, length, true);
    const r = reader(copy, { unity: [2018, 4, 36, 1], format: 17 });
    assert.throws(
      () => r.read(),
      (err: unknown) =>
        err instanceof CorruptError && err.message === `MovieTexture ${r.pathId} ${message}`,
      `length ${length}`,
    );
  }
});

// --- refusals ---------------------------------------------------------------------

const REFUSED: { unity: UnityVersion; text: string; format: number; why: string }[] = [
  { unity: [0, 0, 0, 0], text: "0.0.0", format: 22, why: "[0,0,0,0] in format 22" },
  { unity: [0, 0, 0, 0], text: "0.0.0", format: 17, why: "[0,0,0,0] in format 17" },
  { unity: [0, 0, 0, 0], text: "2.5.0f5", format: 6, why: "[0,0,0,0] in a format 6 loose file" },
  { unity: [3, 3, 0, 1], text: "3.3.0f1", format: 8, why: "a known version below 3.4" },
];

for (const { unity, text, format, why } of REFUSED) {
  test(`${why}: UnsupportedError("Unity version", "${text}")`, () => {
    // The Texture fields already depend on the version, so no layout is guessed.
    const r = reader(build(L2017_3).bytes, { unity, text, format });
    assert.throws(() => readMovieTexture(r), versionRefusal(text));
    assert.throws(() => r.read(), versionRefusal(text));
  });
}

test("an editor file (NoTarget) is refused, as readTexture refuses it", () => {
  const r = reader(build(L2017_3).bytes, {
    unity: [2018, 4, 36, 1],
    platform: BuildTarget.NoTarget,
  });
  assert.throws(
    () => readMovieTexture(r),
    (err: unknown) =>
      err instanceof UnsupportedError && err.kind === "build target" && err.found === "NoTarget",
  );
});

// --- corrupt objects ----------------------------------------------------------------

test("every cut through a MovieTexture throws CorruptError", () => {
  const { bytes } = build(L2017_3);
  const unity: UnityVersion = [2018, 4, 36, 1];
  // It ends with m_ColorSpace, an Int32: every cut loses data.
  for (let cut = 0; cut < bytes.length; cut++) {
    assert.throws(
      () => readMovieTexture(reader(bytes.subarray(0, cut), { unity, format: 17 })),
      CorruptError,
      `cut at ${cut}`,
    );
  }
});

test("bytes left after the last field throw CorruptError", () => {
  for (const [unity, layout] of [
    [[2018, 4, 36, 1], L2017_3],
    [[2019, 4, 41, 2], L2019_3],
  ] as const) {
    const r = reader(withTail(build(layout).bytes, 0, 0, 0, 0), { unity: [...unity] });
    assert.throws(() => readMovieTexture(r), /MovieTexture -?\d+ ends at \d+ of its \d+ bytes/);
  }
});

test("a negative m_MovieData count throws CorruptError", () => {
  const { bytes } = build((w) => ({
    m_Name: w.str("intro"),
    m_Loop: w.pad(w.bool(true)),
    m_AudioClip: w.pptr(0, 9n),
    count: w.i32(-1),
  }));
  const r = reader(bytes, { unity: [5, 6, 7, 1], format: 17 });
  assert.throws(() => readMovieTexture(r), /MovieTexture -?\d+ m_MovieData byte count -1/);
});
