/**
 * Phase 4 — controlled HTTP capability tests.
 *
 * All HTTP behavior is tested against a LOCAL test server on 127.0.0.1
 * (ephemeral port). The test suite never depends on the public Internet,
 * so it works offline and stays reproducible.
 *
 * Coverage:
 * - request validation (URL, scheme, options)
 * - GET / POST, headers, status, body, redirects
 * - engine limits (timeout, response size, redirect cap, clamping)
 * - structured error model
 * - sandbox boundary (no fetch, no node:http/net/tls, no bypass)
 * - in-flight cancellation on operation end / dispose
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";

import { HttpClient, HttpError } from "../src/http.js";
import { PluginManager } from "../src/manager.js";
import { PluginRuntime } from "../src/runtime.js";

/**
 * These fixtures are served from a LOCAL server on 127.0.0.1. The engine's
 * DEFAULT network policy blocks loopback/private/link-local targets (SSRF
 * defence — see src/network.ts and tests/network-policy.test.ts), so the
 * test host opts in explicitly. This mirrors what a host application does
 * for local development; a plugin can never grant itself this permission.
 */
const ALLOW_LOCAL = { allowPrivateNetwork: true } as const;
import type { LoadedPlugin, PluginLoadResult } from "../src/types.js";

// ---------------------------------------------------------------------------
// Local test server
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;
const bigChunk = "x".repeat(65536);

function safeWrite(res: ServerResponse, data: string): void {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  try {
    res.write(data);
  } catch {
    // Client aborted — nothing to do.
  }
}

