/**
 * StreamPluginEngine — entry point.
 *
 * Phase 2: plugin manifest, validation, loading, and the plugin manager
 * are implemented (metadata only — plugin code is never executed).
 * See ARCHITECTURE.md for the planned design and README.md for status.
 */

/** Stable engine name, usable by future manifests and API surfaces. */
export const ENGINE_NAME = "stream-plugin-engine";

/** Current engine version (semver). */
export const ENGINE_VERSION = "0.1.0";

/** Project phase this codebase is in. */
export const ENGINE_PHASE = 2 as const;

export { validateManifest } from "./manifest.js";
export { MANIFEST_FILE_NAME, PluginLoader } from "./loader.js";
export { PluginManager } from "./manager.js";
export type {
  ManifestValidationResult,
  Plugin,
  PluginManifest,
  PluginStatus,
} from "./types.js";
