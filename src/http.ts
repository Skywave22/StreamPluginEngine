/**
 * Controlled HTTP client for plugins (host side).
 *
 * This module performs the actual network I/O on the HOST. It has no
 * dependency on QuickJS: the sandboxed runtime hands it validated request
 * descriptions and receives validated, JSON-serializable results (or
 * structured HttpError values).
 *
 * The plugin never receives Node's http/https/net/tls modules, sockets,
 * streams, or an unrestricted fetch — only the normalized HttpResponse
 * object defined here.
 *
 * Security properties:
 * - Only http: and https: URLs are allowed (file:, data:, javascript:,
 *   node:, ... are rejected before any I/O).
 * - Every request has a bounded timeout (plugin value clamped to the
 *   engine maximum).
 * - Response size is bounded and enforced while streaming; oversized
 *   bodies are aborted and never passed to the plugin.
 * - Redirects are followed manually, re-validated against the same URL
 *   policy on every hop, and capped.
 * - Request headers are validated (name/value format, count, length).
 * - The engine sets a default User-Agent; it never injects host
 *   credentials or environment data.
 */

export type HttpMethod = "GET" | "POST";

export interface HttpRequestOptions {
  /**
   * Absolute http(s) URL. Required for `request(options)`; ignored (and
   * rejected if present) by `get(url, options)` / `getJson(url, options)`,
   * which take the URL as their first argument.
   */
  url?: string;
  /** HTTP method. Only GET and POST are supported in Phase 4. */
  method?: HttpMethod;
  /** Request headers (string -> string). Validated by the engine. */
  headers?: Record<string, string>;
  /** Request body (string only). For JSON, pass JSON.stringify(value). */
  body?: string;
  /** Request timeout in milliseconds, clamped to the engine maximum. */
  timeoutMs?: number;
  /** Maximum response size in bytes, clamped to the engine maximum. */
  maxResponseBytes?: number;
  /** Maximum number of redirects to follow, clamped to the engine maximum. */
  maxRedirects?: number;
}

/** Normalized, JSON-serializable HTTP response handed back to the plugin. */
export interface HttpResponse {
  status: number;
  statusText: string;
  /** Response headers (multi-value headers are joined with ", "). */
  headers: Record<string, string>;
  /** Final URL after any redirects. */
  url: string;
  /** Response body, decoded as UTF-8, within the size limit. */
  body: string;
}

export const HTTP_ERROR_CODES = [
  "HTTP_INVALID_URL",
  "HTTP_UNSUPPORTED_SCHEME",
  "HTTP_TIMEOUT",
  "HTTP_ABORTED",
  "HTTP_NETWORK_ERROR",
  "HTTP_RESPONSE_TOO_LARGE",
  "HTTP_TOO_MANY_REDIRECTS",
  "HTTP_INVALID_REQUEST",
  "HTTP_INTERNAL_ERROR",
  "HTTP_INVALID_JSON",
] as const;

export type HttpErrorCode = (typeof HTTP_ERROR_CODES)[number];

/** Structured HTTP error. Serializable; safe to hand to a plugin. */
export interface HttpErrorObject {
  code: HttpErrorCode;
  message: string;
}

/** Host-side structured HTTP error (never thrown into QuickJS directly). */
export class HttpError extends Error {
  readonly code: HttpErrorCode;

  constructor(code: HttpErrorCode, message: string) {
    super(message);
    this.name = "HttpError";
    this.code = code;
  }
}

/**
 * Engine-level HTTP safety limits. Plugin-supplied values are clamped to
 * these; plugins can never raise them.
 */
export interface HttpLimits {
  /** Per-request timeout used when the plugin does not specify one (ms). */
  defaultTimeoutMs: number;
  /** Hard maximum per-request timeout (ms). */
  maxTimeoutMs: number;
  /** Max response size used when the plugin does not specify one (bytes). */
  defaultMaxResponseBytes: number;
  /** Hard maximum response size (bytes). */
  maxResponseBytesCap: number;
  /** Redirects followed when the plugin does not specify a limit. */
  defaultMaxRedirects: number;
  /** Hard maximum number of redirects. */
  maxRedirectsCap: number;
  /** Maximum URL length (characters). */
  maxUrlLength: number;
  /** Maximum number of request headers. */
  maxHeaders: number;
  /** Maximum header name length (characters). */
  maxHeaderNameLength: number;
  /** Maximum header value length (characters). */
  maxHeaderValueLength: number;
  /** Maximum request body size (bytes). */
  maxRequestBodyBytes: number;
}

