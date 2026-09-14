/**
 * Phase 6 — normalized source result pipeline: guest-level integration
 * tests.
 *
 * Verifies the full contract end to end:
 *   plugin (QuickJS) does HTTP → HTML/JSON parse → transform → returns
 *   RAW structured results; the engine's normalizeSourceResults turns
 *   that untrusted raw output into trusted normalized SourceResult[].
 * All network tests use a LOCAL server (127.0.0.1, ephemeral port).
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";

import { normalizeSourceResults, type SourceResult } from "../src/index.js";
import { PluginRuntime } from "../src/runtime.js";
import type { Plugin } from "../src/types.js";
/**
 * Pipeline fixtures are served from a LOCAL server on 127.0.0.1. The
 * engine's DEFAULT network policy blocks loopback/private/link-local
 * targets (SSRF defence — see src/network.ts), so the test host opts in
 * explicitly. A plugin can never grant itself this permission.
 */
const ALLOW_LOCAL = { allowPrivateNetwork: true } as const;


// ---------------------------------------------------------------------------
// Local test server
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;

function baseUrlOf(): string {
  return baseUrl;
}

async function startTestServer(): Promise<void> {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.on("error", () => {});
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    if (p === "/catalog") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<div id="catalog">' +
          '<article class="movie" data-id="m-1" data-title="Alpha Movie" data-year="2019">' +
          '<a class="link" href="/watch/m-1">watch</a>' +
          '<img class="thumb" src="/img/m-1.jpg" alt="">' +
          "</article>" +
          '<article class="movie" data-id="m-2" data-title="Beta Movie" data-year="2021">' +
          '<a class="link" href="/watch/m-2">watch</a>' +
          '<img class="thumb" src="/img/m-2.jpg" alt="">' +
          "</article>" +
          "</div>",
      );
    } else if (p === "/api/movies") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          movies: [
            { id: "j-1", title: "Json Movie", year: 2020, trailer: "https://example.com/t/j-1.mp4" },
          ],
        }),
      );
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (typeof addr === "object" && addr !== null) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
}

before(async () => {
  await startTestServer();
});
after(async () => {
  await new Promise<void>((resolve) => {
    if (!server) resolve();
    else server.close(() => resolve());
  });
});

// ---------------------------------------------------------------------------
// Plugin helpers
// ---------------------------------------------------------------------------

async function temp(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "spe-p6-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function plugin(base: string, name: string, source: string): Promise<Plugin> {
  const dir = path.join(base, name);
  await mkdir(dir, { recursive: true });
  const manifest = {
    id: `t.${name}`,
    name,
    version: "1.0.0",
    entry: "plugin.js",
  };
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(dir, "plugin.js"), source);
  return {
    pluginPath: dir,
    manifest,
    entryPath: path.join(dir, "plugin.js"),
    status: "loaded",
  };
}

async function runRaw(
  t: TestContext,
  source: string,
  name: string,
  operation: string,
  args: unknown[] = [],
): Promise<unknown> {
  const base = await temp(t);
  const p = await plugin(base, name, source);
  const runtime = new PluginRuntime({ http: { network: ALLOW_LOCAL } });
  t.after(() => runtime.shutdown());
  const loaded = await runtime.loadPlugin(p);
  assert.equal(loaded.ok, true, "plugin must load");
  if (!loaded.ok) throw new Error("unreachable");
  const result = await runtime.execute(loaded.plugin, operation, args);
  assert.equal(
    result.success,
    true,
    result.success ? "" : `capability failed: ${result.error.type}: ${result.error.message}`,
  );
  return result.success ? result.value : null;
}

// ---------------------------------------------------------------------------
// Integration: HTTP -> HTML -> raw results -> normalize
// ---------------------------------------------------------------------------

test("pipeline: HTML catalog -> raw results -> normalized source results", async (t) => {
  const raw = await runRaw(
    t,
    `export const plugin = {
      search: async (url, context) => {
        const res = await context.http.get(url);
        const doc = await context.html.parse(res.body);
        const items = await context.html.select(doc, "#catalog .movie");
        // The plugin returns RAW structured results — the engine will
        // validate and normalize them.
        const mapped = [];
        for (const el of items) {
          const info = await context.html.extract(el);
          const link = await context.html.select(el, "a.link");
          const linkInfo = link.length > 0 ? await context.html.extract(link[0]) : null;
          const thumb = await context.html.select(el, "img.thumb");
          const thumbInfo = thumb.length > 0 ? await context.html.extract(thumb[0]) : null;
          mapped.push({
            id: info.data.id,
            title: info.data.title,
            type: "movie",
            url: "http://example.com" + (linkInfo && linkInfo.href ? linkInfo.href : ""),
            thumbnail: "http://example.com" + (thumbInfo && thumbInfo.src ? thumbInfo.src : ""),
            source: "catalog-test",
            quality: "1080p",
            language: "en",
            metadata: { year: Number(info.data.year) },
            subtitles: [],
          });
        }
        return mapped;
      },
    };`,
    "p6html",
    "search",
    [`${baseUrlOf()}/catalog`],
  );

  // The raw value is a plain array (JSON-dumped out of the guest).
  assert.ok(Array.isArray(raw), "raw result is an array");
  const out = normalizeSourceResults(raw);
  assert.equal(out.ok, true, out.ok ? "" : JSON.stringify(out.error));
  if (!out.ok) throw new Error("unreachable");

  assert.equal(out.results.length, 2);
  const [first, second] = out.results;
  assert.ok(first && second, "two results");
  assert.equal(first.id, "m-1");
  assert.equal(first.title, "Alpha Movie");
  assert.equal(first.type, "movie");
  assert.equal(first.url, "http://example.com/watch/m-1");
  assert.equal(first.thumbnail, "http://example.com/img/m-1.jpg");
  assert.equal(first.source, "catalog-test");
  assert.equal(first.quality, "1080p");
  assert.equal(first.language, "en");
  assert.deepEqual(first.metadata, { year: 2019 });
  assert.equal(second.id, "m-2");
  assert.equal(second.title, "Beta Movie");
});

