/**
 * Plugin registry — distribution, the way every provider ecosystem does
 * it: a single URL the user adds, which yields a list of installable
 * plugins. Ours adds the piece the others leave out: **integrity**.
 *
 * How this compares (same job, different guarantees):
 *
 * | | catalog | install | integrity check |
 * | --- | --- | --- | --- |
 * | typical provider repos | JSON list of files | fetch + write | none — whatever the URL served is what runs |
 * | ours | validated feed | fetch → verify → **atomic** install | **sha256 required**, manifest id/version must match the feed |
 *
 * Design rules:
 *
 * - **The feed is untrusted input.** It is parsed and validated like a
 *   manifest: unknown fields, wrong types, and bad URLs are reported,
 *   never repaired.
 * - **Nothing is written until the code has been verified.** The entry
 *   file's bytes must hash to the feed's `sha256`, or the install fails
 *   before touching the filesystem.
 * - **Installs are atomic.** Files are written to a temporary directory
 *   and renamed into place, so an interrupted install can never leave a
 *   half-written plugin that the loader would then execute.
 * - **Host-side only.** This module never runs plugin code, and it does
 *   no I/O of its own beyond the fetch function the host supplies.
 */
import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { HttpClient } from "./http.js";
import { validateManifest } from "./manifest.js";
import type { NetworkPolicy, AddressResolver } from "./network.js";
import type { HttpLimits } from "./http.js";
import type { PluginManifest } from "./types.js";

/** Marker that identifies our feed format (and rejects other JSON). */
export const REGISTRY_FEED_FORMAT = "stream-plugin-engine-registry";

/** Feed schema revision this engine understands. */
export const REGISTRY_FEED_VERSION = 1;

export const REGISTRY_ERROR_CODES = [
  /** The feed JSON is malformed or fails validation. */
  "REGISTRY_INVALID_FEED",
  /** The feed could not be fetched (network/HTTP problem). */
  "REGISTRY_FETCH_FAILED",
  /** No entry with the requested ID (or version). */
  "REGISTRY_PLUGIN_NOT_FOUND",
  /** Fetched bytes do not match the feed's sha256. */
  "REGISTRY_HASH_MISMATCH",
  /** The fetched manifest is invalid, or disagrees with the feed. */
  "REGISTRY_MANIFEST_MISMATCH",
  /** The filesystem refused the install. */
  "REGISTRY_INSTALL_FAILED",
] as const;

export type RegistryErrorCode = (typeof REGISTRY_ERROR_CODES)[number];

export interface RegistryError {
  code: RegistryErrorCode;
  message: string;
}

/** One installable plugin, as declared by a feed. */
export interface RegistryPluginEntry {
  /** Manifest id this entry provides. */
  id: string;
  /** Human-readable name (defaults to the id). */
  name?: string;
  /** Semantic version of the plugin being offered. */
  version: string;
  /** Entry file URL. */
  url: string;
  /** Manifest URL. */
  manifestUrl: string;
  /**
   * Lowercase hex sha256 of the entry file's bytes. REQUIRED: an entry
   * without a hash is rejected, because "install whatever this URL
   * serves" is exactly the behaviour that makes plugin repositories a
   * supply-chain hazard.
   */
  sha256: string;
  /** Optional plugin API version this build targets. */
  apiVersion?: number;
  description?: string;
  author?: string;
  /** Free-form tags (e.g. `movies`, `anime`) for catalog UIs. */
  tags?: readonly string[];
}

export interface RegistryFeed {
  format: string;
  version: number;
  /** Optional registry name. */
  name?: string;
  description?: string;
  plugins: RegistryPluginEntry[];
}

export type RegistryFeedValidation =
  | { ok: true; feed: RegistryFeed }
  | { ok: false; errors: string[] };

/** Reads a URL and returns its UTF-8 body. Injected so tests stay offline. */
export type RegistryFetch = (url: string) => Promise<string>;

export interface PluginRegistryOptions {
  /**
   * How to read feed/plugin URLs. Defaults to the engine's own
   * `HttpClient`, so the host's network policy, size caps and timeouts
   * apply to registry traffic too.
   */
  fetch?: RegistryFetch;
  /** Receives install/catalog diagnostics. */
  logger?: (message: string) => void;
  /** Options for the default HttpClient-backed fetcher. */
  http?: {
    limits?: Partial<HttpLimits>;
    network?: Partial<NetworkPolicy>;
    resolver?: AddressResolver;
  };
}

export interface InstalledPlugin {
  id: string;
  version: string;
  /** Absolute path of the installed plugin directory. */
  path: string;
  /** Entry file path relative to `path` (from the manifest). */
  entry: string;
  /** sha256 actually verified during this install. */
  sha256: string;
}

