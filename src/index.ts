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
export const ENGINE_VERSION = "0.5.0";
/**
 * The engine's PRODUCTION RUNTIME capability level: Phase 6 (normalized
 * source result pipeline) is the last phase that adds runtime behaviour.
 *
 * Phase 7 exists but is deliberately NOT reflected here: it is
 * developer-only validation tooling (security regression, CLI end-to-end,
 * lifecycle/concurrency tests, and `tools/benchmark.mjs`). It adds no
 * runtime capability and is not part of this public API.
 */
export const ENGINE_PHASE = 6 as const;

export { ENGINE_API_VERSION, validateManifest } from "./manifest.js";
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
  RequestPolicy,
} from "./http.js";

export {
  DEFAULT_NETWORK_POLICY,
  checkDeclaredDomain,
  checkRequestTarget,
  classifyAddress,
  domainPatternMatches,
  hostFromUrl,
  isAddressAllowed,
  isHostAllowed,
  isSubdomainOnlyPattern,
  normalizeDomainPattern,
} from "./network.js";

export type {
  AddressClass,
  AddressResolver,
  NetworkDecision,
  NetworkPolicy,
} from "./network.js";

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

export type { PluginJson, PluginHtml, PluginHtml2 } from "./phase5-types.js";

export {
  RESULT_LIMITS,
  RESULT_ERROR_CODES,
  SOURCE_RESULT_FORMATS,
  SOURCE_RESULT_TYPES,
  normalizeSourceResults,
} from "./results.js";

export type {
  PlaybackHeaders,
  ResultErrorCode,
  ResultErrorObject,
  SourceResult,
  SourceResultFormat,
  SourceResultType,
  SourceResultValidationResult,
  SourceSubtitle,
} from "./results.js";

export { PluginCoordinator, qualityScore } from "./coordinator.js";

export type {
  CollectSourcesResult,
  FanOutStats,
  PluginCoordinatorOptions,
  PluginExecutor,
  PluginRunOutcome,
} from "./coordinator.js";

export {
  createPluginStore,
  isValidStoreKey,
  MemoryStoreBackend,
  PluginStore,
  sanitizeStoreValue,
  settingsDefaults,
  STORE_ERROR_CODES,
  STORE_LIMITS,
} from "./store.js";
export type {
  StoreBackend,
  StoreError,
  StoreErrorCode,
} from "./store.js";

export {
  compareVersions,
  PluginRegistry,
  REGISTRY_ERROR_CODES,
  REGISTRY_FEED_FORMAT,
  REGISTRY_FEED_VERSION,
  sha256Hex,
  validateRegistryFeed,
} from "./registry.js";
export type {
  InstalledPlugin,
  PluginRegistryOptions,
  RegistryError,
  RegistryErrorCode,
  RegistryFeed,
  RegistryFeedValidation,
  RegistryFetch,
  RegistryPluginEntry,
  RegistryUpdate,
} from "./registry.js";

export type {
  KnownCapability,
  PluginSetting,
  StandardCapability,
  ManifestValidationResult,
  Plugin,
  PluginContext,
  PluginContextV2,
  PluginExecutionResult,
  PluginHttp,
  PluginLoadResult,
  PluginManifest,
  PluginPermissions,
  PluginRuntimeError,
  PluginRuntimeErrorType,
  PluginRuntimeOptions,
  PluginStatus,
  ResolvedPluginPermissions,
} from "./types.js";

export { KNOWN_CAPABILITIES, STANDARD_CAPABILITIES } from "./types.js";
export type { LoadedPlugin } from "./types.js";