export const DEFAULT_HTTP_LIMITS: HttpLimits = {
  defaultTimeoutMs: 10_000,
  maxTimeoutMs: 30_000,
  defaultMaxResponseBytes: 5 * 1024 * 1024, // 5 MiB
  maxResponseBytesCap: 10 * 1024 * 1024, // 10 MiB
  defaultMaxRedirects: 5,
  maxRedirectsCap: 10,
  maxUrlLength: 4096,
  maxHeaders: 64,
  maxHeaderNameLength: 64,
  maxHeaderValueLength: 8192,
  maxRequestBodyBytes: 1024 * 1024, // 1 MiB
};

export interface HttpClientOptions {
  /** Override individual engine limits (all optional). */
  limits?: Partial<HttpLimits>;
}

interface EffectiveRequest {
  method: HttpMethod;
  headers: Record<string, string>;
  body: string | undefined;
  timeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
}

/** Why the request's AbortController was fired (null = still running). */
interface AbortState {
  reason: "timeout" | "too-large" | "external" | null;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// RFC 7230 "token" characters (no space, no comma).
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Host-side HTTP client used by the sandboxed runtime.
 *
 * `request()` performs one bounded HTTP exchange (including any redirect
 * hops) and returns a normalized response. All failures are thrown as
 * HttpError with a stable `code`; no host stack traces or objects are
 * part of the error.
 */
export class HttpClient {
  /** The effective engine limits (documented defaults + overrides). */
  readonly limits: HttpLimits;

  constructor(options: HttpClientOptions = {}) {
    this.limits = { ...DEFAULT_HTTP_LIMITS, ...options.limits };
  }

