/**
 * StreamPluginEngine — entry point.
 *
 * Phase 1 (foundation only). No plugin runtime, plugin loading, or
 * network capabilities exist yet. See ARCHITECTURE.md for the
 * planned design and README.md for status and scripts.
 */

/** Stable engine name, usable by future manifests and API surfaces. */
export const ENGINE_NAME = "stream-plugin-engine";

/** Current engine version (semver). */
export const ENGINE_VERSION = "0.1.0";

/** Project phase this codebase is in. */
export const ENGINE_PHASE = 1 as const;
