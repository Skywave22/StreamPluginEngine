/**
 * StreamPluginEngine — entry point.
 *
 * Phase 3: plugin manifest, validation, loading, the plugin manager, and
 * the sandboxed PluginRuntime (QuickJS/Wasm) are implemented. Plugins
 * execute inside an isolated JS engine with a controlled context —
 * no Node.js globals, no host files, no network.
 * See ARCHITECTURE.md for the planned design and README.md for status.
 */

/** Stable engine name, usable by future manifests and API surfaces. */
export const ENGINE_NAME = "stream-plugin-engine";

/** Current engine version (semver). */
export const ENGINE_VERSION = "0.1.0";

/** Project phase this codebase is in. */
export const ENGINE_PHASE = 3 as const;

export { validateManifest } from "./manifest.js";
export { MANIFEST_FILE_NAME, PluginLoader } from "./loader.js";
export { PluginManager } from "./manager.js";
export { PluginRuntime } from "./runtime.js";
export type {
  KnownCapability,
  ManifestValidationResult,
  Plugin,
  PluginContext,
  PluginExecutionResult,
  PluginLoadResult,
  PluginManifest,
  PluginRuntimeError,
  PluginRuntimeErrorType,
  PluginRuntimeOptions,
  PluginStatus,
} from "./types.js";
export { KNOWN_CAPABILITIES } from "./types.js";
export type { LoadedPlugin } from "./types.js";