  /**
   * Perform an HTTP request.
   *
   * @param url Absolute http(s) URL.
   * @param options Controlled request options (all optional).
   * @param externalSignal Optional engine-side cancellation (e.g. the
   *   plugin's operation ending). Aborts map to HTTP_ABORTED.
   */
  async request(
    url: string,
    options: HttpRequestOptions = {},
    externalSignal?: AbortSignal,
  ): Promise<HttpResponse> {
    const effective = this.resolveOptions(options);
    const startUrl = validateUrl(url, this.limits.maxUrlLength);
    const controller = new AbortController();
    const state: AbortState = { reason: null };

    const deadlineAt = Date.now() + effective.timeoutMs;
    const timer = setTimeout(() => {
      state.reason = "timeout";
      controller.abort();
    }, effective.timeoutMs);
    // The timer is ref'd on purpose: this method is awaited from the
    // runtime while a plugin operation is in flight; the runtime's own
    // deadline timer keeps the process alive. We still clear this timer
    // in `finally` so completed requests never delay shutdown.
    const onExternalAbort = () => {
      state.reason = "external";
      controller.abort();
    };
    if (externalSignal) {
      if (externalSignal.aborted) {
        onExternalAbort();
      } else {
        externalSignal.addEventListener("abort", onExternalAbort, {
          once: true,
        });
      }
    }

    let method: HttpMethod = effective.method;
    let body: string | undefined = effective.body;
    let currentUrl: URL = startUrl;
    let redirects = 0;

    try {
      for (;;) {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          throw new HttpError(
            "HTTP_TIMEOUT",
            `HTTP request timed out after ${effective.timeoutMs} ms`,
          );
        }

        let response: Response;
        try {
          response = await fetch(currentUrl, {
            method,
            headers: effective.headers,
            body: method === "POST" ? body : undefined,
            redirect: "manual",
            signal: controller.signal,
          });
        } catch (error) {
          throw this.mapFetchError(error, effective.timeoutMs, state.reason);
        }

        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.get("location");
          const headers = collectHeaders(response.headers);
          await discardResponseBody(response);
          if (location === null) {
            // A redirect without a Location header is terminal.
            return {
              status: response.status,
              statusText: response.statusText,
              headers,
              url: currentUrl.toString(),
              body: "",
            };
          }
          redirects += 1;
          if (redirects > effective.maxRedirects) {
            throw new HttpError(
              "HTTP_TOO_MANY_REDIRECTS",
              `HTTP request exceeded the maximum of ${effective.maxRedirects} redirects`,
            );
          }
          // 301/302/303 switch to a body-less GET; 307/308 preserve the
          // method and body.
          if (response.status === 301 || response.status === 302 || response.status === 303) {
            method = "GET";
            body = undefined;
          }
          // Re-validate every hop with the same policy so a redirect can
          // never escape to a disallowed scheme or URL.
          currentUrl = validateUrl(new URL(location, currentUrl).toString(), this.limits.maxUrlLength);
          continue;
        }

        return await readBoundedResponse(
          response,
          currentUrl,
          effective,
          controller,
          state,
        );
      }
    } finally {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  // ------------------------------------------------------------------

  private resolveOptions(options: HttpRequestOptions): EffectiveRequest {
    const { limits } = this;

    const method = options.method ?? "GET";
    if (method !== "GET" && method !== "POST") {
      throw new HttpError(
        "HTTP_INVALID_REQUEST",
        `Unsupported HTTP method '${String(method)}'; only GET and POST are supported`,
      );
    }

    let headers: Record<string, string> = {};
    if (options.headers !== undefined) {
      if (typeof options.headers !== "object" || options.headers === null || Array.isArray(options.headers)) {
        throw new HttpError("HTTP_INVALID_REQUEST", "Request headers must be an object of string values");
      }
      headers = validateHeaders(options.headers, limits);
    }
    // Engine-controlled default; a plugin-provided user-agent (any case) wins.
    const hasUserAgent = Object.keys(headers).some((k) => k.toLowerCase() === "user-agent");
    if (!hasUserAgent) {
      headers = { ...headers, "user-agent": "StreamPluginEngine/0.1 (plugin-http)" };
    }

    let body: string | undefined;
    if (options.body !== undefined) {
      if (typeof options.body !== "string") {
        throw new HttpError(
          "HTTP_INVALID_REQUEST",
          "Request body must be a string (use JSON.stringify for JSON payloads)",
        );
      }
      if (Buffer.byteLength(options.body, "utf8") > limits.maxRequestBodyBytes) {
        throw new HttpError(
          "HTTP_INVALID_REQUEST",
          `Request body exceeds the maximum of ${limits.maxRequestBodyBytes} bytes`,
        );
      }
      body = options.body;
    }

    return {
      method,
      headers,
      body,
      timeoutMs: clampPositive(options.timeoutMs, limits.defaultTimeoutMs, limits.maxTimeoutMs, "timeoutMs"),
      maxResponseBytes: clampPositive(
        options.maxResponseBytes,
        limits.defaultMaxResponseBytes,
        limits.maxResponseBytesCap,
        "maxResponseBytes",
      ),
      maxRedirects: clampNonNegative(options.maxRedirects, limits.defaultMaxRedirects, limits.maxRedirectsCap, "maxRedirects"),
    };
  }

  private mapFetchError(
    error: unknown,
    timeoutMs: number,
    abortReason: "timeout" | "too-large" | "external" | null,
  ): HttpError {
    if (abortReason === "timeout") {
      return new HttpError("HTTP_TIMEOUT", `HTTP request timed out after ${timeoutMs} ms`);
    }
    if (abortReason === "external") {
      return new HttpError("HTTP_ABORTED", "HTTP request was aborted by the engine");
    }
    // fetch wraps network failures in TypeError("fetch failed"); the
    // useful detail (if any) is on `cause`. We surface only a short,
    // non-sensitive code (e.g. ECONNREFUSED) — never host paths/stacks.
    const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
    const code = cause && typeof cause.code === "string" ? cause.code : undefined;
    return new HttpError(
      "HTTP_NETWORK_ERROR",
      code ? `Network request failed (${code})` : "Network request failed",
    );
  }
}

function validateUrl(raw: unknown, maxUrlLength: number): URL {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new HttpError("HTTP_INVALID_URL", "URL must be a non-empty string");
  }
  if (raw.length > maxUrlLength) {
    throw new HttpError("HTTP_INVALID_URL", `URL exceeds the maximum of ${maxUrlLength} characters`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HttpError("HTTP_INVALID_URL", `Invalid or relative URL: '${truncate(raw)}'`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(
      "HTTP_UNSUPPORTED_SCHEME",
      `Unsupported URL scheme '${parsed.protocol}'; only http: and https: are allowed`,
    );
  }
  return parsed;
}

function validateHeaders(
  headers: Record<string, string>,
  limits: HttpLimits,
): Record<string, string> {
  const result: Record<string, string> = {};
  let count = 0;
  for (const [name, value] of Object.entries(headers)) {
    count += 1;
    if (count > limits.maxHeaders) {
      throw new HttpError(
        "HTTP_INVALID_REQUEST",
        `Too many request headers (maximum ${limits.maxHeaders})`,
      );
    }
    if (name.length === 0 || name.length > limits.maxHeaderNameLength || !HEADER_NAME_RE.test(name)) {
      throw new HttpError(
        "HTTP_INVALID_REQUEST",
        `Invalid header name '${truncate(name)}'`,
      );
    }
    if (typeof value !== "string") {
      throw new HttpError("HTTP_INVALID_REQUEST", `Header '${name}' must have a string value`);
    }
    if (value.length > limits.maxHeaderValueLength) {
      throw new HttpError(
        "HTTP_INVALID_REQUEST",
        `Header '${name}' exceeds the maximum of ${limits.maxHeaderValueLength} characters`,
      );
    }
    if (value.includes("\r") || value.includes("\n") || value.includes("\0")) {
      throw new HttpError("HTTP_INVALID_REQUEST", `Header '${name}' contains illegal characters`);
    }
    // First occurrence wins for duplicate (case-insensitive) names.
    const lower = name.toLowerCase();
    if (!Object.keys(result).some((k) => k.toLowerCase() === lower)) {
      result[name] = value;
    }
  }
  return result;
}

function clampPositive(
  value: number | undefined,
  fallback: number,
  cap: number,
  field: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new HttpError("HTTP_INVALID_REQUEST", `Option '${field}' must be a positive number`);
  }
  return Math.min(Math.floor(value), cap);
}

function clampNonNegative(
  value: number | undefined,
  fallback: number,
  cap: number,
  field: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new HttpError("HTTP_INVALID_REQUEST", `Option '${field}' must be a non-negative number`);
  }
  return Math.min(Math.floor(value), cap);
}

