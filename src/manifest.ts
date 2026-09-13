import type {
  ManifestValidationResult,
  PluginManifest,
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
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  const { id, name, version, entry, author, description, domains } = input;
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

  return { ok: true, manifest };
}
