/**
 * StreamPluginEngine — entry point.
 *
 * Phase 5: plugin manifest, validation, loading, the sandboxed PluginRuntime
 * (QuickJS/Wasm), controlled HTTP, and HTML/JSON parsing capabilities.
 * Plugins execute inside an isolated JS engine with a controlled context.
 * Network access is only available through context.http; HTML parsing never
 * executes JavaScript or fetches linked resources.
 * See ARCHITECTURE.md for the planned design and README.md for status.
 */

// Phase 5 capabilities are installed as a runtime extension. This side-effect
// import makes the complete Phase 5 context available to public consumers.
import "./phase5.js";

export const ENGINE_NAME = "stream-plugin-engine";
export const ENGINE_VERSION = "0.1.0";
export const ENGINE_PHASE = 5 as const;

export { validateManifest } from "./manifest.js";
export { MANIFEST_FILE_NAME, PluginLoader } from "./loader.js";
export { PluginManager } from "./manager.js";
export { PluginRuntime } from "./runtime.js";
export { installPhase5Capabilities } from "./phase5.js";

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

export type { PluginJson, PluginHtml } from "./phase5-types.js";
export { KNOWN_CAPABILITIES } from "./types.js";
export type { LoadedPlugin } from "./types.js";
