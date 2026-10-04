/**
 * v0.3.0 app-readiness: playback metadata on results.
 *
 * `format` (closed enum) and `headers` (result-level and subtitle-level)
 * are what an APPLICATION needs to hand a resolved URL to a player. The
 * engine treats them as UNTRUSTED and validates them like request
 * headers, because a player will actually use them — unlike every other
 * field in the model, which is inert data.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RESULT_LIMITS,
  SOURCE_RESULT_FORMATS,
  normalizeSourceResults,
} from "../src/results.js";
import type { SourceResult } from "../src/results.js";

/** Minimal valid result with an override map. */
function raw(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "r1",
    title: "Result",
    type: "source",
    url: "https://cdn.example/video.m3u8",
    ...extra,
  };
}

function ok(value: unknown): SourceResult {
  const result = normalizeSourceResults(value);
  assert.ok(result.ok, result.ok ? "" : JSON.stringify(result.error));
  assert.equal(result.results.length, 1);
  const first = result.results[0];
  assert.ok(first);
  return first;
}

test("format: the enum is exported and documented values survive", () => {
  assert.ok(Array.isArray(SOURCE_RESULT_FORMATS));
  assert.ok(SOURCE_RESULT_FORMATS.includes("m3u8"));
  for (const format of SOURCE_RESULT_FORMATS) {
    assert.equal(ok(raw({ format })).format, format);
  }
});

test("format: normalisation is case-insensitive; unknown values are dropped", () => {
  assert.equal(ok(raw({ format: "M3U8" })).format, "m3u8");
  assert.equal(ok(raw({ format: "  1080p " })).format, undefined);
  assert.equal(ok(raw({ format: "avi" })).format, undefined);
  assert.equal(ok(raw({ format: 42 })).format, undefined);
  assert.equal(ok(raw()).format, undefined);
});

test("headers: valid playback headers survive and are copied", () => {
  const input = raw({
    headers: {
      Referer: "https://site.example/watch/1",
      "User-Agent": "Mozilla/5.0",
      "X-Custom": "value",
    },
  });
  const result = ok(input);
  assert.deepEqual(result.headers, {
    Referer: "https://site.example/watch/1",
    "User-Agent": "Mozilla/5.0",
    "X-Custom": "value",
  });
  // Copied, not aliased.
  assert.notEqual(result.headers, input.headers);
});

test("headers: hop-by-hop and request-forging names are dropped", () => {
  const result = ok(
    raw({
      headers: {
        Referer: "https://ok.example/",
        Host: "evil.example",
        "content-length": "999",
        Connection: "keep-alive",
        "Transfer-Encoding": "chunked",
        Upgrade: "h2c",
        TE: "trailers",
        Trailer: "x",
        "Proxy-Connection": "keep-alive",
      },
    }),
  );
  assert.deepEqual(result.headers, { Referer: "https://ok.example/" });
});

test("headers: CR/LF/NUL injection and non-token names are dropped", () => {
  const injected = "https://ok.example/\r\nX-Evil: 1";
  const result = ok(
    raw({
      headers: {
        Referer: injected,
        "X-Ok": "fine",
        "bad name": "space in name",
        "": "empty name",
      },
    }),
  );
  assert.deepEqual(result.headers, { "X-Ok": "fine" });

  // A NUL byte is rejected too.
  const withNul = ok(raw({ headers: { "X-Nul": "a\0b", "X-Keep": "yes" } }));
  assert.deepEqual(withNul.headers, { "X-Keep": "yes" });
});

