// Ported from AssetStudio/Classes/MovieTexture.cs (MIT, © Perfare / RazTools / Razviar)

import { CorruptError, UnsupportedError } from "../errors.js";
import type { ObjectReader } from "../serialized/ObjectReader.js";
import { readCount } from "../serialized/TypeTree.js";
import { readPPtr, type PPtr } from "./PPtr.js";
import { readTexture, type Texture } from "./Texture.js";
import { atLeast } from "./version.js";

/**
 * The fields of a `MovieTexture`, as a player build stores them, under Unity's
 * names: keys, their order and their values agree with `readTypeTree()` on the
 * same object.
 *
 * Before Unity 2019.3 the movie, an Ogg Theora file as the editor imported it,
 * is inline in `m_MovieData`. From 2019.3 Unity's type tree has only the
 * `Texture` fields, so there is no movie to extract.
 */
export interface MovieTexture extends Texture {
  /** Before Unity 2019.3. */
  m_Loop?: boolean;
  /** Before Unity 2019.3: the clip that plays with the movie. */
  m_AudioClip?: PPtr;
  /** Before Unity 2019.3: the movie, a view into the object's bytes (R7). */
  m_MovieData?: Uint8Array;
  /** Unity 3.5 to 2019.2. */
  m_ColorSpace?: number;
}

/**
 * Read a `MovieTexture` from the object's first byte: the `Texture` fields,
 * then those of Unity's own player type trees for its version (UnityPy's TPK
 * data), in their order. Upstream reads `m_Loop`, `m_AudioClip` and
 * `m_MovieData` for every version; Unity's trees also have `m_ColorSpace`
 * after them from 3.5, and none of the three from 2019.3.
 *
 * Below 3.4 there is no type tree data, so such a file is refused. An unknown
 * version and an editor file are refused as `readTexture` refuses them: the
 * `Texture` fields already depend on the version.
 *
 * No fixture holds a MovieTexture: none of the fixture editors (2019.4 and
 * later) writes one with a movie in it.
 *
 * The object must end exactly after its last field (upstream does not check).
 *
 * @param reader the object's reader, rewound first and left at its end
 * @throws {UnsupportedError} of kind `"Unity version"`, with the file's own
 *   `unityVersion` as `found`, below 3.4; as `readTexture` does, for an
 *   unknown version or an editor file
 * @throws {CorruptError} when the object ends early, the `m_MovieData` byte
 *   count is negative or runs past its end, or bytes are left over after the
 *   last field
 */
export function readMovieTexture(reader: ObjectReader): MovieTexture {
  const { version } = reader;
  const stripped = version.every((part) => part === 0);
  // readTexture refuses an unknown version itself (#36).
  if (!stripped && !atLeast(version, 3, 4)) {
    throw new UnsupportedError(
      "Unity version",
      reader.unityVersion,
      `object ${reader.pathId}: no known MovieTexture layout before Unity 3.4`,
    );
  }

  const out: MovieTexture = readTexture(reader);
  // Gone from 2019.3: a MovieTexture is then the Texture fields alone.
  if (!atLeast(version, 2019, 3)) {
    out.m_Loop = reader.readUInt8() !== 0;
    reader.align();
    out.m_AudioClip = readPPtr(reader);
    out.m_MovieData = reader.readBytes(
      readCount(reader, `MovieTexture ${reader.pathId} m_MovieData byte`),
    );
    reader.align();
    if (atLeast(version, 3, 5)) out.m_ColorSpace = reader.readInt32();
  }

  if (reader.remaining !== 0) {
    throw new CorruptError(
      `MovieTexture ${reader.pathId} ends at ${reader.position} of its ${reader.byteSize} bytes`,
    );
  }
  return out;
}
