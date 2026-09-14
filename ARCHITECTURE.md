# Architecture (planned)

Status: the layering below is the overall design. **Phases 1 (foundation),
2 (plugin manifest + loader), 3 (sandboxed plugin runtime), 4
(engine-controlled HTTP), 5 (HTML + JSON parsing capabilities), and 6
(normalized source result pipeline) are implemented; everything else is
still planned and not implemented.**

## Layering

```
Application
    ↓
Plugin Engine          (implemented: normalized source result
                       pipeline — raw → validated → normalized)
    ↓
Plugin Runtime
    ↓
Plugin API            (implemented: manifest, log, http, json, html)
    ↓
HTTP / HTML / JSON capabilities
                      (implemented: HTTP, HTML parsing + selection,
                       JSON parsing + serialization)
    ↓
External websites
```

- **Application** — the future media/streaming application. It is a
  separate technology that consumes this engine; it is *not* part of this
  repository.
- **Plugin Engine** — owns plugin lifecycle: discovery, loading,
  enable/disable, parallel execution, timeouts, error isolation, testing,
  and benchmarking.
- **Plugin Runtime** — executes plugin code in a sandboxed JavaScript
  environment. Target: a lightweight JavaScript runtime; plugins must never
  reach Node.js APIs or the host directly.
- **Plugin API** — the only surface a plugin may call. Small, stable,
  and versioned.
- **Capabilities** — HTTP requests, HTML parsing, JSON parsing. Plugins
  never perform raw I/O; all external interaction goes through capabilities
  the runtime exposes.
- **External websites** — untrusted and out of scope. A website is only
  touched when a plugin explicitly requests it through the API.

## Implemented so far

### Phase 1 — Foundation

TypeScript + Node.js project scaffold, toolchain, tests.

### Phase 2 — Plugin manifest and loader (metadata only)

- `PluginManifest` (`src/types.ts`) — the strongly typed plugin manifest
  format. Required fields: `id`, `name`, `version`, `entry`. Optional
  fields: `author`, `description`, `domains`. Unknown fields are rejected.
  IDs use a predictable safe format: lowercase letters, digits, and hyphens
  separated by dots (e.g. `example.source`).
- `validateManifest` (`src/manifest.ts`) — validates a candidate manifest
  (treated as untrusted input). Returns the validated manifest or a list of
  human-readable errors; never silently repairs invalid input. Rejects
  missing/invalid required fields, non-semantic versions, unknown fields,
  and entries with absolute paths, backslashes, or `..` traversal.
- `PluginLoader` (`src/loader.ts`) — loads plugin metadata from a plugin
  directory: locates `manifest.json`, parses and validates it, and resolves
  the entry path safely inside the plugin directory.
- `PluginManager` (`src/manager.ts`) — in-memory registry. Discovers plugin
  directories, loads valid manifests, prevents duplicate plugin IDs, and
  supports get/list/unregister. A broken plugin is recorded as a problem
  and never aborts discovery of the others.
- `Plugin` (`src/types.ts`) — internal plugin representation:
  `pluginPath`, optional `manifest` and `entryPath`, `status`
  (`discovered` | `loaded` | `invalid` | `failed`), optional `errors`.

**Plugin JavaScript execution is intentionally not implemented in Phase 2.**
The loader reads and validates manifests only; executing plugin code in a
sandbox is the responsibility of the Plugin Runtime in Phase 3.

Example plugin: `plugins/example/` (manifest.json + plugin.js) is used by
the tests and the `npm run plugins:list` CLI.

### Phase 3 — Sandboxed plugin runtime (executes plugin code)

- Runtime technology: **QuickJS compiled to WebAssembly**
  (`quickjs-emscripten`). QuickJS is a mature, actively maintained
  embedded JavaScript engine. It runs as a *separate* engine from the
  host Node.js process, so plugin realms contain no Node.js globals, no
  host objects, and no built-in modules by construction. `node:vm` was
  explicitly rejected: it is documented by Node.js as not a security
  boundary.
