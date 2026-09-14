/**
 * StreamPluginEngine — entry point.
 *
 * Phase 4: plugin manifest, validation, loading, the plugin manager, the
 * sandboxed PluginRuntime (QuickJS/Wasm), and the controlled HTTP
 * capability are implemented. Plugins execute inside an isolated JS
 * engine with a controlled context (manifest + log + http) — no
 * Node.js globals, no host files, and no direct network access: all
 * HTTP traffic goes through the engine-validated context.http.
 * See ARCHITECTURE.md for the planned design and README.md for status.
 */

/** Stable engine name, usable by future manifests and API surfaces. */
export const ENGINE_NAME = "stream-plugin-engine";

/** Current engine version (semver). */
export const ENGINE_VERSION = "0.1.0";

/** Project phase this codebase is in. */
export const ENGINE_PHASE = 4 as const;

export { validateManifest } from "./manifest.js";
export { MANIFEST_FILE_NAME, PluginLoader } from "./loader.js";
export { PluginManager } from "./manager.js";
export { PluginRuntime } from "./runtime.js";
export {
  DEFAULT_HTTP_LIMITS,
  HTTP_ERROR_CODES,
  HttpClient,
  HttpError,
} from "./http.js";
export type {
  HttpClientOptions,
  HttpErrorObject,
  HttpErrorCode,
  HttpLimits,
  HttpMethod,
  HttpRequestOptions,
  HttpResponse,
} from "./http.js";
export type {
  KnownCapability,
  ManifestValidationResult,
  Plugin,
  PluginContext,
  PluginExecutionResult,
  PluginHttp,
  PluginLoadResult,
  PluginManifest,
  PluginRuntimeError,
  PluginRuntimeErrorType,
  PluginRuntimeOptions,
  PluginStatus,
} from "./types.js";
export { KNOWN_CAPABILITIES } from "./types.js";
export type { LoadedPlugin } from "./types.js";
