/**
 * Core types for plugin manifests, plugins, and validation results.
 *
 * Phase 2: these types describe plugin *metadata* only. Plugin JavaScript
 * execution is intentionally not implemented in this phase.
 */

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
 * - "loaded" — manifest validated, metadata ready for the future runtime
 * - "invalid" — manifest failed validation
 * - "failed" — could not be loaded (missing/corrupt manifest, unsafe or
 *   missing entry file, duplicate ID)
 */
export type PluginStatus = "discovered" | "loaded" | "invalid" | "failed";

/**
 * Internal plugin representation. In Phase 2 this holds metadata only:
 * plugin code is never executed.
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