- `PluginRuntime` (`src/runtime.ts`) — loads a plugin's entry module into
  a fresh, isolated QuickJS runtime (one per plugin, capped guest heap),
  inspects the `plugin` export to detect capabilities, executes them with
  JSON arguments + a controlled context, and returns structured results.
  Execution uses QuickJS interrupt hooks for timeouts and a host-side
  deadline for promises that never settle.
- Plugin contract — the entry module (ES module) exports an object named
  `plugin`; each function property is a capability. Capabilities receive
  their arguments first and the `PluginContext` last.
- `PluginContext` (`src/types.ts`) — the only host surface a plugin
  receives: `manifest` (read-only) and `log(...)`. Deliberately tiny in
  Phase 3.
- `PluginExecutionResult` / `PluginLoadResult` / `PluginRuntimeError`
  (`src/types.ts`) — consistent structured outcomes with measured
  execution times; error types: `PLUGIN_LOAD_ERROR`,
  `PLUGIN_EXPORT_ERROR`, `PLUGIN_RUNTIME_ERROR`, `PLUGIN_TIMEOUT`,
  `PLUGIN_MEMORY_LIMIT`, `PLUGIN_CAPABILITY_NOT_FOUND`.
- Module loading — a per-plugin module loader resolves `import` specifiers
  ONLY to files inside the plugin's own directory; host/built-in
  (`node:*`), absolute, and escaping (`..`) imports are rejected.

**Plugin JavaScript execution is implemented in Phase 3, but no network,
scraping, or HTML APIs.** In Phase 3 the sandbox had no capability to reach
a website at all. The engine-controlled HTTP capability is added in Phase 4
(below); HTML parsing, DOM, and scraping remain deliberately unimplemented.

Sandbox limitations (do not mistake engine isolation for OS isolation):

- QuickJS runs in-process on WebAssembly: this is engine-level isolation,
  NOT an OS-level security boundary.
- CPU DoS is bounded by the per-operation timeout; memory is bounded by
  the per-plugin heap limit; both are configurable `PluginRuntimeOptions`.
- A bug in the engine/Wasm boundary is outside the sandbox's reach.
- Future hardening: per-plugin OS-level isolation and a
  capabilities-based Plugin API.

### Phase 4 — Engine-controlled HTTP capability

A plugin can now reach external websites, but **only** through a small,
engine-moderated HTTP capability. The key architectural decision is that
**the plugin never performs the network I/O itself**: the sandbox has no
networking, and every request is executed on the host on the plugin's
behalf, then reduced to a plain serializable object before re-entering the
sandbox.

Request flow:

```
Plugin code (QuickJS sandbox)
    ↓  context.http.get(url, options)      ← the ONLY path to the network
PluginContext.http  (thin guest function; returns a Promise)
    ↓  (args serialized across the Wasm boundary)
PluginRuntime (host)  — per-operation AbortController
    ↓
HttpClient (host)     — validate URL/headers, clamp limits, fetch,
                        bounded read, redirect loop, size/timeout enforcement
    ↓  Node fetch (undici)
External website
    ↑  response
Normalized HttpResponse { status, statusText, headers, url, body }
    ↓  (JSON-serialized back across the Wasm boundary)
Plugin receives a plain object (or a structured { code, message } error)
```

- `context.http` (`src/types.ts`) — the guest surface: `get(url, options?)`,
  `getJson(url, options?)`, and `request(options)` (any method). A response
  is `{ status, statusText, headers, url, body }` — a number, strings, and
  a plain header object. Nothing host-internal (no sockets, streams, or
  `Buffer`) is ever handed to the sandbox.
- `HttpClient` (`src/http.ts`) — the host implementation. It is a pure
  TypeScript class built on Node's built-in `fetch` (undici) with no added
  dependencies. It owns: URL/scheme validation, header validation, limit
  clamping, timeout enforcement, bounded response reading, and the
  re-validating redirect loop.