async function startTestServer(): Promise<void> {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Aborted client connections must never crash the test server.
    res.on("error", () => {});
    const u = new URL(req.url ?? "/", "http://localhost");
    const p = u.pathname;

    if (p === "/get") {
      res.writeHead(200, { "content-type": "application/json", "x-test": "yes" });
      res.end(JSON.stringify({ hello: "world", n: 42 }));
    } else if (p === "/text") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("plain body here");
    } else if (p === "/post") {
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => parts.push(c));
      req.on("end", () => {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            method: req.method,
            body: Buffer.concat(parts).toString("utf8"),
            xCustom: req.headers["x-custom"] ?? null,
          }),
        );
      });
    } else if (p === "/echo-headers") {
      const received: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") {
          received[k] = v;
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(received));
    } else if (p === "/proto-headers") {
      // Hostile response headers: names that collide with
      // Object.prototype members. Built via JSON.parse so `__proto__` is a
      // real OWN key rather than a prototype assignment in the literal.
      const hostile = JSON.parse(
        '{"__proto__":"PWNED","constructor":"CTOR-VALUE","tostring":"TS-VALUE","x-dup":"a"}',
      ) as Record<string, string>;
      for (const [name, value] of Object.entries(hostile)) {
        try {
          res.setHeader(name, value);
        } catch {
          // Node rejects some names; the test asserts on what arrives.
        }
      }
      // A genuine duplicate multi-value header, to prove joining still works.
      res.setHeader("x-dup", ["a", "b"]);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("proto");
    } else if (p === "/status/404") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    } else if (p === "/redirect-1") {
      res.writeHead(302, { location: "/get" });
      res.end();
    } else if (p === "/redirect-2") {
      res.writeHead(302, { location: "/redirect-1" });
      res.end();
    } else if (p === "/redirect-3") {
      res.writeHead(302, { location: "/redirect-2" });
      res.end();
    } else if (p === "/bad-redirect") {
      // A 302 without a Location header is terminal.
      res.writeHead(302, { "content-type": "text/plain" });
      res.end("no location");
    } else if (p === "/redirect-file") {
      // A redirect trying to escape to a local file — must be rejected.
      res.writeHead(302, { location: "file:///etc/passwd" });
      res.end();
    } else if (p === "/big") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      let sent = 0;
      const total = 3 * 1024 * 1024;
      const iv = setInterval(() => {
        if (sent >= total) {
          clearInterval(iv);
          if (!res.destroyed && !res.writableEnded) {
            res.end();
          }
          return;
        }
        safeWrite(res, bigChunk);
        sent += bigChunk.length;
      }, 2);
    } else if (p === "/slow") {
      setTimeout(() => {
        if (res.destroyed || res.writableEnded) {
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("slow-ok");
      }, 800);
    } else if (p === "/cl-big") {
      // Declares a 10 MiB body (faster-than-streaming fast path target).
      res.writeHead(200, {
        "content-length": String(10 * 1024 * 1024),
        "content-type": "application/octet-stream",
      });
      res.end();
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("test server did not bind");
  }
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

before(async () => {
  await startTestServer();
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

// ---------------------------------------------------------------------------
// Guest plugin + runtime helpers
// ---------------------------------------------------------------------------

/**
 * Guest plugin whose capabilities pass their (url, options) arguments
 * straight through to context.http, catching structured errors.
 */
const HTTP_PLUGIN_SOURCE = `
// Capabilities receive their args first and the controlled context LAST.
// The "arity" helpers make optional options explicit regardless of how
// many args the host passed.
function arity(rest) {
  const context = rest[rest.length - 1];
  const args = rest.slice(0, -1);
  return { args, context };
}

export const plugin = {
  // get(url, options?) → {ok, ...response} or {ok: false, code, message}
  async get(...rest) {
    const { args, context } = arity(rest);
    try {
      const res = await context.http.get(args[0], args[1]);
      return {
        ok: true,
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
        url: res.url,
        body: res.body,
      };
    } catch (e) {
      return {
        ok: false,
        isObject: typeof e === "object",
        code: e && e.code,
        message: e && e.message,
      };
    }
  },

  // getJson(url, options?)
  async getJson(...rest) {
    const { args, context } = arity(rest);
    try {
      const value = await context.http.getJson(args[0], args[1]);
      return { ok: true, value };
    } catch (e) {
      return { ok: false, code: e && e.code, message: e && e.message };
    }
  },

  // request(options-with-url)
  async request(options, context) {
    try {
      const res = await context.http.request(options);
      return { ok: true, status: res.status, body: res.body, headers: res.headers };
    } catch (e) {
      return { ok: false, code: e && e.code, message: e && e.message };
    }
  },

  // Two concurrent requests in one operation.
  async two(urlA, urlB, context) {
    try {
      const [ra, rb] = await Promise.all([
        context.http.get(urlA, { timeoutMs: 4000 }),
        context.http.get(urlB, { timeoutMs: 4000 }),
      ]);
      return { ok: true, a: ra.status, b: rb.status, aBody: ra.body, bBody: rb.body };
    } catch (e) {
      return { ok: false, code: e && e.code, message: e && e.message };
    }
  },

  // Fire-and-forget: starts a request, returns without awaiting it.
  float(...rest) {
    const { args, context } = arity(rest);
    void context.http.get(args[0], { timeoutMs: 60000 });
    return "started";
  },

  // Capability that does NOT catch its HTTP error.
  uncaught(url, context) {
    return context.http.get(url, { timeoutMs: 4000 });
  },

  // Attempts to reach host networking directly (must fail).
  tryFetch(url, context) {
    return fetch(url);
  },
};
`;

async function makeTempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "spe-http-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

interface HttpPluginFixture {
  runtime: PluginRuntime;
  load: PluginLoadResult;
  /** The loaded plugin (present only when load.ok). */
  loaded: LoadedPlugin | null;
}

async function withHttpPlugin(
  t: TestContext,
  source = HTTP_PLUGIN_SOURCE,
  dirName = "httptest",
): Promise<HttpPluginFixture> {
  const base = await makeTempDir(t);
  const dir = path.join(base, dirName);
  await mkdir(dir, { recursive: true });
  const manifest = {
    id: `t.${dirName}`,
    name: dirName,
    version: "1.0.0",
    entry: "plugin.js",
  };
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(dir, "plugin.js"), source);
  const manager = new PluginManager();
  await manager.discoverPlugins(base);
  const discovered = manager.getPlugin(manifest.id);
  assert.ok(discovered, "plugin must be discovered");
  const runtime = new PluginRuntime({ http: { network: ALLOW_LOCAL } });
  t.after(() => runtime.shutdown());
  const load = await runtime.loadPlugin(discovered);
  return { runtime, load, loaded: load.ok ? load.plugin : null };
}

/**
 * Run the "get" capability and return the guest's structured result.
 * The fixture's load must have succeeded.
 */
async function guestGet(
  fixture: HttpPluginFixture,
  url: unknown,
  options?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  assert.ok(fixture.loaded, "load must have succeeded");
  const args: unknown[] = options === undefined ? [url] : [url, options];
  const result = await fixture.runtime.execute(fixture.loaded, "get", args);
  assert.ok(
    result.success,
    result.success ? "" : `execute failed: ${JSON.stringify(result.error)}`,
  );
  if (!result.success) {
    throw new Error("unreachable");
  }
  return result.value as Record<string, unknown>;
}

/** Return the loaded plugin, asserting the load succeeded. */
function loadedOf(fixture: HttpPluginFixture): LoadedPlugin {
  assert.ok(fixture.loaded, "load must have succeeded");
  return fixture.loaded;
}

function assertHttpError(
  result: Record<string, unknown>,
  code: string,
  messagePart?: string | RegExp,
): void {
  assert.equal(result.ok, false, `expected a structured HTTP error, got: ${JSON.stringify(result)}`);
  assert.equal(result.isObject, true, "the caught value must be a structured object");
  assert.equal(result.code, code, `expected code ${code}, message: ${String(result.message)}`);
  assert.equal(typeof result.message, "string");
  if (messagePart !== undefined) {
    const message = String(result.message);
    if (messagePart instanceof RegExp) {
      assert.match(message, messagePart);
    } else {
      assert.ok(message.includes(messagePart), `message '${message}' missing '${messagePart}'`);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP behavior (against the local server)
// ---------------------------------------------------------------------------

test("GET returns a normalized, serializable response", async (t) => {
  const fixture = await withHttpPlugin(t);
  assert.equal(fixture.load.ok, true);
  if (!fixture.load.ok) return;

  const out = await guestGet(fixture, `${baseUrl}/get`);
  assert.equal(out.ok, true);
  assert.equal(out.status, 200);
  assert.equal(out.statusText, "OK");
  const headers = out.headers as Record<string, string>;
  assert.equal(headers["x-test"], "yes");
  assert.match(String(headers["content-type"]), /application\/json/);
  assert.equal(out.url, `${baseUrl}/get`);
  const body = JSON.parse(String(out.body)) as { hello: string; n: number };
  assert.deepEqual(body, { hello: "world", n: 42 });
});

test("getJson parses the response body", async (t) => {
  const fixture = await withHttpPlugin(t);
  const result = await fixture.runtime.execute(loadedOf(fixture), "getJson", [`${baseUrl}/get`]);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.error));
  if (result.success) {
    assert.deepEqual(result.value, { ok: true, value: { hello: "world", n: 42 } });
  }
});

test("getJson rejects non-JSON bodies with HTTP_INVALID_JSON", async (t) => {
  const fixture = await withHttpPlugin(t);
  const result = await fixture.runtime.execute(loadedOf(fixture), "getJson", [`${baseUrl}/text`]);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.error));
  if (result.success) {
    const out = result.value as Record<string, unknown>;
    assert.equal(out.ok, false);
    assert.equal(out.code, "HTTP_INVALID_JSON");
  }
});

test("POST sends body and headers via request()", async (t) => {
  const fixture = await withHttpPlugin(t);
  const result = await fixture.runtime.execute(loadedOf(fixture), "request", [
    { url: `${baseUrl}/post`, method: "POST", body: "hello body", headers: { "x-custom": "abc" } },
  ]);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.error));
  if (result.success) {
    const out = result.value as { ok: boolean; status: number; body: string };
    assert.equal(out.ok, true);
    assert.equal(out.status, 201);
    const echo = JSON.parse(out.body) as { method: string; body: string; xCustom: string };
    assert.equal(echo.method, "POST");
    assert.equal(echo.body, "hello body");
    assert.equal(echo.xCustom, "abc");
  }
});

