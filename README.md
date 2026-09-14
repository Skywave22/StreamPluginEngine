# StreamPluginEngine

Lightweight, cross-platform plugin engine for a future
media/streaming application. This repository contains the **engine only** —
no UI, no browser, no scraping targets.

## Current status: Phase 4 — controlled HTTP capability

Implemented and tested:

- Typed plugin manifest format, validation, discovery, loading (Phases 1–2)
- In-memory plugin registry with duplicate-ID protection (Phase 2)
- **`PluginRuntime`** — executes plugin JavaScript inside QuickJS, a
  separate JavaScript engine compiled to WebAssembly
  (`quickjs-emscripten`). Plugins get a controlled context
  (`manifest` + `log` + `http`), JSON arguments, and JSON results.
- **Engine-controlled HTTP** — plugins make real HTTP/HTTPS requests through
  `context.http` (`get`, `getJson`, `request`), but the network call is
  performed by the **host**, never by the sandbox. Plugins keep **no**
  direct Node networking, sockets, streams, or `fetch` — only this small,
  bounded capability (see [The sandbox](#the-sandbox) and
  [HTTP capability](#http-capability-phase-4)).
- Capability detection (`search`, `getDetails`, … or any function export)
- Structured results, timeouts (interrupt hooks), memory limits, and error
  isolation — a broken plugin never crashes the engine
- CLI: `plugins:list` and `plugin:run`
- Example plugin that genuinely executes in the runtime, including a live
  `httpExample` capability that performs a real GET and handles failures

**Not implemented yet:** HTML parsing, scraping, media/stream extraction,
enable/disable, parallel execution, benchmarking.
**HTML parsing, scraping, and media extraction are intentionally not
implemented in Phase 4** — see the [HTTP capability](#http-capability-phase-4)
section for what that boundary means.

## Quick start

Requires Node.js >= 20.

```bash
npm install
npm run build         # compile TypeScript with tsc
npm test              # build, then run tests with the built-in node:test runner
npm run plugins:list  # list plugins discovered in plugins/
npm run plugin:run -- example.source test                  # run the self-test
npm run plugin:run -- example.source search '"Example"'    # run with one JSON argument
npm run plugin:run -- example.source search '["Example"]'  # or a JSON array of arguments
```

Example `plugin:run` output:

```
Plugin: Example Source
Operation: test
Status: SUCCESS
Result: "Example Result"
Execution time: 0.41 ms
```

## Project layout

```
src/        Engine source (manifest, validator, loader, manager, runtime, CLI)
tests/      Tests, run with the built-in Node.js test runner
plugins/    Example plugin (executes in the runtime)
dist/       Build output (generated, not committed)
```

## Writing a plugin

A plugin is a directory inside `plugins/` with `manifest.json` (see
Phase 2 rules) and an ES-module entry file. Contract:

```js
export const plugin = {
  // Each function property is a capability. Arguments come first,
  // then the controlled context object LAST.
  search: async (query, context) => {
    context.log("search", query);
    return [{ id: "example-1", title: "Example Result" }]; // JSON only
  },
  // Make a request through the engine-controlled HTTP capability.
  fetchInfo: async (url, context) => {
    const res = await context.http.get(url);
    if (res.status !== 200) {
      throw new Error("expected 200, got " + res.status);
    }
    return res.body; // string; use res.headers for metadata
  },
};
```

- The module must export an object named `plugin`; at least one function
  capability is required. Non-function properties are ignored.
- `context.manifest` is this plugin's manifest; `context.log(...)` routes
  to the host logger; `context.http` performs engine-controlled HTTP.
  That is the entire host surface in Phase 4.
- Capability arguments must be JSON-serializable; results are returned to
  the host as JSON (everything else is dropped).
- `import` works for files **inside the plugin directory only**. Host
  modules (`node:fs`, `node:http`, `node:net`, `node:tls`), built-ins,
  absolute paths, and `..` escapes are rejected.

## The sandbox

Plugins run inside **QuickJS** (a mature, actively maintained embedded JS
engine) compiled to WebAssembly. It is a separate engine from the host
Node.js process — the plugin realm contains no host objects by
construction, which is what makes the isolation real (unlike `node:vm`,
which is documented as not a security boundary and is deliberately not
used).

What a plugin has:

- Standard JS builtins (Object, Array, Promise, JSON, Math, Date, RegExp,
  Map/Set, TypedArrays)
- Its own heap, isolated from every other plugin (one QuickJS runtime per
  plugin)
- The controlled context (`manifest`, `log`, `http`) and JSON arguments
- Relative imports within its own directory

What a plugin does NOT have:

- `process`, `require`, `module`, `__dirname`, `Buffer`, `fetch`
- `fs`, `net`, `tls`, `child_process`, or any other Node built-in
- Environment variables, shell access, host objects, other plugins' globals
- Any API beyond the context — the Phase 4 context is intentionally small

The one sanctioned exception is **network access, but only through
`context.http`**. The sandbox itself has no network at all — the host
performs every request on the plugin's behalf. See the next section.

Execution limits (per operation / per plugin):

- Time limit via QuickJS interrupt hooks (default 5 s) — runaway loops are
  interrupted and reported as `PLUGIN_TIMEOUT`
- Guest heap limit (default 64 MiB) — over-allocation is reported as
  `PLUGIN_MEMORY_LIMIT`
- Promises that never settle are bounded by the same time limit

### Sandbox limitations (read this)

- This is **engine-level isolation inside a single process**, not an
  OS-level security boundary. A plugin is untrusted code constrained by
  the QuickJS engine and its limits — not by the operating system.
- The Wasm module runs in the host process: a bug in the engine/Wasm
  boundary is outside the plugin sandbox's reach.
- CPU denial-of-service is bounded (timeouts), not eliminated.
- Planned hardening (later phases): per-plugin OS-level isolation
  (process/worker) and a capabilities-based API surface.
- The security tests (`tests/security.test.ts`) demonstrate these
  guarantees; they are not a proof of perfect sandbox security.

## HTTP capability (Phase 4)

Plugins can perform real HTTP/HTTPS requests, but the engine mediates every
one of them. The plugin calls a small `context.http` API; the host executes
the request with Node's built-in `fetch` (undici); the response is reduced to
a plain, JSON-serializable object before it ever touches the sandbox.

```js
const res = await context.http.get("https://example.com/api", {
  timeoutMs: 8000,
  headers: { accept: "application/json" },
});
// res = { status, statusText, headers, url, body }
res.status;        // number, e.g. 200
res.headers;       // { "content-type": "application/json", ... }
res.url;           // final URL after any redirects
res.body;          // full response body as a UTF-8 string

const data = await context.http.getJson("https://example.com/api"); // parsed
await context.http.request({ method: "POST", url, body, headers }); // any method
```

- **GET** is the common case; `request()` supports other methods.
- A response is **data, not an error condition on status alone** — a `404`
  resolves normally so the plugin can inspect it. Only transport/policy
  problems reject.
- **No browser.** This is a plain HTTP client: no DOM, no JS execution, no
  scraping, no media/stream extraction. (See "Deliberate non-provisions" in
  ARCHITECTURE.md.)

### Limits (engine-enforced, plugin can only lower them)

Every option a plugin passes is clamped against hard engine maximums so a
plugin can never force an unbounded request:

| Limit | Default (engine maximum) |
| --- | --- |
| `timeoutMs` (per request) | 30 000 ms (absolute cap) |
| `maxResponseBytes` | 50 MiB hard cap |
| `maxRedirects` | 10 hops |
| header name/value length & count | bounded |

`timeoutMs`, `maxResponseBytes`, and `maxRedirects` may be supplied per call
and are **clamped down** to these caps — a plugin can make a stricter limit,
never a looser one. The engine maximums themselves are configurable at
runtime construction via `new PluginRuntime({ http: { limits } })`.

### Error model

HTTP failures reject with a **structured** object (never a host stack trace):

```js
{ code: "HTTP_TIMEOUT", message: "Request timed out after 8000 ms" }
```

Possible `code` values: `HTTP_INVALID_URL`, `HTTP_UNSUPPORTED_SCHEME`,
`HTTP_TIMEOUT`, `HTTP_ABORTED`, `HTTP_NETWORK_ERROR`,
`HTTP_RESPONSE_TOO_LARGE`, `HTTP_TOO_MANY_REDIRECTS`, `HTTP_INVALID_REQUEST`,
`HTTP_INVALID_JSON`, `HTTP_INTERNAL_ERROR`.

### Security model

- **URLs must be absolute `http:`/`https:`.** `file:`, `data:`,
  `javascript:`, `node:`, and every other scheme are rejected. Relative URLs
  and anything that is not a valid absolute URL are rejected.
- **Redirects are re-validated** against the same policy on every hop, and the
  hop count is bounded — a redirect cannot escape to `file:` or to a
  disallowed host.
- **Headers are validated** (name/value character sets and lengths) and the
  engine sets a small default `User-Agent`; host credentials and environment
  information are never forwarded.
- **No circumvention tooling.** This client does not include CAPTCHA solving,
  Cloudflare/DRM/auth bypass, or any other security-control avoidance. It is a
  plain, robust HTTP client and nothing more.
- **Cancellation.** A request is tied to its executing operation: when the
  operation's time limit trips or the plugin is disposed, in-flight requests
  are aborted on the host side so nothing runs away.

### Testing

HTTP behavior is tested entirely against a **local** test server on
`127.0.0.1` (see `tests/http.test.ts`); the test suite never depends on the
public Internet.

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — overall architecture. Phases 1–4
  components are implemented; the rest is planned design.

## Constraints

- TypeScript, Node.js, npm; minimal dependencies.
- No Electron, Flutter, React, Next.js, full web frameworks, databases,
  Chromium, or Playwright.
- No Cloudflare bypass, CAPTCHA solving, DRM/authentication bypassing, or
  other security-control circumvention.

## Rules for future phases

1. Inspect the repository before modifying it; previous code may be
   incomplete or inconsistent.
2. Run `npm test` before declaring a phase complete.
3. Keep changes small and understandable.
4. Do not implement future phases early; do not ship placeholder code.
5. Never commit secrets, tokens, or credentials.
