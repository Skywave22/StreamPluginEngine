/**
 * Phase 6 — normalized source result pipeline: host-level unit tests.
 *
 * Covers the spec checklist: validation (required fields, types, empty
 * values, malformed/unsupported URLs, oversized fields, too many
 * results), normalization (trimming, URL canonicalization, duplicates,
 * consistent output), and security (prototype pollution, strange
 * objects, unexpected types, huge values).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RESULT_ERROR_CODES,
  RESULT_LIMITS,
  SOURCE_RESULT_TYPES,
  normalizeSourceResults,
  type SourceResult,
} from "../src/index.js";

// --- helpers ----------------------------------------------------------------

function validResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "res-1",
    title: "Example Title",
    type: "movie",
    url: "https://example.com/watch/res-1",
    ...overrides,
  };
}

function ok(value: unknown): SourceResult[] {
  const out = normalizeSourceResults(value);
  assert.equal(out.ok, true, out.ok ? "ok" : `expected ok, got ${JSON.stringify(out.error)}`);
  if (!out.ok) throw new Error("unreachable");
  return out.results;
}

function rejected(value: unknown, code?: string): { code: string; message: string } {
  const out = normalizeSourceResults(value);
  assert.equal(out.ok, false, "expected a rejection");
  if (out.ok) throw new Error("unreachable");
  if (code) assert.equal(out.error.code, code);
  return out.error;
}

// --- validation: required fields & types -------------------------------------

test("validation: a valid single result and a valid array pass", () => {
  const single = ok(validResult());
  assert.equal(single.length, 1);
  assert.deepEqual(single[0], {
    id: "res-1",
    title: "Example Title",
    type: "movie",
    url: "https://example.com/watch/res-1",
    metadata: {},
  });

  const many = ok([validResult(), validResult({ id: "res-2", title: "Two" })]);
  assert.equal(many.length, 2);
});

test("validation: each required field is enforced", () => {
  for (const field of ["id", "title", "type", "url"]) {
    const r = validResult();
    delete r[field];
    const err = rejected(r, "RESULT_INVALID");
    assert.ok(err.message.includes(`'${field}'`), `message names field: ${err.message}`);
  }
});

test("validation: wrong types are rejected", () => {
  rejected(validResult({ id: 42 }), "RESULT_INVALID");
  rejected(validResult({ title: null }), "RESULT_INVALID");
  rejected(validResult({ type: "video" }), "RESULT_INVALID");
  rejected(validResult({ type: 7 }), "RESULT_INVALID");
  rejected(validResult({ url: ["https://example.com"] }), "RESULT_INVALID");
  rejected(validResult({ url: 123 }), "RESULT_INVALID");
  // Items that are not plain objects.
  rejected(42, "RESULT_INVALID_INPUT");
  rejected("not an object", "RESULT_INVALID_INPUT");
  rejected(null, "RESULT_INVALID_INPUT");
  rejected(undefined, "RESULT_INVALID_INPUT");
  rejected([validResult(), "garbage"], "RESULT_INVALID_INPUT");
  rejected([{ id: "x" }], "RESULT_INVALID"); // item missing fields
});

test("validation: empty (whitespace-only) required strings are rejected", () => {
  rejected(validResult({ id: "   " }), "RESULT_INVALID");
  rejected(validResult({ title: "\t\n" }), "RESULT_INVALID");
  rejected(validResult({ url: "  " }), "RESULT_INVALID");
});

test("validation: all source result types are accepted", () => {
  for (const type of SOURCE_RESULT_TYPES) {
    const results = ok(validResult({ type }));
    assert.equal(results[0]?.type, type);
  }
});

// --- validation: URLs ---------------------------------------------------------

test("validation: malformed URLs are rejected", () => {
  rejected(validResult({ url: "/relative/path" }), "RESULT_INVALID_URL");
  rejected(validResult({ url: "not a url" }), "RESULT_INVALID_URL");
  rejected(validResult({ url: "http://" }), "RESULT_INVALID_URL");
  rejected(validResult({ url: "example.com/watch" }), "RESULT_INVALID_URL");
});

test("validation: unsupported protocols are rejected", () => {
  rejected(validResult({ url: "javascript:alert(1)" }), "RESULT_INVALID_URL");
  rejected(validResult({ url: "ftp://example.com/x" }), "RESULT_INVALID_URL");
  rejected(validResult({ url: "file:///etc/passwd" }), "RESULT_INVALID_URL");
  rejected(validResult({ url: "data:text/plain,hi" }), "RESULT_INVALID_URL");
  rejected(validResult({ url: "node:process" }), "RESULT_INVALID_URL");
  const err = rejected(validResult({ url: "javascript:alert(1)" }), "RESULT_INVALID_URL");
  assert.ok(/protocol/.test(err.message));
});

test("validation: optional thumbnail URLs are dropped when invalid, not fatal", () => {
  const results = ok(validResult({ thumbnail: "javascript:alert(1)" }));
  assert.equal(results[0]?.thumbnail, undefined);
  const results2 = ok(validResult({ thumbnail: " https://example.com/t.png " }));
  assert.equal(results2[0]?.thumbnail, "https://example.com/t.png");
});

// --- validation: limits --------------------------------------------------------

test("validation: oversized required string fields are rejected", () => {
  rejected(validResult({ id: "x".repeat(RESULT_LIMITS.maxIdLength + 1) }), "RESULT_FIELD_TOO_LONG");
  rejected(validResult({ title: "x".repeat(RESULT_LIMITS.maxTitleLength + 1) }), "RESULT_FIELD_TOO_LONG");
  rejected(validResult({ url: "https://example.com/" + "x".repeat(RESULT_LIMITS.maxUrlLength) }), "RESULT_FIELD_TOO_LONG");
  // At the limit exactly is allowed.
  const atLimit = ok(validResult({ id: "x".repeat(RESULT_LIMITS.maxIdLength) }));
  assert.equal(atLimit[0]?.id.length, RESULT_LIMITS.maxIdLength);
});

test("validation: oversized OPTIONAL string fields are dropped, not fatal", () => {
  const results = ok(
    validResult({
      source: "x".repeat(RESULT_LIMITS.maxSourceLength + 1),
      quality: "x".repeat(RESULT_LIMITS.maxQualityLength + 1),
      language: "x".repeat(RESULT_LIMITS.maxLanguageLength + 1),
    }),
  );
  assert.equal(results.length, 1);
  const r = results[0] as unknown as Record<string, unknown>;
  assert.ok(!("source" in r), "oversized source dropped");
  assert.ok(!("quality" in r), "oversized quality dropped");
  assert.ok(!("language" in r), "oversized language dropped");
});

test("validation: too many results is rejected", () => {
  const items = Array.from({ length: RESULT_LIMITS.maxResults + 1 }, (_, i) =>
    validResult({ id: `id-${i}` }),
  );
  rejected(items, "RESULT_TOO_MANY_RESULTS");
  // At the limit exactly is allowed.
  const atLimit = Array.from({ length: 5 }, (_, i) => validResult({ id: `id-${i}` }));
  assert.equal(ok(atLimit).length, 5);
});

test("validation: metadata shape and limits", () => {
  // Valid metadata.
  const results = ok(
    validResult({ metadata: { year: 2020, hd: true, tags: "action", pi: 3.5 } }),
  );
  assert.deepEqual(results[0]?.metadata, { year: 2020, hd: true, tags: "action", pi: 3.5 });

  // Wrong value types.
  rejected(validResult({ metadata: { nested: { a: 1 } } }), "RESULT_INVALID");
  rejected(validResult({ metadata: { list: [1] } }), "RESULT_INVALID");
  rejected(validResult({ metadata: { nothing: null } }), "RESULT_INVALID");
  rejected(validResult({ metadata: { nan: Number.NaN } }), "RESULT_INVALID");
  rejected(validResult({ metadata: { inf: Infinity } }), "RESULT_INVALID");
  rejected(validResult({ metadata: "not-an-object" }), "RESULT_METADATA_TOO_LARGE");

  // Size limits.
  rejected(
    validResult({ metadata: { key: "x".repeat(RESULT_LIMITS.maxMetadataValueLength + 1) } }),
    "RESULT_METADATA_TOO_LARGE",
  );
  const longKey: Record<string, number> = {};
  longKey["k".repeat(RESULT_LIMITS.maxMetadataKeyLength + 1)] = 1;
  rejected(validResult({ metadata: longKey }), "RESULT_METADATA_TOO_LARGE");
  const manyKeys: Record<string, number> = {};
  for (let i = 0; i < RESULT_LIMITS.maxMetadataKeys + 1; i++) manyKeys[`k${i}`] = i;
  rejected(validResult({ metadata: manyKeys }), "RESULT_METADATA_TOO_LARGE");
  const big: Record<string, string> = {};
  for (let i = 0; i < 30; i++) big[`k${i}`] = "v".repeat(300);
  rejected(validResult({ metadata: big }), "RESULT_METADATA_TOO_LARGE");
});

test("validation: subtitles", () => {
  rejected(validResult({ subtitles: "nope" }), "RESULT_INVALID");
  const tooMany = Array.from({ length: RESULT_LIMITS.maxSubtitles + 1 }, () => ({
    url: "https://example.com/sub.srt",
  }));
  rejected(validResult({ subtitles: tooMany }), "RESULT_FIELD_TOO_LONG");

  // Valid subtitles; invalid entries are dropped (not fatal).
  const results = ok(
    validResult({
      subtitles: [
        { url: " https://example.com/sub.srt ", language: "en", format: "srt" },
        { url: "javascript:alert(1)" }, // dropped
        { language: "de" }, // dropped (no url)
        "garbage", // dropped
        { url: "https://example.com/sub2.vtt", format: "x".repeat(60) }, // format dropped (too long)
      ],
    }),
  );
  assert.deepEqual(results[0]?.subtitles, [
    { url: "https://example.com/sub.srt", language: "en", format: "srt" },
    { url: "https://example.com/sub2.vtt" },
  ]);
});

// --- normalization --------------------------------------------------------------

test("normalization: strings are trimmed", () => {
  const results = ok(
    validResult({
      id: "  res-1  ",
      title: "   Padded Title  ",
      source: "  Example Source ",
      quality: " 1080p ",
      language: " en ",
    }),
  );
  assert.equal(results[0]?.id, "res-1");
  assert.equal(results[0]?.title, "Padded Title");
  assert.equal(results[0]?.source, "Example Source");
  assert.equal(results[0]?.quality, "1080p");
  assert.equal(results[0]?.language, "en");
});

test("normalization: URLs are canonicalized", () => {
  const results = ok(
    validResult({
      url: "HTTP://Example.COM:80/watch/RES-1",
      thumbnail: "https://example.com/a/../b/t.png",
    }),
  );
  assert.equal(results[0]?.url, "http://example.com/watch/RES-1");
  assert.equal(results[0]?.thumbnail, "https://example.com/b/t.png");
});

test("normalization: duplicate ids keep the first occurrence", () => {
  const results = ok([
    validResult({ id: "dup", title: "First" }),
    validResult({ id: "dup", title: "Second" }),
    validResult({ id: "other", title: "Other" }),
  ]);
  assert.equal(results.length, 2);
  assert.equal(results[0]?.title, "First");
  assert.equal(results[1]?.title, "Other");
});

test("normalization: consistent output shape", () => {
  const results = ok(validResult({ source: "", quality: null, language: 42 }));
  const r = results[0];
  assert.ok(r, "one result");
  // Always an array from the caller's perspective; metadata always present.
  assert.ok(Array.isArray(results));
  assert.deepEqual(r.metadata, {});
  // Invalid/empty optional values are absent (not undefined-valued).
  assert.ok(!("source" in r), "empty source dropped");
  assert.ok(!("quality" in r), "wrong-type quality dropped");
  assert.ok(!("language" in r), "wrong-type language dropped");
  assert.ok(!("subtitles" in r), "no subtitles key when empty");
  // Unknown fields are dropped.
  assert.ok(!("evil" in r));
});

test("normalization: empty array is a valid empty result set", () => {
  const out = normalizeSourceResults([]);
  assert.deepEqual(out, { ok: true, results: [] });
});

// --- security -------------------------------------------------------------------

test("security: prototype-pollution metadata keys are rejected", () => {
  const before = ({} as Record<string, unknown>).polluted;
  const raw = validResult();
  raw.metadata = JSON.parse('{"__proto__": {"polluted": true}}');
  rejected(raw, "RESULT_INVALID");
  const raw2 = validResult({ metadata: { constructor: { x: 1 } } });
  rejected(raw2, "RESULT_INVALID");
  const raw3 = validResult({ metadata: { prototype: "x" } });
  rejected(raw3, "RESULT_INVALID");
  // Object.prototype must be untouched.
  assert.equal(({} as Record<string, unknown>).polluted, before);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("security: strange objects do not break the pipeline", () => {
  // Circular raw item (circular reference in an unknown field is ignored).
  const circular: Record<string, unknown> = {
    id: "c1",
    title: "Circular",
    type: "source",
    url: "https://example.com/c1",
  };
  circular.self = circular;
  const results = ok(circular);
  assert.equal(results[0]?.id, "c1");
  assert.ok(!("self" in (results[0] as unknown as Record<string, unknown>)));

  // A value that is a function (host-level call with arbitrary values).
  rejected(
    validResult({ title: (() => "boom") as unknown as string }),
    "RESULT_INVALID",
  );

  // A Date object as a field value.
  rejected(validResult({ id: new Date() }), "RESULT_INVALID");

  // A huge string fails fast on the length check (no deep copy).
  rejected(validResult({ title: "a".repeat(10 * 1024 * 1024) }), "RESULT_FIELD_TOO_LONG");
});

test("security: the raw input object is never mutated", () => {
  const input = validResult({ metadata: { a: 1 }, quality: " 720p " });
  ok(input);
  assert.equal(input.quality, " 720p ");
  assert.deepEqual(input.metadata, { a: 1 });
});

// --- constants --------------------------------------------------------------------

test("stress: exactly maxResults valid results pass, and stay fast/bounded", () => {
  // The upper bound of the result pipeline under a legitimate maximum
  // load (deterministic; no timing assertion — only correctness).
  const items = Array.from({ length: RESULT_LIMITS.maxResults }, (_, i) => ({
    id: `id-${i}`,
    title: `Title ${i}`,
    type: "search",
    url: `https://example.com/item/${i}`,
    metadata: { rank: i },
  }));
  const results = ok(items);
  assert.equal(results.length, RESULT_LIMITS.maxResults);
  assert.equal(results[0]?.id, "id-0");
  assert.equal(results[RESULT_LIMITS.maxResults - 1]?.id, `id-${RESULT_LIMITS.maxResults - 1}`);
  assert.equal(results[0]?.metadata.rank, 0);
});

test("constants: limits and error codes are coherent", () => {
  assert.ok(RESULT_LIMITS.maxResults > 0);
  assert.ok(RESULT_LIMITS.maxIdLength > 0);
  assert.ok(RESULT_LIMITS.maxTitleLength > 0);
  assert.ok(RESULT_LIMITS.maxUrlLength > 0);
  assert.ok(RESULT_LIMITS.maxMetadataBytes > 0);
  assert.ok(RESULT_LIMITS.maxSubtitles > 0);
  assert.equal(new Set(RESULT_ERROR_CODES).size, RESULT_ERROR_CODES.length);
  assert.equal(SOURCE_RESULT_TYPES.length, 5);
});