test("headers: prototype-polluting keys are never copied", () => {
  const headers = JSON.parse(
    '{"__proto__":"polluted","constructor":"x","prototype":"y","X-Ok":"1"}',
  ) as Record<string, string>;
  const result = ok(raw({ headers }));
  assert.deepEqual(result.headers, { "X-Ok": "1" });
  // The global prototype must be untouched.
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("headers: oversized values are dropped, an oversized COUNT rejects", () => {
  const longValue = "a".repeat(RESULT_LIMITS.maxHeaderValueLength + 1);
  const dropped = ok(raw({ headers: { "X-Long": longValue, "X-Ok": "1" } }));
  assert.deepEqual(dropped.headers, { "X-Ok": "1" });

  const tooMany: Record<string, string> = {};
  for (let i = 0; i <= RESULT_LIMITS.maxHeaders; i += 1) {
    tooMany[`X-H${i}`] = "v";
  }
  const rejected = normalizeSourceResults(raw({ headers: tooMany }));
  assert.equal(rejected.ok, false);
  assert.ok(!rejected.ok);
  assert.equal(rejected.error.code, "RESULT_FIELD_TOO_LONG");
  assert.match(rejected.error.message, /'headers'/);
});

test("headers: wrong-typed containers are dropped, not fatal", () => {
  for (const headers of ["Referer: x", 42, [], true]) {
    assert.equal(ok(raw({ headers })).headers, undefined);
  }
  // Every entry invalid → the field itself disappears.
  assert.equal(ok(raw({ headers: { Host: "x" } })).headers, undefined);
});

test("subtitles: name and per-subtitle headers are preserved", () => {
  const result = ok(
    raw({
      subtitles: [
        {
          url: "https://subs.example/en.vtt",
          language: "en",
          name: "English (SDH)",
          format: "vtt",
          headers: { Referer: "https://subs.example/", Host: "evil" },
        },
        { url: "not-a-url", name: "dropped" },
      ],
    }),
  );
  assert.equal(result.subtitles?.length, 1);
  const sub = result.subtitles?.[0];
  assert.ok(sub);
  assert.equal(sub.name, "English (SDH)");
  assert.equal(sub.format, "vtt");
  assert.deepEqual(sub.headers, { Referer: "https://subs.example/" });
});

test("a full app-shaped result round-trips (format + headers + subtitles)", () => {
  const result = ok(
    raw({
      id: "movie-1",
      title: "Example Movie",
      type: "movie",
      quality: "1080p",
      language: "en",
      format: "mpd",
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://provider.example/",
      },
      subtitles: [{ url: "https://subs.example/en.srt", language: "en" }],
      metadata: { size: 1_234_567, hdr: true },
    }),
  );
  assert.equal(result.format, "mpd");
  assert.equal(result.headers?.Referer, "https://provider.example/");
  assert.equal(result.subtitles?.length, 1);
  assert.equal(result.metadata.size, 1_234_567);
  // Everything stays JSON-serializable (it crosses process/UI boundaries).
  assert.equal(typeof JSON.stringify(result), "string");
});

test("isLive is accepted only as a real boolean", () => {
  // True marks a continuous stream: no resume position, no downloads.
  assert.equal(ok(raw({ isLive: true })).isLive, true);
  assert.equal(ok(raw({ isLive: false })).isLive, false);

  // Anything else is DROPPED, not coerced: an application branches on
  // this field, so "true", 1 and {} must not become truthy.
  for (const value of ["true", 1, 0, {}, [], null, "yes"]) {
    const result = ok(raw({ isLive: value }));
    assert.equal(
      result.isLive,
      undefined,
      `isLive must be dropped for ${JSON.stringify(value)}`,
    );
    assert.ok(!("isLive" in result), "the key must be absent, not undefined");
  }

  // A live HLS channel, as a plugin would return it.
  const live = ok(
    raw({
      id: "channel-1",
      title: "Sports Channel HD",
      type: "source",
      url: "https://cdn.example/live/master.m3u8",
      format: "m3u8",
      isLive: true,
      quality: "1080p",
    }),
  );
  assert.equal(live.isLive, true);
  assert.equal(live.format, "m3u8");
  assert.equal(typeof JSON.stringify(live), "string");
});

test("isLive survives the normalizer in a mixed batch", () => {
  const result = normalizeSourceResults([
    raw({ id: "a", isLive: true }),
    raw({ id: "b" }), // no isLive
    raw({ id: "c", isLive: "nope" }), // dropped
  ]);
  assert.ok(result.ok);
  assert.equal(result.results.find((r) => r.id === "a")?.isLive, true);
  assert.equal(result.results.find((r) => r.id === "b")?.isLive, undefined);
  assert.equal(result.results.find((r) => r.id === "c")?.isLive, undefined);
});