test("non-2xx status codes resolve normally (not errors)", async (t) => {
  const fixture = await withHttpPlugin(t);
  const out = await guestGet(fixture, `${baseUrl}/status/404`);
  assert.equal(out.ok, true, "404 must not be a transport failure");
  assert.equal(out.status, 404);
  const body = JSON.parse(String(out.body)) as { error: string };
  assert.equal(body.error, "not found");
});

test("custom request headers are sent", async (t) => {
  const fixture = await withHttpPlugin(t);
  const out = await guestGet(fixture, `${baseUrl}/echo-headers`, {
    headers: { "x-probe": "phase4" },
  });
  assert.equal(out.ok, true);
  const received = JSON.parse(String(out.body)) as Record<string, string>;
  assert.equal(received["x-probe"], "phase4");
});

test("redirects are followed and re-validated (within the limit)", async (t) => {
  const fixture = await withHttpPlugin(t);
  // 3 hops, within the default limit of 5.
  const out = await guestGet(fixture, `${baseUrl}/redirect-3`);
  assert.equal(out.ok, true);
  assert.equal(out.status, 200);
  assert.equal(out.url, `${baseUrl}/get`);
});

test("a redirect without Location is terminal", async (t) => {
  const fixture = await withHttpPlugin(t);
  const out = await guestGet(fixture, `${baseUrl}/bad-redirect`);
  assert.equal(out.ok, true);
  assert.equal(out.status, 302);
  assert.equal(out.body, "");
});

