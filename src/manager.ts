import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { MANIFEST_FILE_NAME, PluginLoader } from "./loader.js";
import type { Plugin } from "./types.js";

/**
 * In-memory registry of plugins.
 *
 * Responsibilities (Phase 2):
 * - discover plugins from a plugins directory
 * - load valid plugin manifests (metadata only — no code execution)
 * - prevent duplicate plugin IDs
 * - retrieve, list, and unregister plugins
 * - track engine-level enable/disable state per plugin (v0.2.0)
 *
 * Each call to discoverPlugins() rebuilds the registry from the given
 * directory; the enable/disable state is owned by this registry and
 * survives rediscovery (a plugin disabled before a rescan is still
 * disabled after it). The runtime refuses to load a disabled plugin, so
 * "disabled" means no plugin code runs — not merely "hidden".
 *
 * The manager contains no HTTP or runtime logic, and the state is
 * in-memory only: persistence is an application concern.
 */
export class PluginManager {
  private readonly loader = new PluginLoader();
  private readonly pluginsById = new Map<string, Plugin>();
  /** IDs disabled by the host application. Source of truth. */
  private readonly disabledIds = new Set<string>();
  private problems: Plugin[] = [];

  /**
   * Scans `pluginsDir` for plugin directories (subdirectories containing
   * manifest.json), loads their manifests, and registers the valid ones.
   *
   * One broken plugin never aborts the scan: it is recorded via
   * getProblems() while valid plugins continue to load.
   *
   * Throws if `pluginsDir` does not exist or is not a directory.
   */
  async discoverPlugins(pluginsDir: string): Promise<void> {
    const dir = path.resolve(pluginsDir);
    const dirStat = await stat(dir).catch(() => null);
    if (!dirStat || !dirStat.isDirectory()) {
      throw new Error(`Plugins directory not found: ${dir}`);
    }

    // Rebuild the registry on every discovery.
    this.pluginsById.clear();
    this.problems = [];

    const entries = await readdir(dir, { withFileTypes: true });
    const pluginDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    for (const name of pluginDirs) {
      const pluginDir = path.join(dir, name);
      const manifestPath = path.join(pluginDir, MANIFEST_FILE_NAME);

      const manifestExists = await stat(manifestPath).catch(() => null);
      if (!manifestExists) {
        // Not a plugin directory; skip silently.
        continue;
      }

      const plugin = await this.loader.loadPlugin(pluginDir);

      if (plugin.status === "loaded" && plugin.manifest) {
        const id = plugin.manifest.id;
        const existing = this.pluginsById.get(id);
        if (existing) {
          this.problems.push({
            ...plugin,
            status: "failed",
            errors: [
              `Duplicate plugin ID '${id}' (already loaded from ${existing.pluginPath})`,
            ],
          });
        } else {
          plugin.enabled = !this.disabledIds.has(id);
          this.pluginsById.set(id, plugin);
        }
      } else {
        this.problems.push(plugin);
      }
    }
  }

  /** Returns the loaded plugin with the given ID, if any. */
  getPlugin(id: string): Plugin | undefined {
    return this.pluginsById.get(id);
  }

  /** Returns all successfully loaded plugins, sorted by ID. */
  listPlugins(): Plugin[] {
    return [...this.pluginsById.values()].sort((a, b) =>
      (a.manifest?.id ?? "").localeCompare(b.manifest?.id ?? ""),
    );
  }

  /**
   * Removes a plugin from the in-memory registry (no filesystem change).
   * Returns true if a plugin with the given ID was registered. Also
   * clears any enable/disable state for that ID.
   */
  unregister(id: string): boolean {
    this.disabledIds.delete(id);
    return this.pluginsById.delete(id);
  }

  /**
   * Enables or disables a registered plugin. Returns false when no
   * plugin with that ID is registered (nothing to toggle).
   *
   * The state is engine-owned and survives rediscovery; the runtime
   * refuses to load a disabled plugin, so no plugin code executes while
   * it is disabled. Re-enabling only flips the flag — the plugin is
   * loaded lazily by the normal load path, never automatically here.
   */
  setEnabled(id: string, enabled: boolean): boolean {
    const plugin = this.pluginsById.get(id);
    if (!plugin) {
      return false;
    }
    if (enabled) {
      this.disabledIds.delete(id);
    } else {
      this.disabledIds.add(id);
    }
    plugin.enabled = enabled;
    return true;
  }

  /** Convenience wrapper for `setEnabled(id, true)`. */
  enable(id: string): boolean {
    return this.setEnabled(id, true);
  }

  /** Convenience wrapper for `setEnabled(id, false)`. */
  disable(id: string): boolean {
    return this.setEnabled(id, false);
  }

  /**
   * Whether a registered plugin is enabled. Unregistered IDs report
   * false, matching "no plugin, nothing to run".
   */
  isEnabled(id: string): boolean {
    const plugin = this.pluginsById.get(id);
    if (!plugin) {
      return false;
    }
    return plugin.enabled !== false;
  }

  /** IDs currently disabled in this registry. */
  listDisabledIds(): string[] {
    return [...this.disabledIds].sort();
  }

  /** Plugins that were discovered but could not be loaded. */
  getProblems(): Plugin[] {
    return [...this.problems];
  }
}
