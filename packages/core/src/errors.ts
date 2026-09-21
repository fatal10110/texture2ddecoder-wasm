/**
 * Errors thrown by the reader.
 *
 * R9: unsupported input must say what was found, and callers must be able to
 * tell "this file is fine, we just cannot read it" from "this file is broken".
 * Those are different classes rather than a flag, so a `catch` can branch on
 * them directly.
 *
 * ponytail: no shared base class - two classes, and `instanceof` on each covers
 * every caller so far. Add one if something needs to catch all reader errors.
 */

/**
 * Input is well-formed but uses something this library does not implement:
 * a compression type, container signature or format version.
 *
 * @example
 * throw new UnsupportedError("compression type", "LZHAM");
 * // → "unsupported compression type: LZHAM"
 */
export class UnsupportedError extends Error {
  override readonly name = "UnsupportedError";

  /** What sort of thing is unsupported, e.g. `"compression type"`. */
  readonly kind: string;

  /** The offending value, so callers can report it without parsing `message`. */
  readonly found: string | number;

  constructor(kind: string, found: string | number, hint?: string) {
    super(`unsupported ${kind}: ${found}${hint ? ` (${hint})` : ""}`);
    this.kind = kind;
    this.found = found;
  }
}

/**
 * Input claims to be something this library reads, but does not hold together:
 * truncated data, a size that disagrees with its header, a bad magic number.
 *
 * Never thrown for input we simply do not support - that is
 * {@link UnsupportedError}.
 *
 * @example
 * throw new CorruptError(`block wrote ${written} bytes but expected ${size}`);
 */
export class CorruptError extends Error {
  override readonly name = "CorruptError";

  constructor(message: string) {
    super(message);
  }
}