test("a redirect escaping to a non-HTTP scheme is rejected", async (t) => {
  const fixture = await withHttpPlugin(t);
  const out = await guestGet(fixture, `${baseUrl}/redirect-file`);
  assertHttpError(out, "HTTP_UNSUPPORTED_SCHEME", /file:/);
});

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

test("invalid URLs are rejected", async (t) => {
  const fixture = await withHttpPlugin(t);
  for (const url of ["not a url", "example.com/x", "http://"]) {
    const out = await guestGet(fixture, url);
    assertHttpError(out, "HTTP_INVALID_URL");
  }
});

test("non-HTTP schemes are rejected (file:, data:, javascript:)", async (t) => {
  const fixture = await withHttpPlugin(t);
  for (const url of [
    "file:///etc/passwd",
    "data:text/plain,hello",
    "javascript:alert(1)",
    "ftp://example.com/x",
  ]) {
    const out = await guestGet(fixture, url);
    assertHttpError(out, "HTTP_UNSUPPORTED_SCHEME");
  }
});

test("structurally invalid options are rejected", async (t) => {
  const fixture = await withHttpPlugin(t);
  // URL that is not a string.
  let out = await guestGet(fixture, 12345);
  assertHttpError(out, "HTTP_INVALID_REQUEST");
  // get() with options.url.
  out = await guestGet(fixture, `${baseUrl}/get`, { url: "http://other.example" });
  assertHttpError(out, "HTTP_INVALID_REQUEST", /options\.url/);
  // get() with a method option.
  out = await guestGet(fixture, `${baseUrl}/get`, { method: "POST" });
  assertHttpError(out, "HTTP_INVALID_REQUEST", /always GET/);
  // request() without url.
  const reqResult = await fixture.runtime.execute(loadedOf(fixture), "request", [
    { method: "GET" },
  ]);
  assert.ok(reqResult.success, reqResult.success ? "" : JSON.stringify(reqResult.error));
  if (reqResult.success) {
    const reqOut = reqResult.value as Record<string, unknown>;
    assert.equal(reqOut.ok, false);
    assert.equal(reqOut.code, "HTTP_INVALID_REQUEST");
  }
});