- **Limits.** Plugin-supplied `timeoutMs`, `maxResponseBytes`, and
  `maxRedirects` are clamped against hard engine maximums
  (`DEFAULT_HTTP_LIMITS`): 30 s, 50 MiB, and 10 hops. The engine maximums
  are overridable only at runtime construction
  (`new PluginRuntime({ http: { limits } })`) — a plugin can never raise
  them. Oversized responses abort the connection and reject with
  `HTTP_RESPONSE_TOO_LARGE` without streaming the body into the guest.
- **Errors.** Failures reject with a structured `{ code, message }` object
  (see `HTTP_ERROR_CODES`), never a host stack trace. Examples:
  `HTTP_TIMEOUT`, `HTTP_INVALID_URL`, `HTTP_UNSUPPORTED_SCHEME`,
  `HTTP_RESPONSE_TOO_LARGE`, `HTTP_TOO_MANY_REDIRECTS`,
  `HTTP_NETWORK_ERROR`, `HTTP_INVALID_JSON`.
- **Security.** URLs must be absolute `http:`/`https:`; other schemes
  (`file:`, `data:`, `javascript:`, `node:`, …) and relative URLs are
  rejected. Each redirect hop is re-validated against the same policy and
  counted. Headers are validated and a small engine default `User-Agent` is
  set; host credentials/environment are never forwarded. There is **no**
  CAPTCHA/Cloudflare/DRM/auth-bypass or other circumvention logic — this is
  a plain, robust HTTP client only.
- **Cancellation & concurrency.** Each executing operation gets its own
  `AbortController`; when the operation's time limit trips or the plugin is
  disposed, all of its in-flight HTTP requests are aborted on the host, so
  nothing runs away. Concurrency is per-plugin by construction (one QuickJS
  runtime per plugin); a per-plugin cap on simultaneous in-flight requests
  is future work, not a global scheduler.

**Deliberate non-provisions (Phase 4)** — intentionally NOT implemented, by
design: browser automation (no Chromium/Playwright/Puppeteer), DOM/HTML
parsing, CSS/XPath selection, scraping frameworks, in-page JS execution,
stream/M3U8/media extraction, provider-specific logic, and any
CAPTCHA/Cloudflare/DRM/proxy/auth-bypass capability. The engine performs
plain HTTP only.

### Phase 5 — HTML + JSON parsing capabilities

Parser-only data capabilities layered on top of Phase 4. Plugins can now
turn HTTP responses into structured data; the engine — not the plugin —
owns all parsing.

- **`context.json` (guest-side).** A small static engine-authored source
  (`PHASE5_JSON_GUEST_SOURCE` in `src/phase5.ts`) is evaluated into the
  guest once per operation. It wraps the guest's native JSON, so no value
  crosses the Wasm boundary for JSON work: `parse(text)` never evaluates
  code, and `stringify(value)` reports circular structures as a structured
  `JSON_STRINGIFY_ERROR` instead of silently dropping data. Both functions
  are synchronous and throw structured `{ code, message }` objects
  (`JSON_INVALID_INPUT`, `JSON_INPUT_TOO_LARGE`, `JSON_INVALID`,
  `JSON_STRINGIFY_ERROR`, `JSON_OUTPUT_TOO_LARGE`).
- **`context.html` (host-bridged).** `parse` / `select` / `extract` are
  host functions: the guest's document/element tree (plain JSON) crosses
  the boundary via the runtime's dump, the work happens host-side, and the
  result (plain JSON) crosses back. On success the value is returned
  synchronously; on failure the guest receives a **rejected promise**
  carrying a structured `{ code, message }` object (the same error path
  HTTP failures use). Unexpected host exceptions are mapped to fixed safe
  messages — host details never reach the guest.
- **Parser stack.** HTML parsing uses the mature, lightweight
  **htmlparser2** parser (permissive, browser-like error recovery),
  **css-select** for selector matching, and **dom-serializer** for
  `innerHTML`/`outerHTML` — the same parser core cheerio is built on. The
  earlier hand-rolled parser prototype was replaced because it could not
  reliably handle all HTML edge cases (e.g. `>` inside quoted attribute
  values, raw-text elements). The selected packages are small, pure
  JavaScript, self-typed, and widely maintained; adding them was an
  explicit exception to the minimal-dependency rule, justified by
  correctness.