async function readBoundedResponse(
  response: Response,
  finalUrl: URL,
  effective: EffectiveRequest,
  controller: AbortController,
  state: AbortState,
): Promise<HttpResponse> {
  const maxResponseBytes = effective.maxResponseBytes;

  // Fast path: a declared Content-Length above the limit fails immediately.
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxResponseBytes) {
    await discardResponseBody(response);
    throw new HttpError(
      "HTTP_RESPONSE_TOO_LARGE",
      `HTTP response exceeds the maximum of ${maxResponseBytes} bytes`,
    );
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  let readError: unknown = null;

  if (response.body !== null) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        total += value.byteLength;
        if (total > maxResponseBytes) {
          // Stop immediately: abort the request and never pass the
          // oversized body anywhere.
          overflow = true;
          state.reason = "too-large";
          controller.abort();
          break;
        }
        chunks.push(value);
      }
    } catch (error) {
      readError = error;
    }
  }

  if (overflow || state.reason === "too-large") {
    throw new HttpError(
      "HTTP_RESPONSE_TOO_LARGE",
      `HTTP response exceeds the maximum of ${maxResponseBytes} bytes`,
    );
  }
  if (state.reason === "timeout") {
    throw new HttpError("HTTP_TIMEOUT", `HTTP request timed out after ${effective.timeoutMs} ms`);
  }
  if (state.reason === "external") {
    throw new HttpError("HTTP_ABORTED", "HTTP request was aborted by the engine");
  }
  if (readError !== null) {
    const cause = (readError as { cause?: { code?: unknown } } | null)?.cause;
    const code = cause && typeof cause.code === "string" ? cause.code : undefined;
    throw new HttpError(
      "HTTP_NETWORK_ERROR",
      code ? `Network request failed while reading the response (${code})` : "Network request failed while reading the response",
    );
  }

  const body = Buffer.concat(chunks, total).toString("utf8");

  return {
    status: response.status,
    statusText: response.statusText,
    headers: collectHeaders(response.headers),
    url: finalUrl.toString(),
    body,
  };
}

function collectHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = key in result ? `${result[key]}, ${value}` : value;
  });
  return result;
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already closed/aborted — nothing to do.
  }
}

function truncate(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