// ---------------------------------------------------------------------------
// Engine limits
// ---------------------------------------------------------------------------

test("requests exceeding the timeout produce HTTP_TIMEOUT", async (t) => {
  const fixture = await withHttpPlugin(t);
  const started = Date.now();
  const out = await guestGet(fixture, `${baseUrl}/slow`, { timeoutMs: 150 });
  const elapsed = Date.now() - started;
  assertHttpError(out, "HTTP_TIMEOUT", /timed out/);
  assert.ok(elapsed < 800, `must abort at the timeout, not wait for the server (${elapsed} ms)`);
});

test("oversized responses are aborted with HTTP_RESPONSE_TOO_LARGE (streamed)", async (t) => {
  const fixture = await withHttpPlugin(t);
  const out = await guestGet(fixture, `${baseUrl}/big`, { maxResponseBytes: 100_000 });
  assertHttpError(out, "HTTP_RESPONSE_TOO_LARGE", /maximum/);
  // The error object must not carry an oversized body.
  assert.equal(out.body, undefined);
});

test("oversized declared Content-Length fails fast", async (t) => {
  const fixture = await withHttpPlugin(t);
  const out = await guestGet(fixture, `${baseUrl}/cl-big`, { maxResponseBytes: 1_000_000 });
  assertHttpError(out, "HTTP_RESPONSE_TOO_LARGE");
});

test("redirect chains are capped with HTTP_TOO_MANY_REDIRECTS", async (t) => {
  const fixture = await withHttpPlugin(t);
  const out = await guestGet(fixture, `${baseUrl}/redirect-3`, { maxRedirects: 2 });
  assertHttpError(out, "HTTP_TOO_MANY_REDIRECTS");
});

// ---------------------------------------------------------------------------
// Errors: network failure + uncaught propagation
// ---------------------------------------------------------------------------

test("network failures produce HTTP_NETWORK_ERROR", async (t) => {
  const fixture = await withHttpPlugin(t);
  // Port 1 on loopback: nothing listens → connection refused.
  const out = await guestGet(fixture, "http://127.0.0.1:1/nothing", { timeoutMs: 4000 });
  assertHttpError(out, "HTTP_NETWORK_ERROR");
});

test("an uncaught HTTP error surfaces as a structured runtime error", async (t) => {
  const fixture = await withHttpPlugin(t);
  const result = await fixture.runtime.execute(loadedOf(fixture), "uncaught", [
    "http://127.0.0.1:1/nothing",
  ]);
  assert.ok(!result.success);
  if (!result.success) {
    assert.equal(result.error.type, "PLUGIN_RUNTIME_ERROR");
    assert.match(result.error.message, /HTTP_NETWORK_ERROR/);
  }
});

// ---------------------------------------------------------------------------
// Concurrency + cancellation
// ---------------------------------------------------------------------------

test("two concurrent requests in one operation both settle", async (t) => {
  const fixture = await withHttpPlugin(t);
  const result = await fixture.runtime.execute(loadedOf(fixture), "two", [
    `${baseUrl}/get`,
    `${baseUrl}/text`,
  ]);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.error));
  if (result.success) {
    const out = result.value as { ok: boolean; a: number; b: number; aBody: string; bBody: string };
    assert.equal(out.ok, true);
    assert.equal(out.a, 200);
    assert.equal(out.b, 200);
    assert.match(out.aBody, /hello/);
    assert.match(out.bBody, /plain body/);
  }
});

test("in-flight requests are aborted when the operation ends (clean teardown)", async (t) => {
  const fixture = await withHttpPlugin(t);
  // The capability starts a long request and returns without awaiting it.
  const result = await fixture.runtime.execute(loadedOf(fixture), "float", [`${baseUrl}/slow`]);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.error));
  if (result.success) {
    assert.equal(result.value, "started");
  }
  // The operation's teardown must have aborted the in-flight request;
  // disposing the plugin (in t.after) must therefore be clean and fast —
  // a leaked request/leak assertion would crash this test file.
  assert.equal(fixture.runtime.dispose(loadedOf(fixture)), true);
  fixture.runtime.shutdown();
});

