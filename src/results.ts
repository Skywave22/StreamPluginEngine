/**
 * Phase 6: normalized source result pipeline.
 *
 * Plugins return RAW structured source results (plain data produced from
 * HTTP + HTML/JSON work in Phases 4–5). The engine turns that untrusted
 * raw output into TRUSTED normalized results before the future
 * application consumes them:
 *
 *   plugin capability (QuickJS guest)
 *     → raw plugin output (unknown — treated as untrusted)
 *     → extractRawList + validateItem   (validated: typed fields)
 *     → toNormalized                    (normalized: trimmed strings,
 *                                        canonical URLs, safe metadata)
 *     → SourceResult[]                  (trusted, JSON-serializable)
 *
 * This module is pure host logic: no QuickJS, no network, no filesystem.
 * Result URLs are NEVER fetched or verified — they are data only.
 *
 * Validation is all-or-nothing: the first problem aborts with a
 * structured `{ code, message }` error (never a host stack trace).
 * Invalid OPTIONAL values are dropped (the result still passes);
 * SIZE violations and invalid REQUIRED values reject the whole input.
 */

// ---------------------------------------------------------------------------
// Limits (explicit engine constants — plugins cannot raise them)
// ---------------------------------------------------------------------------

export const RESULT_LIMITS = {
  /** Maximum number of results in one plugin return value. */
  maxResults: 1_000,
  /** Maximum length of `id`. */
  maxIdLength: 200,
  /** Maximum length of `title`. */
  maxTitleLength: 500,
  /** Maximum length of `url` (also used for `thumbnail` and subtitle URLs). */
  maxUrlLength: 2_048,
  /** Maximum length of `source`. */
  maxSourceLength: 200,
  /** Maximum length of `quality`. */
  maxQualityLength: 50,
  /** Maximum length of `language`. */
  maxLanguageLength: 20,
  /** Maximum length of a subtitle `format`. */
  maxSubtitleFormatLength: 30,
  /** Maximum length of a subtitle `name` (display label). */
  maxSubtitleNameLength: 100,
  /** Maximum number of subtitles per result. */
  maxSubtitles: 50,
  /**
   * Maximum number of playback headers per result (and per subtitle).
   * A count violation rejects the input; individually invalid header
   * entries are dropped (they are optional data).
   */
  maxHeaders: 16,
  /** Maximum length of a playback header NAME. */
  maxHeaderNameLength: 64,
  /** Maximum length of a playback header VALUE. */
  maxHeaderValueLength: 2_048,
  /** Maximum number of metadata keys per result. */
  maxMetadataKeys: 64,
  /** Maximum length of a metadata key. */
  maxMetadataKeyLength: 100,
  /** Maximum length of a string metadata value. */
  maxMetadataValueLength: 500,
  /** Maximum serialized (JSON) size of one metadata object, in bytes. */
  maxMetadataBytes: 8 * 1024,
} as const;

// ---------------------------------------------------------------------------
// Structured errors
// ---------------------------------------------------------------------------

export const RESULT_ERROR_CODES = [
  /** The input was not an object or an array of result objects. */
  "RESULT_INVALID_INPUT",
  /** A result object is malformed (missing/wrong-typed required field,
   * invalid enum, metadata shape problem). */
  "RESULT_INVALID",
  /** A URL is malformed or uses a non-http(s) protocol. */
  "RESULT_INVALID_URL",
  /** More results than RESULT_LIMITS.maxResults. */
  "RESULT_TOO_MANY_RESULTS",
  /** A string field or subtitle list exceeds its length/count limit. */
  "RESULT_FIELD_TOO_LONG",
  /** The metadata object exceeds its key-count or serialized-size limit. */
  "RESULT_METADATA_TOO_LARGE",
] as const;

export type ResultErrorCode = (typeof RESULT_ERROR_CODES)[number];

export interface ResultErrorObject {
  code: ResultErrorCode;
  message: string;
}

/** Internal pipeline error carrying a result code. */
class ResultError extends Error {
  constructor(
    readonly code: ResultErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ResultError";
  }
}

// ---------------------------------------------------------------------------
// Result model
// ---------------------------------------------------------------------------

/** The kinds of source results the engine normalizes. */
export const SOURCE_RESULT_TYPES = [
  "movie",
  "episode",
  "series",
  "search",
  "source",
] as const;

export type SourceResultType = (typeof SOURCE_RESULT_TYPES)[number];

/**
 * Media container/playlist formats a result URL can point at.
 *
 * Closed enum — this exists so an APPLICATION can route a result to the
 * right player (progressive file vs HLS vs DASH) without parsing URLs.
 * An unrecognised or missing value means "unknown to the engine" and the
 * field is simply dropped (the URL is still valid data).
 */