test("pipeline: JSON API -> raw results -> normalized (single object input)", async (t) => {
  const raw = await runRaw(
    t,
    `export const plugin = {
      getMovie: async (url, context) => {
        const res = await context.http.get(url);
        const data = context.json.parse(res.body);
        const m = data.movies[0];
        // A single result object (not an array) is a valid raw return.
        return {
          id: m.id,
          title: m.title,
          type: "movie",
          url: "https://example.com/watch/" + m.id,
          metadata: { year: m.year },
        };
      },
    };`,
    "p6json",
    "getMovie",
    [`${baseUrlOf()}/api/movies`],
  );

  const out = normalizeSourceResults(raw);
  assert.equal(out.ok, true, out.ok ? "" : JSON.stringify(out.error));
  if (!out.ok) throw new Error("unreachable");
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0]?.id, "j-1");
  assert.equal(out.results[0]?.title, "Json Movie");
  assert.equal(out.results[0]?.url, "https://example.com/watch/j-1");
  assert.deepEqual(out.results[0]?.metadata, { year: 2020 });
});

// ---------------------------------------------------------------------------
// Security: malicious plugin output stays untrusted
// ---------------------------------------------------------------------------

test("security: malicious raw output is rejected by normalization (not by execute)", async (t) => {
  // The plugin deliberately returns "bad" raw results. execute() must
  // still succeed (it returns raw data); normalizeSourceResults is the
  // gate that rejects the untrusted values.
  const raw = await runRaw(
    t,
    `export const plugin = {
      evil: (context) => {
        return [
          {
            id: "e-1",
            title: "Evil",
            type: "movie",
            url: "javascript:alert('xss')",
            metadata: { "__proto__": { polluted: true } },
          },
        ];
      },
    };`,
    "p6evil",
    "evil",
  );
  const out = normalizeSourceResults(raw);
  assert.equal(out.ok, false);
  if (out.ok) throw new Error("unreachable");
  assert.equal(out.error.code, "RESULT_INVALID_URL");
  // Object.prototype must remain clean.
  assert.equal(({} as Record<string, unknown>).polluted, undefined);

  // A second malicious shape: prototype-pollution metadata first.
  const raw2 = await runRaw(
    t,
    `export const plugin = {
      evil2: (context) => {
        return [
          {
            id: "e-2",
            title: "Evil 2",
            type: "source",
            url: "https://example.com/ok",
            metadata: { constructor: "override" },
          },
        ];
      },
    };`,
    "p6evil2",
    "evil2",
  );
  const out2 = normalizeSourceResults(raw2);
  assert.equal(out2.ok, false);
  if (!out2.ok) {
    assert.equal(out2.error.code, "RESULT_INVALID");
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("security: huge raw output from the guest is rejected cleanly", async (t) => {
  const raw = await runRaw(
    t,
    `export const plugin = {
      huge: (context) => {
        return {
          id: "h-1",
          title: "a".repeat(10 * 1024 * 1024),
          type: "source",
          url: "https://example.com/h",
        };
      },
    };`,
    "p6huge",
    "huge",
  );
  const out = normalizeSourceResults(raw);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.error.code, "RESULT_FIELD_TOO_LONG");
  }
});

// ---------------------------------------------------------------------------
// Regression: a plain (non-source) capability result still flows through
// execute() untouched — normalization is opt-in at the app layer.
// ---------------------------------------------------------------------------

test("regression: non-source results pass through execute() unchanged", async (t) => {
  const raw = await runRaw(
    t,
    `export const plugin = {
      whatever: (context) => ({ arbitrary: ["shape", { nested: true }], n: 1 }),
    };`,
    "p6plain",
    "whatever",
  );
  assert.deepEqual(raw, { arbitrary: ["shape", { nested: true }], n: 1 });
  // Normalizing that arbitrary shape is REJECTED (it is not a result).
  const out = normalizeSourceResults(raw);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.error.code, "RESULT_INVALID");
});

test("regression: normalized results are deep JSON-serializable", async (t) => {
  const raw = await runRaw(
    t,
    `export const plugin = {
      jsonsafe: (context) => [
        {
          id: "s-1",
          title: "Safe",
          type: "search",
          url: "https://example.com/s",
          metadata: { a: 1, b: "two", c: true },
          subtitles: [{ url: "https://example.com/s.srt", language: "en" }],
        },
      ],
    };`,
    "p6safe",
    "jsonsafe",
  );
  const out = normalizeSourceResults(raw);
  assert.equal(out.ok, true, out.ok ? "" : JSON.stringify(out.error));
  if (!out.ok) throw new Error("unreachable");
  const reserialized = JSON.parse(JSON.stringify(out.results)) as SourceResult[];
  assert.deepEqual(reserialized, out.results);
});