/** An available newer version for an installed plugin. */
export interface RegistryUpdate {
  id: string;
  /** Version the caller reported as installed. */
  installedVersion: string;
  /** Version the feed offers. */
  availableVersion: string;
  entry: RegistryPluginEntry;
}

const HEX64 = /^[0-9a-f]{64}$/;
const SEMVER_CORE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compares two semantic versions.
 *
 * Pre-release ordering is implemented the way the spec defines it
 * (numeric identifiers compare numerically and rank BELOW the release,
 * alphanumeric ones lexically), because `1.0.0-beta` must not look newer
 * than `1.0.0`. Unparseable versions compare as equal, so a malformed
 * version can never trigger a spurious "update available".
 */
export function compareVersions(a: string, b: string): number {
  const parsedA = SEMVER_CORE.exec(a);
  const parsedB = SEMVER_CORE.exec(b);
  if (!parsedA || !parsedB) return 0;
  for (let i = 1; i <= 3; i += 1) {
    const left = Number(parsedA[i]);
    const right = Number(parsedB[i]);
    if (left !== right) return left < right ? -1 : 1;
  }
  const preA = parsedA[4];
  const preB = parsedB[4];
  if (preA === preB) return 0;
  if (preA === undefined) return 1; // release > pre-release
  if (preB === undefined) return -1;
  const partsA = preA.split(".");
  const partsB = preB.split(".");
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i += 1) {
    const left = partsA[i];
    const right = partsB[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const numericLeft = /^\d+$/.test(left);
    const numericRight = /^\d+$/.test(right);
    if (numericLeft && numericRight) {
      const difference = Number(left) - Number(right);
      if (difference !== 0) return difference < 0 ? -1 : 1;
    } else if (numericLeft !== numericRight) {
      // Numeric identifiers have lower precedence than alphanumeric ones.
      return numericLeft ? -1 : 1;
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Validates a parsed feed. Collects every problem, like manifest
 * validation does, so one call reports the whole picture.
 */
export function validateRegistryFeed(input: unknown): RegistryFeedValidation {
  if (!isPlainObject(input)) {
    return { ok: false, errors: ["Registry feed: expected a JSON object"] };
  }
  const errors: string[] = [];
  const { format, version, name, description, plugins } = input;

  if (format !== REGISTRY_FEED_FORMAT) {
    errors.push(
      `Registry feed: 'format' must be '${REGISTRY_FEED_FORMAT}'`,
    );
  }
  if (version !== REGISTRY_FEED_VERSION) {
    errors.push(
      `Registry feed: 'version' must be ${REGISTRY_FEED_VERSION} (got ${JSON.stringify(version)})`,
    );
  }
  if (name !== undefined && typeof name !== "string") {
    errors.push("Registry feed: 'name' must be a string");
  }
  if (description !== undefined && typeof description !== "string") {
    errors.push("Registry feed: 'description' must be a string");
  }

  if (!Array.isArray(plugins)) {
    errors.push("Registry feed: 'plugins' must be an array");
    return { ok: false, errors };
  }
  if (plugins.length === 0) {
    errors.push("Registry feed: 'plugins' must not be empty");
  }

  const seen = new Map<string, number>();
  plugins.forEach((plugin, index) => {
    const where = `Registry feed: 'plugins[${index}]'`;
    if (!isPlainObject(plugin)) {
      errors.push(`${where} must be an object`);
      return;
    }
    for (const field of Object.keys(plugin)) {
      if (
        ![
          "id",
          "name",
          "version",
          "url",
          "manifestUrl",
          "sha256",
          "apiVersion",
          "description",
          "author",
          "tags",
        ].includes(field)
      ) {
        errors.push(`${where} has an unknown field '${field}'`);
      }
    }
    const { id, name: entryName, version: entryVersion, url, manifestUrl, sha256, apiVersion, description: entryDescription, author, tags } = plugin;

    if (typeof id !== "string" || id.length === 0) {
      errors.push(`${where}.id must be a non-empty string`);
    } else {
      const previous = seen.get(id);
      if (previous !== undefined) {
        errors.push(`${where}.id '${id}' duplicates plugins[${previous}]`);
      } else {
        seen.set(id, index);
      }
    }
    if (entryName !== undefined && typeof entryName !== "string") {
      errors.push(`${where}.name must be a string`);
    }
    if (typeof entryVersion !== "string" || !SEMVER_CORE.test(entryVersion)) {
      errors.push(`${where}.version must be a semantic version (e.g. '1.0.0')`);
    }
    if (typeof url !== "string" || !isHttpUrl(url)) {
      errors.push(`${where}.url must be an absolute http(s) URL`);
    }
    if (typeof manifestUrl !== "string" || !isHttpUrl(manifestUrl)) {
      errors.push(`${where}.manifestUrl must be an absolute http(s) URL`);
    }
    if (typeof sha256 !== "string" || !HEX64.test(sha256)) {
      errors.push(
        `${where}.sha256 must be a lowercase hex sha256 of the entry file (integrity is required)`,
      );
    }
    if (
      apiVersion !== undefined &&
      (typeof apiVersion !== "number" || !Number.isInteger(apiVersion) || apiVersion < 1)
    ) {
      errors.push(`${where}.apiVersion must be a positive integer`);
    }
    if (entryDescription !== undefined && typeof entryDescription !== "string") {
      errors.push(`${where}.description must be a string`);
    }
    if (author !== undefined && typeof author !== "string") {
      errors.push(`${where}.author must be a string`);
    }
    if (tags !== undefined) {
      if (
        !Array.isArray(tags) ||
        tags.some((tag) => typeof tag !== "string" || tag.length === 0)
      ) {
        errors.push(`${where}.tags must be an array of non-empty strings`);
      }
    }
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    feed: {
      format: REGISTRY_FEED_FORMAT,
      version: REGISTRY_FEED_VERSION,
      ...(typeof name === "string" ? { name } : {}),
      ...(typeof description === "string" ? { description } : {}),
      plugins: plugins as RegistryPluginEntry[],
    },
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** sha256 of a UTF-8 string, lowercase hex. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A plugin catalog. Construct with host options, `load()` a feed URL,
 * then `install()` entries into a plugins directory.
 *
 * ```js
 * const registry = new PluginRegistry();
 * const loaded = await registry.load("https://example.test/registry.json");
 * if (loaded.ok) {
 *   await registry.install("acme.sources", "./plugins");
 * }
 * ```
 */
export class PluginRegistry {
  private readonly fetcher: RegistryFetch;
  private readonly logger: (message: string) => void;
  private feed: RegistryFeed | null = null;
  /** Feed URL the current catalog came from (for diagnostics). */
  private feedUrl: string | null = null;

  constructor(options: PluginRegistryOptions = {}) {
    this.logger = options.logger ?? (() => {});
    if (options.fetch) {
      this.fetcher = options.fetch;
    } else {
      const client = new HttpClient({
        limits: options.http?.limits,
        network: options.http?.network,
        resolver: options.http?.resolver,
      });
      this.fetcher = async (url: string) => {
        const response = await client.request(url);
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        return response.body;
      };
    }
  }

  /** The loaded catalog, or null before a successful `load()`. */
  get catalog(): RegistryFeed | null {
    return this.feed;
  }

  /** The URL the loaded catalog came from. */
  get sourceUrl(): string | null {
    return this.feedUrl;
  }

  /**
   * Fetches and validates a feed. The previous catalog is replaced ONLY
   * on success, so a transient failure cannot leave the registry
   * half-updated.
   */
  async load(
    feedUrl: string,
  ): Promise<
    | { ok: true; feed: RegistryFeed; plugins: RegistryPluginEntry[] }
    | { ok: false; error: RegistryError }
  > {
    let text: string;
    try {
      text = await this.fetcher(feedUrl);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "REGISTRY_FETCH_FAILED",
          message: `Could not fetch registry feed '${feedUrl}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        ok: false,
        error: {
          code: "REGISTRY_INVALID_FEED",
          message: `Registry feed '${feedUrl}' is not valid JSON`,
        },
      };
    }

    const validation = validateRegistryFeed(parsed);
    if (!validation.ok) {
      return {
        ok: false,
        error: {
          code: "REGISTRY_INVALID_FEED",
          message: validation.errors.join("; "),
        },
      };
    }

    this.feed = validation.feed;
    this.feedUrl = feedUrl;
    return {
      ok: true,
      feed: validation.feed,
      plugins: validation.feed.plugins,
    };
  }

  /** The loaded catalog's entries (empty before a successful load). */
  list(): RegistryPluginEntry[] {
    return this.feed ? [...this.feed.plugins] : [];
  }

  /** Finds one entry by id (optionally requiring an exact version). */
  resolve(id: string, version?: string): RegistryPluginEntry | undefined {
    return this.feed?.plugins.find(
      (entry) => entry.id === id && (version === undefined || entry.version === version),
    );
  }

  /**
   * Downloads, VERIFIES and installs one plugin.
   *
   * Order matters and is the point of this method: fetch both files →
   * verify the entry hash and the manifest → only then write. A failure
   * at any earlier step leaves the filesystem untouched.
   */
  async install(
    id: string,
    targetDir: string,
    options: { version?: string; overwrite?: boolean } = {},
  ): Promise<{ ok: true; installed: InstalledPlugin } | { ok: false; error: RegistryError }> {
    const entry = this.resolve(id, options.version);
    if (!entry) {
      return {
        ok: false,
        error: {
          code: "REGISTRY_PLUGIN_NOT_FOUND",
          message: this.feed
            ? `No plugin '${id}'${
                options.version ? ` at version ${options.version}` : ""
              } in the loaded registry feed`
            : "No registry feed is loaded — call load() first",
        },
      };
    }

    // --- fetch ---------------------------------------------------------
    let entrySource: string;
    let manifestSource: string;
    try {
      entrySource = await this.fetcher(entry.url);
      manifestSource = await this.fetcher(entry.manifestUrl);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "REGISTRY_FETCH_FAILED",
          message: `Could not download '${id}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      };
    }

    // --- verify --------------------------------------------------------
    const actualHash = createHash("sha256")
      .update(entrySource, "utf8")
      .digest("hex");
    if (actualHash !== entry.sha256) {
      return {
        ok: false,
        error: {
          code: "REGISTRY_HASH_MISMATCH",
          message: `Refusing to install '${id}': sha256 of the downloaded entry is ${actualHash}, but the feed declares ${entry.sha256}`,
        },
      };
    }

    let manifestInput: unknown;
    try {
      manifestInput = JSON.parse(manifestSource);
    } catch {
      return {
        ok: false,
        error: {
          code: "REGISTRY_MANIFEST_MISMATCH",
          message: `Manifest for '${id}' is not valid JSON`,
        },
      };
    }
    const manifestResult = validateManifest(manifestInput);
    if (!manifestResult.ok) {
      return {
        ok: false,
        error: {
          code: "REGISTRY_MANIFEST_MISMATCH",
          message: `Manifest for '${id}' is invalid: ${manifestResult.errors.join("; ")}`,
        },
      };
    }
    const manifest: PluginManifest = manifestResult.manifest;
    if (manifest.id !== entry.id || manifest.version !== entry.version) {
      return {
        ok: false,
        error: {
          code: "REGISTRY_MANIFEST_MISMATCH",
          message: `Manifest for '${id}' declares '${manifest.id}' ${manifest.version}, but the feed offers '${entry.id}' ${entry.version}`,
        },
      };
    }

    // --- write (atomically) -------------------------------------------
    const destination = path.join(targetDir, manifest.id);
    const staging = path.join(
      targetDir,
      `.install-${manifest.id}-${process.pid}-${Date.now()}`,
    );
    try {
      await mkdir(targetDir, { recursive: true });
      await mkdir(path.dirname(path.join(staging, manifest.entry)), {
        recursive: true,
      });
      await writeFile(path.join(staging, "manifest.json"), manifestSource, "utf8");
      await writeFile(path.join(staging, manifest.entry), entrySource, "utf8");

      if (options.overwrite) {
        await rm(destination, { recursive: true, force: true });
      }
      await rename(staging, destination);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      return {
        ok: false,
        error: {
          code: "REGISTRY_INSTALL_FAILED",
          message: `Could not install '${id}' into '${targetDir}': ${
            error instanceof Error ? error.message : String(error)
          }${options.overwrite ? "" : " (pass { overwrite: true } to replace an existing install)"}`,
        },
      };
    }

    this.logger(
      `installed ${manifest.id} ${manifest.version} (sha256 ${actualHash.slice(0, 12)}…)`,
    );
    return {
      ok: true,
      installed: {
        id: manifest.id,
        version: manifest.version,
        path: destination,
        entry: manifest.entry,
        sha256: actualHash,
      },
    };
  }

  /**
   * Compares installed versions against the loaded feed. Returns only
   * entries that are strictly newer, so a caller can offer "update
   * available" without re-implementing version comparison.
   */
  checkUpdates(
    installed: readonly { id: string; version: string }[],
  ): RegistryUpdate[] {
    if (!this.feed) return [];
    const updates: RegistryUpdate[] = [];
    for (const current of installed) {
      const entry = this.resolve(current.id);
      if (!entry) continue;
      if (compareVersions(entry.version, current.version) > 0) {
        updates.push({
          id: current.id,
          installedVersion: current.version,
          availableVersion: entry.version,
          entry,
        });
      }
    }
    return updates;
  }
}
