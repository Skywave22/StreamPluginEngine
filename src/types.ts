/**
 * Core types for plugin manifests, plugins, and validation results.
 *
 * Phase 4: these types describe plugin metadata, the sandboxed execution
 * result types, and the controlled HTTP capability contract. Plugin code
 * executes inside a QuickJS (Wasm) runtime with a controlled API — see
 * src/runtime.ts and src/http.ts.
 */
import type {
  HttpLimits,
  HttpRequestOptions,
  HttpResponse,
} from "./http.js";

/**
 * A plugin manifest as declared in `<plugin dir>/manifest.json`.
 *
 * Required: id, name, version, entry.
 * Optional: author, description, domains.
 * Unknown fields are rejected by the validator.
 */
export interface PluginManifest {
  /**
   * Unique plugin ID. Predictable safe format: lowercase letters, digits,
   * and hyphens separated by dots, e.g. "example.source".
   */
  id: string;
  /** Human-readable plugin name. */
  name: string;
  /** Semantic version, e.g. "1.0.0". */
  version: string;
  /**
   * Entry file relative to the plugin directory, using forward slashes.
   * Must not be an absolute path and must not contain ".." segments.
   */
  entry: string;
  /** Optional plugin author. */
  author?: string;
  /** Optional short description. */
  description?: string;
  /** Optional list of domains this plugin interacts with. */
  domains?: string[];
}

/**
 * Result of manifest validation. On success the validated manifest is
 * returned; on failure all human-readable errors are collected.
 */
export type ManifestValidationResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: string[] };

/**
 * Lifecycle status of a plugin as tracked by the engine.
 * - "discovered" — found during a scan (transient before loading)
 * - "loaded" — manifest validated, metadata ready for the runtime
 * - "invalid" — manifest failed validation
 * - "failed" — could not be loaded (missing/corrupt manifest, unsafe or
 *   missing entry file, duplicate ID)
 */
export type PluginStatus = "discovered" | "loaded" | "invalid" | "failed";

/**
 * Internal plugin representation. Holds metadata only; execution state
 * lives in the PluginRuntime's loaded-plugin handles.
 */
export interface Plugin {
  /** Absolute path of the plugin directory (contains manifest.json). */
  pluginPath: string;
  /** Validated manifest; present when status is "loaded". */
  manifest?: PluginManifest;
  /**
   * Absolute path of the entry file, resolved and confined to the plugin
   * directory. Present when status is "loaded".
   */
  entryPath?: string;
  status: PluginStatus;
  /** Errors; present when status is "invalid" or "failed". */
  errors?: string[];
}

/**
 * Well-known capability names the future application is expected to call.
 * Plugins may expose any function names; these are the planned standard set.
 */
export const KNOWN_CAPABILITIES = [
  "search",
  "getDetails",
  "getEpisodes",
  "getSources",
] as const;

export type KnownCapability = (typeof KNOWN_CAPABILITIES)[number];

/**
 * Controlled HTTP surface exposed to plugins as `context.http`.
 *
 * All methods return promises. Failures REJECT with a structured error
 * object `{ code: HttpErrorCode, message: string }` — catch it in the
 * plugin. Non-2xx status codes (404, 500, ...) are NOT errors: they
 * resolve normally so the plugin can inspect status and body.
 *
 * The plugin performs networking ONLY through this surface; there is no
 * direct access to Node networking, sockets, or an unrestricted fetch.
 */
export interface PluginHttp {
  /**
   * GET `url` with optional controlled options.
   * Rejects with `{ code, message }` on transport-level failure.
   */
  get(url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
  /**
   * GET `url` and parse the body as JSON. Rejects with
   * `{ code: "HTTP_INVALID_JSON", message }` when the body is not valid
   * JSON (in addition to the regular transport error codes).
   */
  getJson<T = unknown>(url: string, options?: HttpRequestOptions): Promise<T>;
  /**
   * Perform a GET or POST request described by `options` (which must
   * include `url`). POST supports a string `body`.
   */
  request(options: HttpRequestOptions & { url: string }): Promise<HttpResponse>;
}

/**
 * Controlled context handed to plugin capability functions as the LAST
 * argument. This is the only surface through which a plugin talks to the
 * host. Do not add APIs here without a clear future need.
 */
export interface PluginContext {
  /** Read-only copy of this plugin's manifest. */
  readonly manifest: PluginManifest;
  /** Route a log line through the host logger. */
  log(...args: unknown[]): void;
  /**
   * Engine-controlled HTTP capability (Phase 4). Every request is
   * validated and bounded by the engine (scheme, timeout, size,
   * redirects, headers) — see src/http.ts for the limits.
   */
  readonly http: PluginHttp;
}

/** Structured runtime error types returned by the PluginRuntime. */
export type PluginRuntimeErrorType =
  /** Entry file missing/unreadable or module failed to evaluate. */
  | "PLUGIN_LOAD_ERROR"
  /** The module's exports do not follow the plugin contract. */
  | "PLUGIN_EXPORT_ERROR"
  /** A capability threw, or the plugin used an unavailable API. */
  | "PLUGIN_RUNTIME_ERROR"
  /** Execution exceeded the configured time limit. */
  | "PLUGIN_TIMEOUT"
  /** The plugin exceeded the configured memory limit. */
  | "PLUGIN_MEMORY_LIMIT"
  /** The requested capability is not exposed by the plugin. */
  | "PLUGIN_CAPABILITY_NOT_FOUND";

export interface PluginRuntimeError {
  type: PluginRuntimeErrorType;
  /** Human-readable message. Guest code may be quoted; host internals are not. */
  message: string;
}

/**
 * Consistent result of executing a plugin capability.
 * `value` is JSON-serializable (converted via the runtime's dump).
 * Times are actually measured with the host clock — never fabricated.
 */
export type PluginExecutionResult =
  | { success: true; value: unknown; executionTimeMs: number }
  | { success: false; error: PluginRuntimeError; executionTimeMs: number };

/** Result of loading a plugin into the runtime. */
export type PluginLoadResult =
  | { ok: true; plugin: LoadedPlugin; loadTimeMs: number }
  | { ok: false; error: PluginRuntimeError; loadTimeMs: number };

/**
 * A plugin whose entry module has been evaluated inside an isolated
 * QuickJS runtime. Capabilities are detected but not yet executed.
 */
export interface LoadedPlugin {
  readonly pluginId: string;
  readonly manifest: PluginManifest;
  /** Names of the function capabilities detected on the `plugin` export. */
  readonly capabilities: readonly string[];
}

export interface PluginRuntimeOptions {
  /** Per-operation execution limit in milliseconds (default 5000). */
  timeoutMs?: number;
  /** Guest heap limit per plugin, in bytes (default 64 MiB). */
  memoryLimitBytes?: number;
  /** Receives plugin log lines (default: console with a plugin prefix). */
  logger?: (pluginId: string, message: string) => void;
  /**
   * Engine-level limits for the controlled HTTP capability. Values here
   * are ENGINE maximums: plugin-supplied request options are clamped to
   * them and can never raise them. See DEFAULT_HTTP_LIMITS in
   * src/http.ts for the built-in defaults.
   */
  http?: {
    limits?: Partial<HttpLimits>;
  };
}
