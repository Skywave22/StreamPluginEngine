import assert from "node:assert/strict";
import { test } from "node:test";

import { validateManifest } from "../src/manifest.js";
import type { PluginManifest } from "../src/types.js";

const VALID_MANIFEST: PluginManifest = {
  id: "example.source",
  name: "Example Source",
  version: "1.0.0",
  entry: "plugin.js",
  author: "Example Developer",
  description: "Example plugin",
  domains: ["example.com"],
};

/** Returns the errors for input that is expected to be invalid. */
function expectInvalid(input: unknown): string[] {
  const result = validateManifest(input);
  assert.equal(result.ok, false, `expected invalid manifest: ${JSON.stringify(input)}`);
  if (result.ok) {
    return [];
  }
  return result.errors;
}

/** Returns a copy of `manifest` without the given key. */
function omit<K extends keyof PluginManifest>(
  manifest: PluginManifest,
  key: K,
): Omit<PluginManifest, K> {
  const copy: Record<string, unknown> = { ...manifest };
  delete copy[key];
  return copy as Omit<PluginManifest, K>;
}

test("valid manifest (all fields) is accepted", () => {
  const result = validateManifest(VALID_MANIFEST);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepEqual(result.manifest, VALID_MANIFEST);
});

test("minimal manifest (required fields only) is accepted", () => {
  const result = validateManifest({
    id: "a.b",
    name: "Minimal",
    version: "0.1.0",
    entry: "p.js",
  });
  assert.equal(result.ok, true);
});

test("missing id is rejected", () => {
  const errors = expectInvalid(omit(VALID_MANIFEST, "id"));
  assert.ok(errors.some((e) => e.includes("'id' is required")));
});

test("missing name is rejected", () => {
  const errors = expectInvalid(omit(VALID_MANIFEST, "name"));
  assert.ok(errors.some((e) => e.includes("'name' is required")));
});

test("missing version is rejected", () => {
  const errors = expectInvalid(omit(VALID_MANIFEST, "version"));
  assert.ok(errors.some((e) => e.includes("'version' is required")));
});

test("missing entry is rejected", () => {
  const errors = expectInvalid(omit(VALID_MANIFEST, "entry"));
  assert.ok(errors.some((e) => e.includes("'entry' is required")));
});

test("non-semantic version is rejected", () => {
  for (const version of ["1.0", "1.0.0.0", "v1.0.0", "01.0.0", "latest"]) {
    const errors = expectInvalid({ ...VALID_MANIFEST, version });
    assert.ok(
      errors.some((e) => e.includes("'version' must be a semantic version")),
      `version ${version} should be rejected`,
    );
  }
});

test("valid semantic versions with pre-release and build metadata are accepted", () => {
  for (const version of ["1.0.0", "10.20.30", "1.0.0-beta.1", "1.0.0+build.5"]) {
    const result = validateManifest({ ...VALID_MANIFEST, version });
    assert.equal(result.ok, true, `version ${version} should be accepted`);
  }
});

test("invalid id formats are rejected", () => {
  for (const id of ["Example.Source", "example/source", ".leading", "trailing.", "example..source", ""]) {
    const errors = expectInvalid({ ...VALID_MANIFEST, id });
    assert.ok(
      errors.some((e) => e.includes("'id'")),
      `id ${JSON.stringify(id)} should be rejected`,
    );
  }
});

test("non-string id is rejected", () => {
  const errors = expectInvalid({ ...VALID_MANIFEST, id: 42 });
  assert.ok(errors.some((e) => e.includes("'id'")));
});

test("invalid domains (not an array) are rejected", () => {
  const errors = expectInvalid({ ...VALID_MANIFEST, domains: "example.com" });
  assert.ok(errors.some((e) => e.includes("'domains' must be an array of strings")));
});

test("invalid domains (non-string member) are rejected", () => {
  const errors = expectInvalid({ ...VALID_MANIFEST, domains: ["example.com", 7] });
  assert.ok(errors.some((e) => e.includes("'domains[1]'")));
});

test("invalid domains (empty string member) are rejected", () => {
  const errors = expectInvalid({ ...VALID_MANIFEST, domains: [""] });
  assert.ok(errors.some((e) => e.includes("'domains[0]'")));
});

test("path traversal entry ('../outside.js') is rejected", () => {
  const errors = expectInvalid({ ...VALID_MANIFEST, entry: "../outside.js" });
  assert.ok(errors.some((e) => e.includes("path traversal")));
});

test("nested path traversal entry ('sub/../../outside.js') is rejected", () => {
  const errors = expectInvalid({ ...VALID_MANIFEST, entry: "sub/../../outside.js" });
  assert.ok(errors.some((e) => e.includes("path traversal")));
});

test("absolute entry path is rejected", () => {
  const errors = expectInvalid({ ...VALID_MANIFEST, entry: "/etc/passwd" });
  assert.ok(
    errors.some((e) => e.includes("'entry' must be relative to the plugin directory")),
  );
});

test("backslash entry is rejected", () => {
  const errors = expectInvalid({ ...VALID_MANIFEST, entry: "sub\\plugin.js" });
  assert.ok(errors.some((e) => e.includes("forward slashes")));
});

test("non-object input is rejected", () => {
  for (const input of [null, undefined, "manifest", 42, ["array"]]) {
    const errors = expectInvalid(input);
    assert.ok(errors.some((e) => e.includes("expected a JSON object")));
  }
});

test("unknown fields are rejected", () => {
  const errors = expectInvalid({ ...VALID_MANIFEST, dangerous: true });
  assert.ok(errors.some((e) => e.includes("unknown field 'dangerous'")));
});

test("multiple problems are all reported and understandable", () => {
  const errors = expectInvalid({
    name: 123,
    version: "not-a-version",
    entry: "../outside.js",
  });
  // Missing id, missing valid name, invalid version, traversal entry.
  assert.ok(errors.length >= 4, `expected >= 4 errors, got: ${errors.join(" | ")}`);
  for (const error of errors) {
    assert.ok(error.startsWith("Plugin manifest:"), error);
  }
  assert.ok(errors.some((e) => e.includes("'id' is required")));
  assert.ok(errors.some((e) => e.includes("'name'")));
  assert.ok(errors.some((e) => e.includes("'version'")));
  assert.ok(errors.some((e) => e.includes("path traversal")));
});
