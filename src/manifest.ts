import { isValidStoreKey } from "./store.js";
import type {
  ManifestValidationResult,
  PluginManifest,
  PluginSetting,
} from "./types.js";

/**
 * IDs look like "example.source" or "my-source.v2": one or more dot-separated
 * segments of lowercase letters, digits, and hyphens, each starting with a
 * letter or digit.
 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;

/** Official semantic version pattern (semver.org). */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "name",
  "version",
  "entry",
  "author",
  "description",
  "domains",
  "apiVersion",
  "mirrors",
  "settings",
]);

/**
 * The plugin API version this engine implements (the contract between a
 * plugin and the engine: the context surface + capability semantics).
 *
 * Bump this only when the plugin contract changes incompatibly. A
 * manifest may declare `apiVersion`; requiring a version this engine does
 * not implement is rejected at validation time, so an incompatible
 * plugin fails loudly at load instead of mysteriously at runtime.
 * Absent means 1 (the original contract).
 *
 * Version history:
 * - **1** — `context.html.parse/select/extract` exchange JSON document
 *   trees and element nodes with the guest.
 * - **2** — `context.html` is HANDLE-based: `parse` returns a numeric
 *   document handle, `select` returns numeric element handles, `extract`
 *   returns the info object. The tree never crosses the Wasm boundary,
 *   which makes the pipeline several times faster, removes the ~500-level
 *   nesting limit (a QuickJS value-delivery limit), and stops untrusted
 *   document structures from being handed to the host selector engine.
 *   Manifests with apiVersion 1 (or absent) keep the version-1 behaviour
 *   unchanged, so no existing plugin breaks.
 */
export const ENGINE_API_VERSION = 2;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SETTING_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "boolean",
  "select",
  "mirror",
]);

/** Maximum entries in a `select` setting's `options` list. */
const MAX_SETTING_OPTIONS = 16;

/**
 * Validates ONE declared setting. Returns human-readable problems (empty
 * when the setting is fine).
 *
 * The interesting cases are the two constrained types: a `select` whose
 * default is not among its own options, and a `mirror` whose value is not
 * one of the manifest's declared mirrors. Both are rejected at validation
 * time, because either would otherwise hand an application a value the
 * engine is about to refuse at the HTTP layer.
 */
function validateSetting(
  input: unknown,
  index: number,
  mirrors: unknown,
  seenKeys: Set<string>,
): string[] {
  const errors: string[] = [];
  const where = `Plugin manifest: 'settings[${index}]'`;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return [`${where} must be an object`];
  }
  const { key, type, default: fallback, label, description, options } =
    input as Record<string, unknown>;

  for (const field of Object.keys(input as Record<string, unknown>)) {
    if (
      !["key", "type", "default", "label", "description", "options"].includes(
        field,
      )
    ) {
      errors.push(`${where} has an unknown field '${field}'`);
    }
  }

  if (!isValidStoreKey(key)) {
    errors.push(
      `${where}.key must be 1-64 characters of [A-Za-z0-9._-], starting with a letter or digit`,
    );
  } else if (seenKeys.has(key)) {
    errors.push(`${where}.key '${key}' is declared more than once`);
  } else {
    seenKeys.add(key);
  }

  if (typeof type !== "string" || !SETTING_TYPES.has(type)) {
    errors.push(
      `${where}.type must be one of ${[...SETTING_TYPES].join(", ")}`,
    );
    return errors;
  }

  if (label !== undefined && typeof label !== "string") {
    errors.push(`${where}.label must be a string`);
  }
  if (description !== undefined && typeof description !== "string") {
    errors.push(`${where}.description must be a string`);
  }

  const validOptions =
    options === undefined
      ? undefined
      : Array.isArray(options)
        ? options
        : null;
  if (validOptions === null) {
    errors.push(`${where}.options must be an array of strings`);
  } else if (validOptions) {
    if (type !== "select") {
      errors.push(`${where}.options is only meaningful for type 'select'`);
    }
    if (validOptions.length < 2 || validOptions.length > MAX_SETTING_OPTIONS) {
      errors.push(
        `${where}.options must list 2-${MAX_SETTING_OPTIONS} values`,
      );
    }
    validOptions.forEach((option, optionIndex) => {
      if (typeof option !== "string" || option.length === 0) {
        errors.push(`${where}.options[${optionIndex}] must be a non-empty string`);
      }
    });
  }
  if (type === "select" && !validOptions) {
    errors.push(`${where}.options is required for type 'select'`);
  }

  if (fallback !== undefined) {
    if (type === "string" && typeof fallback !== "string") {
      errors.push(`${where}.default must be a string`);
    } else if (type === "number") {
      if (typeof fallback !== "number" || !Number.isFinite(fallback)) {
        errors.push(`${where}.default must be a finite number`);
      }
    } else if (type === "boolean" && typeof fallback !== "boolean") {
      errors.push(`${where}.default must be a boolean`);
    } else if (
      (type === "select" || type === "mirror") &&
      typeof fallback !== "string"
    ) {
      errors.push(`${where}.default must be a string`);
    }
  }

  if (type === "select" && typeof fallback === "string" && validOptions) {
    if (!validOptions.includes(fallback)) {
      errors.push(
        `${where}.default '${fallback}' is not one of its own options`,
      );
    }
  }

  if (type === "mirror") {
    const mirrorList = Array.isArray(mirrors) ? mirrors : [];
    if (mirrorList.length === 0) {
      errors.push(
        `${where} is type 'mirror' but the manifest declares no 'mirrors'`,
      );
    } else if (typeof fallback === "string" && !mirrorList.includes(fallback)) {
      errors.push(
        `${where}.default '${fallback}' is not one of the manifest's declared mirrors`,
      );
    }
  }

  return errors;
}

