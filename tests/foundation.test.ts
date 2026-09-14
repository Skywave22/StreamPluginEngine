import assert from "node:assert/strict";
import { test } from "node:test";

import * as engine from "../src/index.js";
import {
  ENGINE_NAME,
  ENGINE_PHASE,
  ENGINE_VERSION,
  HttpClient,
  HttpError,
  DEFAULT_HTTP_LIMITS,
  HTTP_ERROR_CODES,
  PHASE5_LIMITS,
  PHASE5_ERROR_CODES,
} from "../src/index.js";

test("foundation compiles and exports engine identity", () => {
  assert.equal(ENGINE_NAME, "stream-plugin-engine");
  assert.equal(ENGINE_VERSION, "0.1.0");
  // Regression: the engine reports the FINAL phase (Phase 6).
  assert.equal(ENGINE_PHASE, 6);
});

test("Phase 4 HTTP exports are present and coherent", () => {
  assert.equal(typeof HttpClient, "function");
  assert.equal(typeof HttpError, "function");
  assert.ok(DEFAULT_HTTP_LIMITS.maxTimeoutMs > 0);
  assert.ok(DEFAULT_HTTP_LIMITS.maxResponseBytesCap > 0);
  assert.ok(HTTP_ERROR_CODES.includes("HTTP_TIMEOUT"));
  assert.ok(HTTP_ERROR_CODES.includes("HTTP_UNSUPPORTED_SCHEME"));
  const client = new HttpClient();
  assert.equal(client.limits.maxTimeoutMs, DEFAULT_HTTP_LIMITS.maxTimeoutMs);
});

test("Phase 5 JSON/HTML exports are present and coherent", () => {
  assert.ok(PHASE5_LIMITS.maxHtmlBytes > 0);
  assert.ok(PHASE5_LIMITS.maxJsonBytes > 0);
  assert.ok(PHASE5_LIMITS.maxHtmlNodes > 0);
  assert.ok(PHASE5_LIMITS.maxSelectResults > 0);
  for (const code of [
    "JSON_INVALID",
    "JSON_INPUT_TOO_LARGE",
    "JSON_STRINGIFY_ERROR",
    "HTML_INVALID_INPUT",
    "HTML_INPUT_TOO_LARGE",
    "HTML_PARSE_ERROR",
    "HTML_SELECT_ERROR",
    "HTML_EXTRACT_ERROR",
    "HTML_TOO_MANY_RESULTS",
  ] as const) {
    assert.ok(PHASE5_ERROR_CODES.includes(code), `missing code ${code}`);
  }
});

test("Phase 6 result-pipeline exports are present and coherent", () => {
  assert.equal(typeof engine.normalizeSourceResults, "function");
  assert.ok(engine.RESULT_LIMITS.maxResults > 0);
  assert.ok(engine.RESULT_LIMITS.maxUrlLength > 0);
  assert.ok(engine.RESULT_LIMITS.maxMetadataBytes > 0);
  for (const code of [
    "RESULT_INVALID_INPUT",
    "RESULT_INVALID",
    "RESULT_INVALID_URL",
    "RESULT_TOO_MANY_RESULTS",
    "RESULT_FIELD_TOO_LONG",
    "RESULT_METADATA_TOO_LARGE",
  ] as const) {
    assert.ok(engine.RESULT_ERROR_CODES.includes(code), `missing code ${code}`);
  }
  assert.deepEqual(engine.SOURCE_RESULT_TYPES, [
    "movie",
    "episode",
    "series",
    "search",
    "source",
  ]);
  // A quick functional sanity check of the public entry point.
  const out = engine.normalizeSourceResults({
    id: "x",
    title: "T",
    type: "source",
    url: "https://example.com/x",
  });
  assert.equal(out.ok, true);
});

test("public API surface is complete and stable (Phase 1-6)", () => {
  // Phase 1/2: identity, manifest validation, loader, manager.
  assert.equal(typeof engine.validateManifest, "function");
  assert.equal(typeof engine.PluginLoader, "function");
  assert.equal(typeof engine.PluginManager, "function");
  assert.equal(typeof engine.MANIFEST_FILE_NAME, "string");
  // Phase 3: runtime.
  assert.equal(typeof engine.PluginRuntime, "function");
  // Phase 4: HTTP client + limits + codes.
  assert.equal(typeof engine.HttpClient, "function");
  assert.equal(typeof engine.HttpError, "function");
  assert.ok(engine.DEFAULT_HTTP_LIMITS);
  assert.ok(Array.isArray(engine.HTTP_ERROR_CODES));
  // Phase 5: limits, codes, and the pure host helpers.
  assert.ok(engine.PHASE5_LIMITS);
  assert.ok(Array.isArray(engine.PHASE5_ERROR_CODES));
  assert.equal(typeof engine.parseHtml, "function");
  assert.equal(typeof engine.selectHtml, "function");
  assert.equal(typeof engine.extractHtml, "function");
  // Phase 6: result pipeline.
  assert.equal(typeof engine.normalizeSourceResults, "function");
  assert.ok(engine.RESULT_LIMITS);
  assert.ok(Array.isArray(engine.RESULT_ERROR_CODES));
  assert.ok(Array.isArray(engine.SOURCE_RESULT_TYPES));
  // Phase 1 (well-known capability names).
  assert.ok(Array.isArray(engine.KNOWN_CAPABILITIES));
});
