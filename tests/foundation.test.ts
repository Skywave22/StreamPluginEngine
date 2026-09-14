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
} from "../src/index.js";

test("foundation compiles and exports engine identity", () => {
  assert.equal(ENGINE_NAME, "stream-plugin-engine");
  assert.equal(ENGINE_VERSION, "0.1.0");
  assert.equal(ENGINE_PHASE, 4);
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
