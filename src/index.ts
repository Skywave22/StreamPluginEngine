/**
 * StreamPluginEngine — entry point.
 *
 * Phase 6 (final): plugin manifest, validation, loading, the sandboxed
 * PluginRuntime (QuickJS/Wasm), controlled HTTP, HTML/JSON parsing
 * capabilities, and the normalized source result pipeline. Plugins
 * execute inside an isolated JS engine with a controlled context.
 * Network access is only available through context.http; HTML parsing
 * never executes JavaScript or fetches linked resources; plugin result
 * output is validated and normalized before the application consumes it.
 * See ARCHITECTURE.md for the design and README.md for status.
 */

export const ENGINE_NAME = "stream-plugin-engine";
export const ENGINE_VERSION = "0.1.0";
export const ENGINE_PHASE = 6 as const;

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

export {
  PHASE5_LIMITS,
  PHASE5_ERROR_CODES,
  Phase5Error,
  parseHtml,
  selectHtml,
  extractHtml,
} from "./phase5.js";

export type {
  Phase5ErrorCode,
  Phase5ErrorObject,
  HtmlDocument,
  HtmlNode,
  HtmlElement,
  HtmlElementInfo,
} from "./phase5.js";

export type { PluginJson, PluginHtml } from "./phase5-types.js";

export {
  RESULT_LIMITS,
  RESULT_ERROR_CODES,
  SOURCE_RESULT_TYPES,
  normalizeSourceResults,
} from "./results.js";

export type {
  ResultErrorCode,
  ResultErrorObject,
  SourceResult,
  SourceResultType,
  SourceResultValidationResult,
  SourceSubtitle,
} from "./results.js";

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