export const SOURCE_RESULT_FORMATS = [
  "mp4",
  "m3u8",
  "mpd",
  "mkv",
  "webm",
  "ts",
  "other",
] as const;

export type SourceResultFormat = (typeof SOURCE_RESULT_FORMATS)[number];

/**
 * Playback headers attached to a result or subtitle.
 *
 * IMPORTANT: unlike every other field in this model, these are NOT pure
 * data — an application hands them to a player/HTTP client. The engine
 * therefore validates them like request headers: token names, no CR/LF
 * or NUL in values, bounded count and length, and a denylist of
 * hop-by-hop / request-forging names (`host`, `connection`,
 * `content-length`, `transfer-encoding`, `upgrade`, `keep-alive`, `te`,
 * `trailer`, `proxy-connection`) that are dropped. The engine itself
 * never uses them (it never fetches result URLs).
 */
export type PlaybackHeaders = Record<string, string>;

/** A subtitle attached to a result (URL + optional tags). */
export interface SourceSubtitle {
  url: string;
  language?: string;
  format?: string;
  /** Display label shown in a subtitle picker (may be a non-ASCII name). */
  name?: string;
  /** Headers a player needs to FETCH the subtitle file. */
  headers?: PlaybackHeaders;
}

/**
 * A TRUSTED, normalized source result. Every field is JSON-serializable:
 * trimmed strings, canonical http(s) URLs, and a flat safe metadata map.
 * Unknown fields from the plugin output are dropped.
 */
export interface SourceResult {
  id: string;
  title: string;
  type: SourceResultType;
  /** Canonical absolute http(s) URL. Never fetched by the engine. */
  url: string;
  /** Origin name of the result (e.g. the site the plugin scraped). */
  source?: string;
  /** Canonical absolute http(s) thumbnail image URL. */
  thumbnail?: string;
  quality?: string;
  language?: string;
  /**
   * Container/playlist format hint for `url` (`mp4`, `m3u8`, `mpd`, …).
   * Lets an application pick a player without guessing from the URL.
   */
  format?: SourceResultFormat;
  /**
   * True when `url` is a continuous/live stream (a live HLS channel, a
   * sports feed), as opposed to a title that can be resumed, seeked and
   * cached. Lets an application skip resume-position bookkeeping, hide
   * download actions, and pick a live-aware player UI.
   *
   * Only a boolean is accepted; any other value is dropped, so a plugin
   * cannot smuggle a truthy object into a field an application branches
   * on. `false` is kept when a plugin states it explicitly, so an
   * application can tell "not live" from "unknown".
   */
  isLive?: boolean;
  /**
   * Headers an application needs to FETCH/PLAY `url` (typically
   * `Referer` and `User-Agent`). Validated like request headers — see
   * PlaybackHeaders. Never used by the engine.
   */
  headers?: PlaybackHeaders;
  subtitles?: SourceSubtitle[];
  /**
   * Flat metadata map. Keys and values are plain scalars
   * (string/number/boolean); `__proto__`/`constructor`/`prototype`
   * keys are rejected.
   */
  metadata: Record<string, string | number | boolean>;
}

/**
 * Validated (but not yet normalized) result — produced by validateItem.
 * Strings are trimmed and typed, URLs are parsed; normalization applies
 * the final canonical forms and drops invalid optional values.
 */
interface ValidatedSourceResult {
  id: string;
  title: string;
  type: SourceResultType;
  url: URL;
  source?: string;
  /** Canonical URL string (parsed + protocol-checked during validation). */
  thumbnail?: string;
  quality?: string;
  language?: string;
  format?: SourceResultFormat;
  isLive?: boolean;
  headers?: PlaybackHeaders;
  subtitles: SourceSubtitle[];
  metadata: Record<string, string | number | boolean>;
}

export type SourceResultValidationResult =
  | { ok: true; results: SourceResult[] }
  | { ok: false; error: ResultErrorObject };

// ---------------------------------------------------------------------------
// Small typed helpers (no `any`; every input is untrusted)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate one URL string and return its canonical form.
 * Throws ResultError(RESULT_INVALID_URL / RESULT_FIELD_TOO_LONG).
 */
