/**
 * Phase 5 — guest-level integration tests.
 *
 * Runs the real PluginRuntime (QuickJS guest) and exercises the
 * context.json / context.html capabilities end to end, including the
 * full pipelines:
 *   HTTP -> HTML -> parse -> select -> extract
 *   HTTP -> JSON -> parse
 * All network tests use a LOCAL server (127.0.0.1, ephemeral port); the
 * suite never depends on the public Internet.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";

import { PluginRuntime } from "../src/runtime.js";
import type { Plugin } from "../src/types.js";

// ---------------------------------------------------------------------------
// Local test server
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;

async function startTestServer(): Promise<void> {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.on("error", () => {});
    const u = new URL(req.url ?? "/", "http://localhost");
    const p = u.pathname;
    if (p === "/page") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<div id="root"><article class="card" data-id="42"><a href="/watch/1">  Movie One </a></article>' +
          '<article class="card"><a href="/watch/2">Movie Two</a></article></div>',
      );
    } else if (p === "/api") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hello: "world", items: [1, 2, 3] }));
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

async function stopTestServer(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (!server) resolve();
    else server.close(() => resolve());
  });
}

// ---------------------------------------------------------------------------
// Plugin helpers
// ---------------------------------------------------------------------------

async function temp(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "spe-p5g-"));
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

async function runCapability(
  t: TestContext,
  source: string,
  name: string,
  operation: string,
  args: unknown[] = [],
): Promise<unknown> {
  const base = await temp(t);
  const p = await plugin(base, name, source);
  const runtime = new PluginRuntime();
  t.after(() => runtime.shutdown());
  const loaded = await runtime.loadPlugin(p);
  assert.equal(loaded.ok, true, "plugin must load");
  if (!loaded.ok) throw new Error("unreachable");
  const result = await runtime.execute(loaded.plugin, operation, args);
  assert.equal(
    result.success,
    true,
    `capability must succeed; got ${result.success ? "ok" : result.error.type + ": " + result.error.message}`,
  );
  return result.success ? result.value : null;
}

// ---------------------------------------------------------------------------
// JSON: structured error contract (caught inside the guest)
// ---------------------------------------------------------------------------

test("json.parse: primitives, arrays, and nested objects round-trip", async (t) => {
  const value = (await runCapability(
    t,
    `export const plugin = {
      run: (context) => {
        const obj = context.json.parse('{"a":1,"b":[true,null,"x"],"c":{"d":"e"}}');
        return {
          a: obj.a,
          bLen: obj.b.length,
          bTrue: obj.b[0],
          bNull: obj.b[1],
          nested: obj.c.d,
          num: context.json.parse('42'),
          str: context.json.parse('"hi"'),
          bool: context.json.parse('false'),
          nullVal: context.json.parse('null'),
        };
      },
    };`,
    "jsonrt",
    "run",
  )) as Record<string, unknown>;
  assert.equal(value.a, 1);
  assert.equal(value.bLen, 3);
  assert.equal(value.bTrue, true);
  assert.equal(value.bNull, null);
  assert.equal(value.nested, "e");
  assert.equal(value.num, 42);
  assert.equal(value.str, "hi");
  assert.equal(value.bool, false);
  assert.equal(value.nullVal, null);
});

test("json.parse: malformed input is a structured JSON_INVALID (caught in guest)", async (t) => {
  const value = (await runCapability(
    t,
    `export const plugin = {
      run: (context) => {
        try {
          context.json.parse('{not json');
          return { handled: true };
        } catch (e) {
          return { handled: false, code: e && e.code, msg: e && e.message };
        }
      },
    };`,
    "jsonbad",
    "run",
  )) as Record<string, unknown>;
  assert.equal(value.handled, false);
  assert.equal(value.code, "JSON_INVALID");
  assert.equal(typeof value.msg, "string");
});

test("json.parse: non-string input is JSON_INVALID_INPUT", async (t) => {
  const value = (await runCapability(
    t,
    `export const plugin = {
      run: (context) => {
        try {
          context.json.parse(123);
          return { handled: true };
        } catch (e) {
          return { handled: false, code: e && e.code };
        }
      },
    };`,
    "jsonnonstring",
    "run",
  )) as Record<string, unknown>;
  assert.equal(value.handled, false);
  assert.equal(value.code, "JSON_INVALID_INPUT");
});

test("json.parse: over-limit input is JSON_INPUT_TOO_LARGE (built in guest)", async (t) => {
  const value = (await runCapability(
    t,
    `export const plugin = {
      run: (context) => {
        // Build a > 5 MiB JSON string inside the guest (no host arg).
        const parts = [];
        for (let i = 0; i < 540; i++) parts.push('"' + "a".repeat(10000) + '",');
        const big = "[" + parts.join("") + "1]";
        try {
          context.json.parse(big);
          return { handled: true };
        } catch (e) {
          return { handled: false, code: e && e.code };
        }
      },
    };`,
    "jsonbig",
    "run",
  )) as Record<string, unknown>;
  assert.equal(value.handled, false);
  assert.equal(value.code, "JSON_INPUT_TOO_LARGE");
});

test("json.stringify: round-trips and rejects unserializable values", async (t) => {
  const value = (await runCapability(
    t,
    `export const plugin = {
      run: (context) => {
        const ok = context.json.stringify({ x: [1, "a", null] });
        let circular = "no";
        let noArg = "no";
        const o = {};
        o.self = o;
        try { context.json.stringify(o); } catch (e) { circular = e && e.code; }
        try { context.json.stringify(); } catch (e) { noArg = e && e.code; }
        return { ok, circular, noArg };
      },
    };`,
    "jsonstr",
    "run",
  )) as Record<string, unknown>;
  assert.equal(value.ok, '{"x":[1,"a",null]}');
  assert.equal(value.circular, "JSON_STRINGIFY_ERROR");
  assert.equal(value.noArg, "JSON_INVALID_INPUT");
});

test("json.stringify: over-limit output is JSON_OUTPUT_TOO_LARGE", async (t) => {
  const value = (await runCapability(
    t,
    `export const plugin = {
      run: (context) => {
        const parts = [];
        for (let i = 0; i < 540; i++) parts.push("a".repeat(10000));
        const big = { s: parts.join("") };
        try {
          context.json.stringify(big);
          return { handled: true };
        } catch (e) {
          return { handled: false, code: e && e.code };
        }
      },
    };`,
    "jsonbigout",
    "run",
  )) as Record<string, unknown>;
  assert.equal(value.handled, false);
  assert.equal(value.code, "JSON_OUTPUT_TOO_LARGE");
});

// ---------------------------------------------------------------------------
// HTML: limits and structured errors (caught inside the guest)
// ---------------------------------------------------------------------------

test("html.parse: non-string input is HTML_INVALID_INPUT", async (t) => {
  const value = (await runCapability(
    t,
    `export const plugin = {
      run: async (context) => {
        try {
          await context.html.parse(123);
          return { handled: true };
        } catch (e) {
          return { handled: false, code: e && e.code };
        }
      },
    };`,
    "htmlnonstring",
    "run",
  )) as Record<string, unknown>;
  assert.equal(value.handled, false);
  assert.equal(value.code, "HTML_INVALID_INPUT");
});

test("html.parse: over-limit HTML is HTML_INPUT_TOO_LARGE", async (t) => {
  // The > 5 MiB string is built inside the guest so the test targets the
  // HTML input cap directly (the HTTP layer has its own 5 MiB response
  // cap and would reject a larger body first).
  const value = (await runCapability(
    t,
    `export const plugin = {
      run: async (context) => {
        const parts = [];
        for (let i = 0; i < 540; i++) parts.push("a".repeat(10000));
        const big = "<p>" + parts.join("") + "</p>";
        try {
          await context.html.parse(big);
          return { handled: true };
        } catch (e) {
          return { handled: false, code: e && e.code };
        }
      },
    };`,
    "htmlbig",
    "run",
  )) as Record<string, unknown>;
  assert.equal(value.handled, false);
  assert.equal(value.code, "HTML_INPUT_TOO_LARGE");
});

test("html.parse: node limit is a structured HTML_PARSE_ERROR", async (t) => {
  const value = (await runCapability(
    t,
    `export const plugin = {
      run: async (context) => {
        const parts = [];
        for (let i = 0; i < 55000; i++) parts.push("<i></i>");
        const big = parts.join("");
        try {
          await context.html.parse(big);
          return { handled: true };
        } catch (e) {
          return { handled: false, code: e && e.code };
        }
      },
    };`,
    "htmlnodes",
    "run",
  )) as Record<string, unknown>;
  assert.equal(value.handled, false);
  assert.equal(value.code, "HTML_PARSE_ERROR");
});

test("html.select: too many matches is a structured HTML_TOO_MANY_RESULTS", async (t) => {
  const value = (await runCapability(
    t,
    `export const plugin = {
      run: async (context) => {
        const parts = [];
        for (let i = 0; i < 1001; i++) parts.push('<i class="m"></i>');
        const doc = await context.html.parse(parts.join(""));
        try {
          const m = await context.html.select(doc, ".m");
          return { handled: true, count: m.length };
        } catch (e) {
          return { handled: false, code: e && e.code };
        }
      },
    };`,
    "htmlmany",
    "run",
  )) as Record<string, unknown>;
  assert.equal(value.handled, false);
  assert.equal(value.code, "HTML_TOO_MANY_RESULTS");
});

test("html.extract: a document (not element) is HTML_EXTRACT_ERROR", async (t) => {
  const value = (await runCapability(
    t,
    `export const plugin = {
      run: async (context) => {
        const doc = await context.html.parse('<p>x</p>');
        try {
          await context.html.extract(doc);
          return { handled: true };
        } catch (e) {
          return { handled: false, code: e && e.code };
        }
      },
    };`,
    "htmlextrabad",
    "run",
  )) as Record<string, unknown>;
  assert.equal(value.handled, false);
  assert.equal(value.code, "HTML_EXTRACT_ERROR");
});

test("html.select: missing selector arg is HTML_INVALID_SELECTOR", async (t) => {
  const value = (await runCapability(
    t,
    `export const plugin = {
      run: async (context) => {
        const doc = await context.html.parse('<p>x</p>');
        try {
          await context.html.select(doc);
          return { handled: true };
        } catch (e) {
          return { handled: false, code: e && e.code };
        }
      },
    };`,
    "htmlnoselect",
    "run",
  )) as Record<string, unknown>;
  assert.equal(value.handled, false);
  assert.equal(value.code, "HTML_INVALID_SELECTOR");
});

// ---------------------------------------------------------------------------
// Security: no execution, no resource loading, no host leak
// ---------------------------------------------------------------------------

test("html: event-handler attributes are inert data (not executed)", async (t) => {
  const value = (await runCapability(
    t,
    `export const plugin = {
      run: async (context) => {
        const doc = await context.html.parse(
          '<a id="x" href="javascript:doX()" onclick="doX()" onerror="boom">hi</a>'
        );
        const el = await context.html.select(doc, "#x");
        const info = await context.html.extract(el[0]);
        return {
          href: info.href,
          hasOnClick: Object.prototype.hasOwnProperty.call(info.attributes, "onclick"),
          hasOnerror: Object.prototype.hasOwnProperty.call(info.attributes, "onerror"),
        };
      },
    };`,
    "htmlevent",
    "run",
  )) as Record<string, unknown>;
  // The javascript: URL and handler attributes survive as inert data —
  // nothing runs, and the plugin can still read them as plain strings.
  assert.equal(value.href, "javascript:doX()");
  assert.equal(value.hasOnClick, true);
  assert.equal(value.hasOnerror, true);
});

test("sandbox boundary: no process / require / host fetch reachable from Phase 5", async (t) => {
  const value = (await runCapability(
    t,
    `export const plugin = {
      run: async (context) => {
        const doc = await context.html.parse('<p>x</p>');
        return {
          proc: typeof process,
          req: typeof require,
          fetch: typeof fetch,
          buffer: typeof Buffer,
          htmlOk: Array.isArray(await context.html.select(doc, "p")),
        };
      },
    };`,
    "p5boundary",
    "run",
  )) as Record<string, unknown>;
  assert.equal(value.proc, "undefined");
  assert.equal(value.req, "undefined");
  assert.equal(value.fetch, "undefined");
  assert.equal(value.buffer, "undefined");
  assert.equal(value.htmlOk, true);
});

// ---------------------------------------------------------------------------
// Full pipelines (HTTP -> HTML -> select -> extract; HTTP -> JSON)
// ---------------------------------------------------------------------------

test("pipeline: HTTP -> HTML -> parse -> select -> extract", async (t) => {
  const value = (await runCapability(
    t,
    `export const plugin = {
      run: async (url, context) => {
        const res = await context.http.get(url);
        const doc = await context.html.parse(res.body);
        const cards = await context.html.select(doc, "#root .card");
        const links = await context.html.select(doc, "article.card a[href]");
        return {
          status: res.status,
          cards: cards.map((c) => context.html.extract(c)),
          links: links.map((l) => context.html.extract(l)),
        };
      },
    };`,
    "pipehtml",
    "run",
    [`${baseUrlPlaceholder()}/page`],
  )) as {
    status: number;
    cards: Array<{ text: string; id?: string; data: Record<string, string> }>;
    links: Array<{ href?: string; text: string }>;
  };
  assert.equal(value.status, 200);
  assert.equal(value.cards.length, 2);
  const firstCard = value.cards[0];
  const secondLink = value.links[1];
  assert.ok(firstCard, "expected first card");
  assert.ok(secondLink, "expected second link");
  assert.equal(firstCard.text, "Movie One");
  assert.equal(firstCard.id, undefined);
  assert.equal(firstCard.data.id, "42");
  assert.equal(secondLink.href, "/watch/2");
  assert.equal(secondLink.text, "Movie Two");
});

test("pipeline: HTTP -> JSON -> parse (nested result)", async (t) => {
  const value = (await runCapability(
    t,
    `export const plugin = {
      run: async (url, context) => {
        const res = await context.http.get(url);
        const data = context.json.parse(res.body);
        return { status: res.status, hello: data.hello, sum: data.items.reduce((a, b) => a + b, 0) };
      },
    };`,
    "pipejson",
    "run",
    [`${baseUrlPlaceholder()}/api`],
  )) as Record<string, unknown>;
  assert.equal(value.status, 200);
  assert.equal(value.hello, "world");
  assert.equal(value.sum, 6);
});

test("pipeline: results are deep JSON-serializable and host-free", async (t) => {
  const value = (await runCapability(
    t,
    `export const plugin = {
      run: async (url, context) => {
        const res = await context.http.get(url);
        const doc = await context.html.parse(res.body);
        const el = await context.html.select(doc, "#root .card");
        return (await context.html.extract(el[0])).attributes;
      },
    };`,
    "pipejsonsafe",
    "run",
    [`${baseUrlPlaceholder()}/page`],
  )) as Record<string, unknown>;
  // The extracted attributes must be a plain object of strings — the
  // round-trip through JSON must be lossless and contain no host refs.
  const reserialized = JSON.parse(JSON.stringify(value));
  assert.deepEqual(reserialized, { class: "card", "data-id": "42" });
});

function baseUrlPlaceholder(): string {
  return baseUrl;
}

// The local server must be running before any test that uses baseUrl, and
// must be torn down afterward. node:test runs file-level before/after
// hooks around every test in this file.
before(async () => {
  await startTestServer();
});
after(async () => {
  await stopTestServer();
});
