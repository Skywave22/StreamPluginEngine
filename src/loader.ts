import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { validateManifest } from "./manifest.js";
import type { Plugin } from "./types.js";

/** Manifest file name expected inside every plugin directory. */
export const MANIFEST_FILE_NAME = "manifest.json";

/**
 * Discovers and loads plugin *metadata* from the filesystem.
 *
 * Phase 2 scope: the loader reads and validates manifest.json and safely
 * resolves the entry path. It never executes plugin JavaScript — that is
 * the responsibility of the future Plugin Runtime (Phase 3+).
 */
export class PluginLoader {
  /**
   * Loads the plugin located at `pluginPath` (a directory containing
   * manifest.json).
   *
   * Expected failure modes never throw: the returned Plugin carries status
   * "invalid" (manifest failed validation) or "failed" (missing/corrupt
   * manifest, unsafe or missing entry file) with descriptive errors.
   */
  async loadPlugin(pluginPath: string): Promise<Plugin> {
    const pluginDir = path.resolve(pluginPath);

    const dirStat = await stat(pluginDir).catch(() => null);
    if (!dirStat) {
      return {
        pluginPath: pluginDir,
        status: "failed",
        errors: [`Plugin directory not found: ${pluginDir}`],
      };
    }
    if (!dirStat.isDirectory()) {
      return {
        pluginPath: pluginDir,
        status: "failed",
        errors: [`Plugin path is not a directory: ${pluginDir}`],
      };
    }

    const manifestPath = path.join(pluginDir, MANIFEST_FILE_NAME);
    const raw = await readFile(manifestPath, "utf8").catch(() => null);
    if (raw === null) {
      return {
        pluginPath: pluginDir,
        status: "failed",
        errors: [
          `Manifest not found or not readable: ${MANIFEST_FILE_NAME}`,
        ],
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return {
        pluginPath: pluginDir,
        status: "failed",
        errors: [`Manifest is not valid JSON: ${errorMessage(error)}`],
      };
    }

    const result = validateManifest(parsed);
    if (!result.ok) {
      return { pluginPath: pluginDir, status: "invalid", errors: result.errors };
    }

    const { manifest } = result;

    // Resolve the entry path and confine it to the plugin directory.
    // The validator already rejects traversal and absolute entries; this is
    // defense in depth.
    const entryPath = path.resolve(pluginDir, manifest.entry);
    const relative = path.relative(pluginDir, entryPath);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      return {
        pluginPath: pluginDir,
        manifest,
        status: "failed",
        errors: [`Entry path escapes the plugin directory: '${manifest.entry}'`],
      };
    }

    const entryStat = await stat(entryPath).catch(() => null);
    if (!entryStat || !entryStat.isFile()) {
      return {
        pluginPath: pluginDir,
        manifest,
        status: "failed",
        errors: [`Entry file not found: ${manifest.entry}`],
      };
    }

    return {
      pluginPath: pluginDir,
      manifest,
      entryPath,
      status: "loaded",
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
