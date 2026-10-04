/**
 * Core types for plugin manifests, plugins, and validation results.
 *
 * Phase 5: these types describe plugin metadata, the sandboxed execution
 * result types, the controlled HTTP capability contract (Phase 4), and
 * the JSON/HTML parsing capability contract (Phase 5). Plugin code
 * executes inside a QuickJS (Wasm) runtime with a controlled API — see
 * src/runtime.ts, src/http.ts, and src/phase5.ts.
 */
import type {
  HttpLimits,
  HttpRequestOptions,
  HttpResponse,
} from "./http.js";
import type { AddressResolver, NetworkPolicy } from "./network.js";
import type { PluginHtml, PluginJson } from "./phase5-types.js";

/**
 * A plugin manifest as declared in `<plugin dir>/manifest.json`.
 *
 * Required: id, name, version, entry.
 * Optional: author, description, domains, apiVersion.
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
  /**
   * Optional list of domains this plugin interacts with.
   *
   * Since v0.2.0 this declaration is ENFORCED, not documentation: when a
   * plugin declares one or more domains, its `context.http` requests —
   * including every redirect hop — are limited to those hosts and
   * anything else fails with `HTTP_DOMAIN_NOT_ALLOWED` before any I/O
   * (see src/network.ts for the matching semantics). Declaring no
   * domains leaves the plugin unrestricted by this gate (the engine
   * network policy still applies). Host applications can turn
   * enforcement off with `{ http: { enforceManifestDomains: false } }`.
   */
  domains?: string[];
  /**
   * Optional plugin API version this plugin was written against.
   * Defaults to 1 when absent. A manifest requiring a NEWER API version
   * than the engine implements is rejected at validation time rather
   * than failing mysteriously at runtime.
   */
  apiVersion?: number;
}

/**
 * Per-plugin capability permissions.
 *
 * Every capability defaults to ENABLED, so existing plugins are
 * unaffected. A host application can turn individual capabilities off —
 * globally (`permissions`) or per plugin (`perPluginPermissions`) — and
 * a disabled capability is simply ABSENT from the plugin's context
 * object. The plugin cannot detect or re-enable it, and the engine
 * exposes no API for a guest to request it.
 *
 * `http: false` removes the plugin's entire network surface (making it
 * pure computation over its arguments), which is the strongest
 * restriction the engine currently offers.
 */
export interface PluginPermissions {
  /** `context.http` — the controlled network capability. Default true. */
  http?: boolean;
  /** `context.json` — bounded JSON parsing/serialization. Default true. */
  json?: boolean;
  /** `context.html` — data-only HTML parsing/selection. Default true. */
  html?: boolean;
}

/** A permission set with every capability resolved to a boolean. */
export type ResolvedPluginPermissions = Required<PluginPermissions>;

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
  /**
   * Whether the plugin is enabled in the engine's registry. Defaults to
   * true when absent, so callers that build a Plugin by hand keep
   * working. `PluginManager#setEnabled` is the engine-owned switch, and
   * the runtime refuses to load a plugin that carries `enabled: false`.
   */
  enabled?: boolean;
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
  /**
   * Bounded JSON parsing/serialization (Phase 5). Synchronous; throws
   * structured { code, message } errors. Parsing is a pure data
   * operation and never evaluates code.
   */
  readonly json: PluginJson;
  /**
   * Data-only HTML parsing, CSS selection, and element extraction
   * (Phase 5). No script/event-handler execution, no resource loading,
   * bounded input/node/result limits, structured errors.
   */
  readonly html: PluginHtml;
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
  | "PLUGIN_CAPABILITY_NOT_FOUND"
  /** The plugin is disabled in the engine registry and will not be loaded. */
  | "PLUGIN_DISABLED";

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
  /**
   * The capabilities this plugin actually received (host decision, see
   * PluginPermissions). Useful for application-side introspection and
   * audit: it is never influenced by guest code.
   */
  readonly permissions: ResolvedPluginPermissions;
  /**
   * The enforced declared-domain allowlist for this plugin (empty =
   * unrestricted by this gate). Derived from the validated manifest.
   */
  readonly allowedDomains: readonly string[];
}

export interface PluginRuntimeOptions {
  /** Per-operation execution limit in milliseconds (default 5000). */
  timeoutMs?: number;
  /** Guest heap limit per plugin, in bytes (default 64 MiB). */
  memoryLimitBytes?: number;
  /** Receives plugin log lines (default: console with a plugin prefix). */
  logger?: (pluginId: string, message: string) => void;
  /**
   * Default capability permissions for every plugin loaded by this
   * runtime. Per-plugin entries in `perPluginPermissions` override these.
   */
  permissions?: PluginPermissions;
  /**
   * Capability permissions for specific plugin IDs, overriding
   * `permissions`. Example:
   * `{ "untrusted.scraper": { http: false } }`.
   */
  perPluginPermissions?: Readonly<Record<string, PluginPermissions>>;
  /**
   * Engine-level limits for the controlled HTTP capability. Values here
   * are ENGINE maximums: plugin-supplied request options are clamped to
   * them and can never raise them. See DEFAULT_HTTP_LIMITS in
   * src/http.ts for the built-in defaults.
   */
  http?: {
    limits?: Partial<HttpLimits>;
    /**
     * Engine network policy for the controlled HTTP capability: which
     * addresses a plugin may reach. Defaults to
     * `DEFAULT_NETWORK_POLICY` — public internet only, so loopback,
     * RFC 1918, link-local (including cloud metadata endpoints), and
     * other reserved ranges are rejected with `HTTP_FORBIDDEN_TARGET`.
     *
     * Set `{ allowPrivateNetwork: true }` to permit those targets. That
     * is a HOST decision (local development, or the deterministic test
     * suite serving fixtures from a local server); a plugin can never
     * influence it.
     */
    network?: Partial<NetworkPolicy>;
    /**
     * DNS resolver used for hostname policy checks. Injectable so tests
     * stay offline and deterministic.
     */
    resolver?: AddressResolver;
    /**
     * Enforce a plugin's manifest `domains` as an HTTP allowlist.
     * Default true: a plugin that declares domains can only reach them.
     * Set false to restore the pre-0.2.0 behaviour where `domains` was
     * informational only. A plugin with NO declared domains is
     * unrestricted either way.
     */
    enforceManifestDomains?: boolean;
    /**
     * Extra domains EVERY plugin may reach, on top of its own declared
     * domains. This is a HOST decision — e.g. a shared CDN or a fixture
     * host used by the test suite. It never applies when
     * `enforceManifestDomains` is false (that setting removes the
     * allowlist gate entirely) and it cannot be influenced by a plugin.
     */
    extraAllowedDomains?: readonly string[];
  };
}