// ---------------------------------------------------------------------------
// Sandbox boundary: no direct host networking
// ---------------------------------------------------------------------------

test("the guest has no fetch() — only context.http can do networking", async (t) => {
  const fixture = await withHttpPlugin(t);
  const result = await fixture.runtime.execute(loadedOf(fixture), "tryFetch", [
    `${baseUrl}/get`,
  ]);
  assert.ok(!result.success);
  if (!result.success) {
    assert.equal(result.error.type, "PLUGIN_RUNTIME_ERROR");
    assert.match(result.error.message, /fetch is not defined|ReferenceError/);
  }
});

test("static imports of node:http are rejected at load", async (t) => {
  const fixture = await withHttpPlugin(
    t,
    `import http from "node:http";
export const plugin = { test: () => http };`,
    "badimport",
  );
  assert.equal(fixture.load.ok, false);
  if (!fixture.load.ok) {
    assert.equal(fixture.load.error.type, "PLUGIN_LOAD_ERROR");
    assert.match(fixture.load.error.message, /node:http|not allowed/);
  }
});

test("dynamic import() of node:net is rejected at execution", async (t) => {
  const fixture = await withHttpPlugin(
    t,
    `export const plugin = {
      async net(context) {
        const m = await import("node:net");
        return { got: Object.keys(m).length };
      },
    };`,
    "dynimport",
  );
  assert.equal(fixture.load.ok, true);
  if (!fixture.load.ok) return;
  const result = await fixture.runtime.execute(loadedOf(fixture), "net", []);
  assert.ok(!result.success);
  if (!result.success) {
    // The loader rejects the specifier before any host module loads.
    assert.match(result.error.message, /not allowed|node:net/);
  }
});

test("plugins without HTTP usage still work (Phase 3 compatibility)", async (t) => {
  const fixture = await withHttpPlugin(
    t,
    `export const plugin = {
      add(a, b) { return a + b; },
    };`,
    "nohttp",
  );
  assert.equal(fixture.load.ok, true);
  if (!fixture.load.ok) return;
  const result = await fixture.runtime.execute(loadedOf(fixture), "add", [2, 3]);
  assert.ok(result.success);
  if (result.success) {
    assert.equal(result.value, 5);
  }
});

// ---------------------------------------------------------------------------
// HttpClient (host class) — limits, validation, clamping
// ---------------------------------------------------------------------------

test("plugin-supplied limits are clamped to engine maximums", async () => {
  const client = new HttpClient({ network: ALLOW_LOCAL });
  // A huge requested timeout must not throw; it is clamped (the request
  // itself is fast, so it simply succeeds).
  const res = await client.request(`${baseUrl}/get`, { timeoutMs: 999_999_999 });
  assert.equal(res.status, 200);
  assert.equal(client.limits.maxTimeoutMs, 30_000);
});

test("invalid option values are rejected with HTTP_INVALID_REQUEST", async () => {
  const client = new HttpClient({ network: ALLOW_LOCAL });
  const expectError = async (options: Parameters<HttpClient["request"]>[1]) => {
    await assert.rejects(
      () => client.request(`${baseUrl}/get`, options),
      (error: unknown) => error instanceof HttpError && error.code === "HTTP_INVALID_REQUEST",
    );
  };
  await expectError({ timeoutMs: -5 });
  await expectError({ maxResponseBytes: 0 });
  await expectError({ maxRedirects: -1 });
  await expectError({ method: "DELETE" as never });
  await expectError({ body: 42 as never });
  await expectError({ headers: { "bad name": "v" } });
  await expectError({ headers: { "x-bad": "line\nbreak" } });
  await expectError({ headers: "nope" as never });
});

