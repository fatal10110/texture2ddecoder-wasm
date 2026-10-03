import { load, type Env, type LoadOptions, type LoadSource } from "./env.js";

// The package compiles with `lib: ["ES2020"]` and no DOM or node types (R4),
// so the WHATWG types `open()` takes are declared here by the members it
// uses. `fetch`, `Response`, `Request`, `Blob`, `File` and `URL` of browsers,
// workers, Deno and Node >= 18 all fit them.

/** The parts of a WHATWG `Response` that {@link open} uses. */
export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  /** Empty for a `Response` built by hand. */
  readonly url: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The parts of a WHATWG `Request` that {@link open} uses; it is passed to `fetch` as it is. */
export interface RequestLike {
  readonly url: string;
  readonly method: string;
}

/** The parts of a `Blob` (or a `File`, which adds `name`) that {@link open} uses. */
export interface BlobLike {
  readonly size: number;
  readonly type: string;
  /** A `File`'s name. */
  readonly name?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The parts of a WHATWG `URL` that {@link open} uses. */
export interface URLLike {
  readonly href: string;
  readonly pathname: string;
}

/**
 * One input of {@link open}:
 *
 * - `string` or `URL`: fetched. The file is named after the last segment of
 *   the URL's path, decoded, without query or fragment.
 * - `Request`: fetched as it is, named after its `url`.
 * - `Response`: read as it is, named after its `url` when it has one.
 * - `Blob` / `File`: read; a `File` keeps its `name`.
 * - bytes or `{ name, data }`: passed to `load()` unchanged.
 *
 * A file that gets no name from any of these is called `"input <index>"`, as
 * in `load()`.
 */
export type OpenSource = string | URLLike | RequestLike | ResponseLike | BlobLike | LoadSource;

/** Options of {@link open}. */
export interface OpenOptions extends LoadOptions {
  /**
   * The `fetch` to use instead of the global one: to add headers or
   * credentials, or where there is no global `fetch`. It is called with the
   * URL as a string, or with the `Request` passed to {@link open}.
   */
  fetch?(input: string | RequestLike): Promise<ResponseLike>;
}

/** The global `fetch`, when the platform has one (every one {@link open} targets does). */
declare const fetch: ((input: string | RequestLike) => Promise<ResponseLike>) | undefined;

/**
 * Fetch or read files, then {@link load} them: the async way in, for input
 * that is not bytes yet. Only getting the bytes is async; parsing stays sync,
 * inside `load()` (D4).
 *
 * Every source is fetched or read at once, and the files are passed to
 * `load()` in the order given, so `load()`'s "first one loaded" rules follow
 * that order. Loose files need their real names (see `LoadInput.name`), which
 * a URL or a `File` gives.
 *
 * @example
 * const env = await open("https://cdn.example.com/ui.bundle");
 * const env2 = await open([fileInput.files[0], "/assets/sharedassets0.assets.resS"]);
 * const env3 = await open(url, { fetch: (input) => fetch(input, { headers }) });
 *
 * @param sources one source or several (see {@link OpenSource})
 * @param options a `fetch` of your own and {@link LoadOptions} passed to `load()`
 * @returns the `Env` that `load()` returns for the files
 * @throws {Error} when a response is not OK (its status outside 200-299),
 *   naming the URL and the status; and a failed `fetch`'s own error, its
 *   message prefixed with the URL
 * @throws {TypeError} when a source is none of the above, or a URL is given
 *   and there is neither `options.fetch` nor a global `fetch`
 * @throws what `load()` throws
 */
export async function open(
  sources: OpenSource | readonly OpenSource[],
  options: OpenOptions = {},
): Promise<Env> {
  const list: readonly OpenSource[] = isList(sources) ? sources : [sources];
  const inputs = await Promise.all(list.map((source, index) => read(source, index, options)));
  return load(inputs, options);
}

/** `Array.isArray`, which does not narrow a union with a `readonly` array by itself. */
function isList(sources: OpenSource | readonly OpenSource[]): sources is readonly OpenSource[] {
  return Array.isArray(sources);
}

/** One source as `load()` takes it. */
async function read(source: OpenSource, index: number, options: OpenOptions): Promise<LoadSource> {
  if (typeof source === "string") return fetched(source, source, options);
  if (typeof source !== "object" || source === null) throw notASource(index);
  // Bytes and `{ name, data }` go to `load()`, which checks them itself.
  if (source instanceof Uint8Array || "data" in source || isArrayBuffer(source)) return source;
  // A `URL` is the only one with `href`; `Request` and `Response` have `url`.
  if (has(source, "href", "string") && has(source, "pathname", "string")) {
    const url = source as URLLike;
    return fetched(url.href, url.pathname, options);
  }
  if (has(source, "ok", "boolean") && has(source, "status", "number")) {
    return fromResponse(source as ResponseLike, (source as ResponseLike).url);
  }
  if (has(source, "url", "string") && has(source, "method", "string")) {
    const request = source as RequestLike;
    return fetched(request, request.url, options);
  }
  if (has(source, "size", "number") && has(source, "arrayBuffer", "function")) {
    const blob = source as BlobLike;
    return named(blob.name, new Uint8Array(await blob.arrayBuffer()));
  }
  throw notASource(index);
}

/** Fetch `input` and read the response, naming the file after `url`. */
async function fetched(
  input: string | RequestLike,
  url: string,
  options: OpenOptions,
): Promise<LoadSource> {
  const href = typeof input === "string" ? input : input.url;
  const fetchFn = options.fetch ?? (typeof fetch === "function" ? fetch : undefined);
  if (!fetchFn) {
    throw new TypeError(`${href}: no global fetch on this platform; pass options.fetch`);
  }
  let response: ResponseLike;
  try {
    response = await fetchFn(input);
  } catch (error) {
    if (error instanceof Error) error.message = `${href}: ${error.message}`;
    throw error;
  }
  return fromResponse(response, url, href);
}

/**
 * A response's body as a named file.
 *
 * @param url where the file's name comes from
 * @param href what an error names; the response's own `url` by default
 * @throws {Error} when the response is not OK
 */
async function fromResponse(response: ResponseLike, url: string, href = url): Promise<LoadSource> {
  if (!response.ok) {
    const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
    throw new Error(`${href || "response"}: HTTP ${status}`);
  }
  return named(fileName(url), new Uint8Array(await response.arrayBuffer()));
}

/** `{ name, data }`, leaving an empty or missing name to `load()`'s default. */
function named(name: string | undefined, data: Uint8Array): LoadSource {
  return name ? { name, data } : { data };
}

/**
 * The file name a URL gives: the last segment of its path, percent-decoded,
 * without query or fragment. `undefined` when the path ends in `/`.
 */
function fileName(url: string): string | undefined {
  const path = url.replace(/[?#].*$/s, "");
  const last = path.slice(path.lastIndexOf("/") + 1);
  if (!last) return undefined;
  try {
    return decodeURIComponent(last);
  } catch {
    // A stray `%` is not an escape; keep the segment as it is.
    return last;
  }
}

/** Whether `value[key]` is of type `type`. */
function has(value: object, key: string, type: string): boolean {
  return typeof (value as Record<string, unknown>)[key] === type;
}

/** An ArrayBuffer, from this realm or another one. */
function isArrayBuffer(value: object): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

function notASource(index: number): TypeError {
  return new TypeError(
    `input ${index}: expected a URL, a Request, a Response, a Blob, bytes or { name, data }`,
  );
}