function normalizeUrl(
  raw: string,
  field: string,
  at: string,
): string {
  const value = raw.trim();
  if (value.length === 0) {
    throw new ResultError(
      "RESULT_INVALID_URL",
      `${at}: field '${field}' must be a non-empty URL`,
    );
  }
  if (value.length > RESULT_LIMITS.maxUrlLength) {
    throw new ResultError(
      "RESULT_FIELD_TOO_LONG",
      `${at}: field '${field}' exceeds ${RESULT_LIMITS.maxUrlLength} characters`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ResultError(
      "RESULT_INVALID_URL",
      `${at}: field '${field}' is not a valid absolute URL`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ResultError(
      "RESULT_INVALID_URL",
      `${at}: field '${field}' uses unsupported protocol '${parsed.protocol}' (only http/https)`,
    );
  }
  if (parsed.hostname.length === 0) {
    throw new ResultError(
      "RESULT_INVALID_URL",
      `${at}: field '${field}' has no host`,
    );
  }
  return parsed.toString();
}

/**
 * Bounded, trimmed string for a REQUIRED string field.
 * Throws ResultError(RESULT_INVALID / RESULT_FIELD_TOO_LONG).
 */
function requiredString(
  item: Record<string, unknown>,
  field: string,
  max: number,
  at: string,
): string {
  const value = item[field];
  if (typeof value !== "string") {
    throw new ResultError(
      "RESULT_INVALID",
      `${at}: field '${field}' is required and must be a string`,
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ResultError(
      "RESULT_INVALID",
      `${at}: field '${field}' must not be empty`,
    );
  }
  if (trimmed.length > max) {
    throw new ResultError(
      "RESULT_FIELD_TOO_LONG",
      `${at}: field '${field}' exceeds ${max} characters`,
    );
  }
  return trimmed;
}

/**
 * Bounded, trimmed string for an OPTIONAL string field. Invalid or
 * empty values are DROPPED (undefined) instead of rejecting the result.
 */
function optionalString(
  item: Record<string, unknown>,
  field: string,
  max: number,
): string | undefined {
  const value = item[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

/**
 * OPTIONAL absolute http(s) URL field; invalid values are dropped.
 */
function optionalUrl(
  item: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = item[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > RESULT_LIMITS.maxUrlLength) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.hostname.length === 0
    ) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/** Header-name token characters (RFC 7230), same rule as src/http.ts. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Header names an application must not be told to send: hop-by-hop /
 * request-framing headers, plus `host` (which would let a plugin
 * redirect a player's connection to a different virtual host).
 * Matching is case-insensitive; offending entries are dropped.
 */
const FORBIDDEN_HEADER_NAMES = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "keep-alive",
  "te",
  "trailer",
  "proxy-connection",
]);

/**
 * Validate a playback-header map (result `headers` / subtitle `headers`).
 *
 * Optional field semantics, with one deliberate difference: because these
 * headers are consumed by a player rather than treated as inert data,
 * invalid ENTRIES are dropped but a COUNT violation rejects the input
 * (same rule the subtitle list uses). Prototype-polluting keys are
 * dropped, not copied.
 */
function playbackHeaders(
  value: unknown,
  at: string,
  field: string,
): PlaybackHeaders | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) return undefined; // wrong type → dropped

  const keys = Object.keys(value);
  if (keys.length > RESULT_LIMITS.maxHeaders) {
    throw new ResultError(
      "RESULT_FIELD_TOO_LONG",
      `${at}: '${field}' has ${keys.length} entries; the maximum is ${RESULT_LIMITS.maxHeaders}`,
    );
  }

  const headers: PlaybackHeaders = {};
  for (const key of keys) {
    const name = key.trim();
    if (
      name.length === 0 ||
      name.length > RESULT_LIMITS.maxHeaderNameLength ||
      !HEADER_NAME_RE.test(name)
    ) {
      continue; // invalid name → dropped
    }
    if (
      name === "__proto__" ||
      name === "constructor" ||
      name === "prototype" ||
      FORBIDDEN_HEADER_NAMES.has(name.toLowerCase())
    ) {
      continue; // unsafe name → dropped
    }
    const raw = value[key];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (
      trimmed.length === 0 ||
      trimmed.length > RESULT_LIMITS.maxHeaderValueLength ||
      // CR/LF/NUL would allow header injection downstream.
      /[\r\n\0]/.test(trimmed)
    ) {
      continue; // invalid value → dropped
    }
    headers[name] = trimmed;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** OPTIONAL closed-enum format field; unrecognised values are dropped. */
function optionalFormat(
  item: Record<string, unknown>,
  field: string,
): SourceResultFormat | undefined {
  const value = item[field];
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return (SOURCE_RESULT_FORMATS as readonly string[]).includes(normalized)
    ? (normalized as SourceResultFormat)
    : undefined;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate one raw result object into the intermediate validated shape.
 * All field errors are ResultError with the item's position in the
 * message. Prototype-pollution metadata keys are rejected.
 */
function validateItem(item: unknown, index: number): ValidatedSourceResult {
  const at = `result[${index}]`;
  if (!isPlainObject(item)) {
    throw new ResultError(
      "RESULT_INVALID_INPUT",
      `${at}: each result must be a plain object`,
    );
  }

  const id = requiredString(item, "id", RESULT_LIMITS.maxIdLength, at);
  const title = requiredString(
    item,
    "title",
    RESULT_LIMITS.maxTitleLength,
    at,
  );
  const type = item.type;
  if (
    typeof type !== "string" ||
    !(SOURCE_RESULT_TYPES as readonly string[]).includes(type)
  ) {
    throw new ResultError(
      "RESULT_INVALID",
      `${at}: field 'type' must be one of: ${SOURCE_RESULT_TYPES.join(", ")}`,
    );
  }
  const urlRaw = requiredString(item, "url", RESULT_LIMITS.maxUrlLength, at);
  const url = new URL(normalizeUrl(urlRaw, "url", at));

  // Playback metadata for the application's player: format hint and the
  // headers needed to fetch/play the URL. Optional; invalid entries are
  // dropped, a count violation rejects.
  const format = optionalFormat(item, "format");
  // Strict boolean: `"true"`, 1 and {} are all dropped rather than
  // coerced, because an application branches on this value. An explicit
  // `false` IS preserved, so "the plugin says: not live" stays
  // distinguishable from "the plugin did not say".
  const isLive = typeof item.isLive === "boolean" ? item.isLive : undefined;
  const headers = playbackHeaders(item.headers, at, "headers");

  // Subtitles: a bounded list; items with invalid URLs are dropped.
  const subtitles: SourceSubtitle[] = [];
  if (item.subtitles !== undefined && item.subtitles !== null) {
    if (!Array.isArray(item.subtitles)) {
      throw new ResultError(
        "RESULT_INVALID",
        `${at}: field 'subtitles' must be an array`,
      );
    }
    if (item.subtitles.length > RESULT_LIMITS.maxSubtitles) {
      throw new ResultError(
        "RESULT_FIELD_TOO_LONG",
        `${at}: 'subtitles' has ${item.subtitles.length} entries; the maximum is ${RESULT_LIMITS.maxSubtitles}`,
      );
    }
    for (let i = 0; i < item.subtitles.length; i++) {
      const rawSub = item.subtitles[i];
      if (!isPlainObject(rawSub)) continue; // drop non-object entries
      const subAt = `${at}.subtitles[${i}]`;
      const subUrlRaw = rawSub.url;
      if (typeof subUrlRaw !== "string") continue; // drop entries without a URL
      let subUrl: string;
      try {
        subUrl = normalizeUrl(subUrlRaw, "url", subAt);
      } catch {
        continue; // drop entries with invalid/oversized URLs
      }
      const sub: SourceSubtitle = { url: subUrl };
      const language = optionalString(rawSub, "language", RESULT_LIMITS.maxLanguageLength);
      if (language !== undefined) sub.language = language;
      const format = optionalString(rawSub, "format", RESULT_LIMITS.maxSubtitleFormatLength);
      if (format !== undefined) sub.format = format;
      const name = optionalString(rawSub, "name", RESULT_LIMITS.maxSubtitleNameLength);
      if (name !== undefined) sub.name = name;
      const subHeaders = playbackHeaders(rawSub.headers, subAt, "headers");
      if (subHeaders !== undefined) sub.headers = subHeaders;
      subtitles.push(sub);
    }
  }

  // Metadata: flat, bounded, prototype-pollution-safe.
  const metadata: Record<string, string | number | boolean> = {};
  if (item.metadata !== undefined && item.metadata !== null) {
    if (!isPlainObject(item.metadata)) {
      throw new ResultError(
        "RESULT_METADATA_TOO_LARGE",
        `${at}: field 'metadata' must be a plain object`,
      );
    }
    const keys = Object.keys(item.metadata);
    if (keys.length > RESULT_LIMITS.maxMetadataKeys) {
      throw new ResultError(
        "RESULT_METADATA_TOO_LARGE",
        `${at}: 'metadata' has ${keys.length} keys; the maximum is ${RESULT_LIMITS.maxMetadataKeys}`,
      );
    }
    for (const key of keys) {
      if (
        key === "__proto__" ||
        key === "constructor" ||
        key === "prototype"
      ) {
        throw new ResultError(
          "RESULT_INVALID",
          `${at}: 'metadata' key '${key}' is not allowed`,
        );
      }
      if (key.length === 0 || key.length > RESULT_LIMITS.maxMetadataKeyLength) {
        throw new ResultError(
          "RESULT_METADATA_TOO_LARGE",
          `${at}: 'metadata' key length is out of bounds`,
        );
      }
      const value = item.metadata[key];
      if (typeof value === "string") {
        if (value.length > RESULT_LIMITS.maxMetadataValueLength) {
          throw new ResultError(
            "RESULT_METADATA_TOO_LARGE",
            `${at}: 'metadata' value for '${key}' exceeds ${RESULT_LIMITS.maxMetadataValueLength} characters`,
          );
        }
        metadata[key] = value;
      } else if (isFiniteNumber(value)) {
        metadata[key] = value;
      } else if (typeof value === "boolean") {
        metadata[key] = value;
      } else {
        throw new ResultError(
          "RESULT_INVALID",
          `${at}: 'metadata' value for '${key}' must be a string, number, or boolean`,
        );
      }
    }
    // Serialized-size bound (checked after cleaning so the measured
    // size is the size that would actually be stored/serialized).
    if (JSON.stringify(metadata).length > RESULT_LIMITS.maxMetadataBytes) {
      throw new ResultError(
        "RESULT_METADATA_TOO_LARGE",
        `${at}: 'metadata' exceeds ${RESULT_LIMITS.maxMetadataBytes} bytes serialized`,
      );
    }
  }

  return {
    id,
    title,
    type: type as SourceResultType,
    url,
    source: optionalString(item, "source", RESULT_LIMITS.maxSourceLength),
    thumbnail: optionalUrl(item, "thumbnail"),
    quality: optionalString(item, "quality", RESULT_LIMITS.maxQualityLength),
    language: optionalString(item, "language", RESULT_LIMITS.maxLanguageLength),
    format,
    isLive,
    headers,
    subtitles,
    metadata,
  };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Convert a validated result into the final trusted shape. */
function toNormalized(validated: ValidatedSourceResult): SourceResult {
  const result: SourceResult = {
    id: validated.id,
    title: validated.title,
    type: validated.type,
    url: validated.url.toString(),
    metadata: { ...validated.metadata },
  };
  if (validated.source !== undefined) result.source = validated.source;
  if (validated.thumbnail !== undefined) result.thumbnail = validated.thumbnail;
  if (validated.quality !== undefined) result.quality = validated.quality;
  if (validated.language !== undefined) result.language = validated.language;
  if (validated.format !== undefined) result.format = validated.format;
  if (validated.isLive !== undefined) result.isLive = validated.isLive;
  if (validated.headers !== undefined) result.headers = { ...validated.headers };
  if (validated.subtitles.length > 0) result.subtitles = validated.subtitles;
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate + normalize raw plugin output into trusted source results.
 *
 * `raw` is the plugin capability's return value (already JSON-dumped by
 * the runtime, hence untrusted plain data — but this API also defends
 * against arbitrary host values: every field is strictly type-checked).
 *
 * Accepts a single result object or an array of them. Duplicate `id`s
 * keep the FIRST occurrence. All-or-nothing: any required-field or
 * size violation rejects the whole input with a structured error.
 *
 * Result URLs are data only — the engine never fetches or verifies them.
 */
export function normalizeSourceResults(
  raw: unknown,
): SourceResultValidationResult {
  try {
    let items: unknown[];
    if (Array.isArray(raw)) {
      items = raw;
    } else if (isPlainObject(raw)) {
      items = [raw];
    } else {
      throw new ResultError(
        "RESULT_INVALID_INPUT",
        "expected a source result object or an array of them",
      );
    }

    if (items.length > RESULT_LIMITS.maxResults) {
      throw new ResultError(
        "RESULT_TOO_MANY_RESULTS",
        `received ${items.length} results; the maximum is ${RESULT_LIMITS.maxResults}`,
      );
    }

    const results: SourceResult[] = [];
    const seenIds = new Set<string>();
    for (let i = 0; i < items.length; i++) {
      const validated = validateItem(items[i], i);
      // Duplicate IDs: keep the first occurrence, drop the rest.
      if (seenIds.has(validated.id)) continue;
      seenIds.add(validated.id);
      results.push(toNormalized(validated));
    }
    return { ok: true, results };
  } catch (error) {
    if (error instanceof ResultError) {
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    // Unexpected host error: map to a fixed safe message (no host
    // details leak to callers).
    return {
      ok: false,
      error: {
        code: "RESULT_INVALID",
        message: "result validation failed",
      },
    };
  }
}