test("supported methods are GET and POST only", async () => {
  const client = new HttpClient({ network: ALLOW_LOCAL });
  const res = await client.request(`${baseUrl}/get`, { method: "GET" });
  assert.equal(res.status, 200);
  await assert.rejects(
    () => client.request(`${baseUrl}/post`, { method: "PUT" as never }),
    (error: unknown) => error instanceof HttpError && error.code === "HTTP_INVALID_REQUEST",
  );
});

// ---------------------------------------------------------------------------
// Phase 7 regression: response/request header prototype-chain handling
// ---------------------------------------------------------------------------
//
// BUG (found in the Phase 1-6 audit): collectHeaders() detected duplicate
// response headers with `key in result`, which also matches INHERITED
// Object.prototype members. A server-controlled header named `constructor`
// therefore produced "function Object() { [native code] }, <value>" —
// corrupting the header AND leaking host function source text into
// guest-visible data. Request headers named `__proto__` were also silently
// dropped instead of rejected.

test("response headers named after Object.prototype members are not corrupted", async () => {
  const client = new HttpClient({ network: ALLOW_LOCAL });
  const res = await client.request(`${baseUrl}/proto-headers`);
  assert.equal(res.status, 200);
  assert.equal(res.body, "proto");

  // The value must be exactly what the server sent — no host internals
  // prepended by a bogus "duplicate" join.
  assert.equal(res.headers["constructor"], "CTOR-VALUE");
  assert.equal(res.headers["tostring"], "TS-VALUE");
  for (const value of Object.values(res.headers)) {
    assert.ok(
      !value.includes("native code"),
      `host internals leaked into a response header: ${value}`,
    );
    assert.ok(
      !value.includes("function Object"),
      `host internals leaked into a response header: ${value}`,
    );
  }
});

test("genuine duplicate response headers are still joined with ', '", async () => {
  const client = new HttpClient({ network: ALLOW_LOCAL });
  const res = await client.request(`${baseUrl}/proto-headers`);
  assert.equal(res.headers["x-dup"], "a, b");
});

test("response header maps never carry a hijacked prototype", async () => {
  const client = new HttpClient({ network: ALLOW_LOCAL });
  const res = await client.request(`${baseUrl}/proto-headers`);
  assert.equal(
    Object.getPrototypeOf(res.headers),
    Object.prototype,
    "the header map's prototype must be untouched",
  );
  // A `__proto__` response header must never become an own property or a
  // prototype write; either it is absent or it is plain data.
  const globalProbe = {} as Record<string, unknown>;
  assert.equal(globalProbe["PWNED"], undefined, "Object.prototype must not be polluted");
  // The map must stay JSON-serializable for the guest boundary.
  const roundTrip = JSON.parse(JSON.stringify(res.headers)) as Record<string, string>;
  assert.deepEqual(Object.keys(roundTrip).sort(), Object.keys(res.headers).sort());
});

test("a request header named '__proto__' is rejected, not silently dropped", async () => {
  const client = new HttpClient({ network: ALLOW_LOCAL });
  const hostile = JSON.parse('{"__proto__":"evil","x-real":"v"}') as Record<string, string>;
  await assert.rejects(
    () => client.request(`${baseUrl}/get`, { headers: hostile }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.code === "HTTP_INVALID_REQUEST" &&
      error.message.includes("__proto__"),
  );
  const probe = {} as Record<string, unknown>;
  assert.equal(probe["evil"], undefined, "Object.prototype must not be polluted");
});

test("ordinary request headers still work after the prototype guard", async () => {
  const client = new HttpClient({ network: ALLOW_LOCAL });
  const res = await client.request(`${baseUrl}/echo-headers`, {
    headers: { "x-custom": "value", "constructor": "harmless" },
  });
  assert.equal(res.status, 200);
  const echoed = JSON.parse(res.body) as Record<string, string>;
  assert.equal(echoed["x-custom"], "value");
  assert.equal(echoed["constructor"], "harmless");
});