- **Document model.** `parse` returns a JSON-serializable tree:
  `{ type: "document", children: [...] }` with `element`
  (`tagName`, `attributes`, `children`), `text`, and `comment` nodes.
  `<script>`/`<style>` contents become plain text data (never executed);
  `select` returns matched element nodes; `extract` returns the info
  object (`tagName`, normalized `text`, `attributes`, `href`, `src`,
  `class`, `id`, `data` (data-* without prefix), `innerHTML`,
  `outerHTML`).
- **Limits.** `PHASE5_LIMITS`: 5 MiB HTML input (UTF-8), 5 MiB JSON input
  and output, 50,000 parsed nodes, and 1,000 `select` results. Node
  counting happens *during* parsing (counting handlers on the parser), so
  a pathological document aborts at the limit instead of being fully
  materialized. `select` rebuilds the tree, wires ancestor/sibling
  pointers, and runs css-select on it — the matching work is bounded and
  does not run guest code.
- **Security.** Parsing is data-only: no JavaScript execution, no event
  handlers, no resource loading, no following of `href`/`src`, no
  filesystem or environment access. `javascript:` URLs and `on*` handler
  attributes survive only as inert strings. The network surface remains
  exclusively `context.http`. All limits are engine constants that
  plugins cannot raise.

**Deliberate non-provisions (Phase 5)** — intentionally NOT implemented,
by design: media/stream (M3U8/MP4) extraction, playback, DRM/CAPTCHA/
Cloudflare/auth bypass, browser automation, in-page JavaScript execution,
DOM mutation, and any fetching of parsed URLs.

### Phase 6 — Normalized source result pipeline

Plugins can now return structured **source results** to the future
application through a validated, normalized pipeline. The architectural
decision: **the plugin produces raw structured data; the engine produces
trusted normalized data.** The guest never performs validation or
normalization itself, and the application never consumes raw plugin
output directly.

Result flow:

```
External website
    ↓
context.http (Phase 4)
    ↓
context.html / context.json (Phase 5)
    ↓
Plugin logic (QuickJS sandbox) — transforms extracted data
    ↓
RAW source results (unknown — untrusted plain data;
execute() returns it untouched — Phase 1–5 behavior preserved)
    ↓
normalizeSourceResults(raw)  (host, src/results.ts)
    ↓  extract raw list → validate item (typed fields, required checks,
       URL policy) → normalize (trim, canonical URLs, safe metadata)
Normalized SourceResult[]  (trusted, JSON-serializable)
    ↓
Future application
```

- **Result model** (`src/results.ts`) — `SourceResult`: required
  `id`, `title`, `type` (closed enum: `movie`, `episode`, `series`,
  `search`, `source`), `url`; optional `source`, `thumbnail`, `quality`,
  `language`, `subtitles` (`{ url, language?, format? }`), and a flat
  scalar `metadata` map (always present; empty when absent). The model
  is strictly typed (no `any`; raw input is `unknown`), extensible
  without breaking, and deliberately free of media/DRM/stream concerns.
- **Three data stages** — raw plugin output (`unknown`), validated
  results (typed intermediate with parsed URLs), and normalized
  `SourceResult` (canonical strings/URLs, safe metadata). The public
  entry point is one function: `normalizeSourceResults(raw)` returning
  `{ ok: true, results } | { ok: false, error: { code, message } }`.
- **Validation policy** — all-or-nothing: an invalid required field or a
  size violation rejects the whole input with a structured error that
  names the item and field (`result[3]: field 'url': ...`). Invalid
  OPTIONAL values are dropped instead of being fatal (e.g. a malformed
  thumbnail URL). Duplicate `id`s keep the first occurrence.