/**
 * Validates a candidate manifest (typically parsed JSON) against the
 * PluginManifest format.
 *
 * Input is treated as untrusted. Invalid manifests are never repaired or
 * mutated; all problems are collected into human-readable error messages so
 * a single call reports everything that is wrong.
 */
export function validateManifest(input: unknown): ManifestValidationResult {
  if (!isPlainObject(input)) {
    return { ok: false, errors: ["Plugin manifest: expected a JSON object"] };
  }

  const {
    id,
    name,
    version,
    entry,
    author,
    description,
    domains,
    apiVersion,
    mirrors,
    settings,
  } = input;
  const errors: string[] = [];

  for (const field of Object.keys(input)) {
    if (!KNOWN_FIELDS.has(field)) {
      errors.push(`Plugin manifest: unknown field '${field}'`);
    }
  }

  if (id === undefined) {
    errors.push("Plugin manifest: 'id' is required");
  } else if (typeof id !== "string" || id.length === 0) {
    errors.push("Plugin manifest: 'id' must be a non-empty string");
  } else if (!ID_PATTERN.test(id)) {
    errors.push(
      "Plugin manifest: 'id' must be lowercase letters, digits, and hyphens separated by dots (e.g. 'example.source')",
    );
  }

  if (name === undefined) {
    errors.push("Plugin manifest: 'name' is required");
  } else if (typeof name !== "string" || name.trim().length === 0) {
    errors.push("Plugin manifest: 'name' must be a non-empty string");
  }

  if (version === undefined) {
    errors.push("Plugin manifest: 'version' is required");
  } else if (
    typeof version !== "string" ||
    !SEMVER_PATTERN.test(version)
  ) {
    errors.push(
      "Plugin manifest: 'version' must be a semantic version (e.g. '1.0.0')",
    );
  }

  if (entry === undefined) {
    errors.push("Plugin manifest: 'entry' is required");
  } else if (typeof entry !== "string" || entry.length === 0) {
    errors.push("Plugin manifest: 'entry' must be a non-empty string");
  } else if (entry.includes("\\")) {
    errors.push("Plugin manifest: 'entry' must use forward slashes");
  } else if (entry.startsWith("/")) {
    errors.push(
      "Plugin manifest: 'entry' must be relative to the plugin directory",
    );
  } else if (entry.split("/").some((segment) => segment === "..")) {
    errors.push(
      "Plugin manifest: 'entry' must not contain path traversal ('..')",
    );
  }

  if (author !== undefined && typeof author !== "string") {
    errors.push("Plugin manifest: 'author' must be a string");
  }

  if (description !== undefined && typeof description !== "string") {
    errors.push("Plugin manifest: 'description' must be a string");
  }

  if (domains !== undefined) {
    if (!Array.isArray(domains)) {
      errors.push("Plugin manifest: 'domains' must be an array of strings");
    } else {
      domains.forEach((domain, index) => {
        if (typeof domain !== "string" || domain.length === 0) {
          errors.push(
            `Plugin manifest: 'domains[${index}]' must be a non-empty string`,
          );
        }
      });
    }
  }

  if (mirrors !== undefined) {
    if (!Array.isArray(mirrors)) {
      errors.push("Plugin manifest: 'mirrors' must be an array of strings");
    } else {
      mirrors.forEach((mirror, index) => {
        if (typeof mirror !== "string" || mirror.length === 0) {
          errors.push(
            `Plugin manifest: 'mirrors[${index}]' must be a non-empty string`,
          );
        }
      });
    }
  }

  if (settings !== undefined) {
    if (!Array.isArray(settings)) {
      errors.push("Plugin manifest: 'settings' must be an array of objects");
    } else {
      const seenKeys = new Set<string>();
      settings.forEach((setting, index) => {
        errors.push(...validateSetting(setting, index, mirrors, seenKeys));
      });
    }
  }

  if (apiVersion !== undefined) {
    if (
      typeof apiVersion !== "number" ||
      !Number.isInteger(apiVersion) ||
      apiVersion < 1
    ) {
      errors.push(
        "Plugin manifest: 'apiVersion' must be a positive integer (e.g. 1)",
      );
    } else if (apiVersion > ENGINE_API_VERSION) {
      errors.push(
        `Plugin manifest: 'apiVersion' ${apiVersion} is not supported by this engine (implements ${ENGINE_API_VERSION})`,
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // All checks passed: build the typed manifest.
  const manifest: PluginManifest = {
    id: id as string,
    name: name as string,
    version: version as string,
    entry: entry as string,
  };
  if (typeof author === "string") {
    manifest.author = author;
  }
  if (typeof description === "string") {
    manifest.description = description;
  }
  if (Array.isArray(domains)) {
    manifest.domains = domains as string[];
  }
  if (typeof apiVersion === "number") {
    manifest.apiVersion = apiVersion;
  }
  if (Array.isArray(mirrors)) {
    manifest.mirrors = mirrors as string[];
  }
  if (Array.isArray(settings)) {
    manifest.settings = settings as PluginSetting[];
  }

  return { ok: true, manifest };
}
