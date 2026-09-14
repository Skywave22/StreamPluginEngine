import assert from "node:assert/strict";
import { test } from "node:test";

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
  assert.equal(ENGINE_PHASE, 5);
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