- **URL policy** — `url`, `thumbnail`, and subtitle URLs must be
  absolute `http:`/`https:` URLs; other protocols (`javascript:`,
  `file:`, `data:`, `ftp:`, …) and relative URLs are rejected/dropped.
  Result URLs are **never fetched or verified** — they are data.
- **Limits** (`RESULT_LIMITS`) — 1,000 results; field length caps
  (`id` 200, `title` 500, URL 2,048, `source` 200, `quality` 50,
  `language` 20, subtitle `format` 30); 50 subtitles per result;
  metadata: 64 keys, 100-char keys, 500-char string values, 8 KiB
  serialized. Explicit engine constants; plugins cannot raise them.
- **Security** — every field is strictly type-checked (functions,
  Dates, nested objects, NaN/Infinity, and null are rejected); metadata
  keys `__proto__`, `constructor`, and `prototype` are rejected
  (prototype-pollution protection) and metadata is rebuilt as a fresh
  plain object; the input is never mutated; unexpected internal errors
  map to a fixed safe message. The pipeline is pure host logic — no
  network, no filesystem, no QuickJS.
- **Plugin contract** — unchanged and simple: the capability returns a
  result object or an array of them (plain JSON-serializable data).
  `execute()` semantics are untouched; normalization happens at the
  engine/app boundary, keeping Phases 1–5 behavior fully backward
  compatible.

**Deliberate non-provisions (Phase 6)** — intentionally NOT implemented,
by design: media/stream extraction, downloading, playback, DRM/CAPTCHA/
Cloudflare/auth bypass, browser automation, fetching or verifying result
URLs, result caching, and automatic crawling.

## Planned plugin entry-point types (not implemented)

- Search
- Details
- Episodes
- Sources

## Planned engine features (not implemented)

- Plugin enable/disable (the manager only has registry-level unregister)
- Parallel plugin execution with per-plugin timeouts
- Testing and benchmarking hooks

(Implemented so far: manifest schema + validation, discovery, loading,
manager, sandboxed JavaScript execution, controlled context, per-operation
timeouts, memory limits, error isolation at the load/execute level,
engine-controlled HTTP with limits, structured errors, and cancellation,
HTML + JSON parsing capabilities with engine-enforced limits and
structured errors, and the normalized source result pipeline with
central validation, normalization, and explicit limits.)

## Design constraints

- TypeScript, Node.js (development and testing), npm; minimal dependencies.
- No Electron, Flutter, React, Next.js, full web frameworks, databases,
  Chromium, or Playwright.
- Must remain compatible with running inside a lightweight JavaScript
  runtime in the future.
- No Cloudflare bypass, CAPTCHA solving, DRM or authentication bypassing,
  or other security-control circumvention — by design, out of scope.

## Phase roadmap (indicative, not a contract)

- **Phase 1** — Repository foundation, toolchain, this document. *(complete)*
- **Phase 2** — Plugin manifest schema, validation, discovery, loading,
  plugin manager, example plugin, CLI. *(complete)*
- **Phase 3** — Sandboxed plugin runtime (QuickJS/Wasm), plugin export
  contract, controlled context, timeouts, memory limits, error isolation,
  `plugin:run` CLI. *(complete)*
- **Phase 4** — Engine-controlled HTTP capability: `context.http`
  (get/getJson/request), engine-enforced limits, structured error model,
  redirect re-validation, cancellation on operation end. *(complete — HTTP
  only; HTML parsing, enable/disable, standard entry points, and parallel
  execution are deliberately deferred to later phases.)*
- **Phase 5** — HTML + JSON parsing capabilities: `context.json`
  (parse/stringify, bounded, guest-side) and `context.html`
  (parse/select/extract on htmlparser2 + css-select, bounded, data-only),
  structured error model, engine-enforced size/node/result limits.
  *(complete)*
- **Phase 6** — Normalized source-result pipeline: `SourceResult` model,
  `normalizeSourceResults()` (raw → validated → normalized), http/https
  URL policy, explicit limits, prototype-pollution-safe metadata,
  structured errors. *(complete)*
- **Phase 7** — Testing and benchmarking tooling.
