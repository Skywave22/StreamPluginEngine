# Architecture

Status: the layering below is the implemented design of the FINAL project
state. **All six runtime phases are implemented: Phase 1 (foundation), 2
(plugin manifest + loader), 3 (sandboxed plugin runtime), 4
(engine-controlled HTTP + network policy), 5 (HTML + JSON parsing
capabilities), and 6 (normalized source result pipeline). Phase 7 is
final validation and developer-only tooling — it adds no runtime
capability. The engine is complete.**

**v0.2.0 — the enforcement layer.** A review of 0.1.0 found that a
manifest's `domains` were validated and stored but never read (a field
that promised a restriction the engine did not apply) and that every
plugin automatically received every capability. v0.2.0 closes both gaps
without adding a phase: the six phases above remain the runtime, and the
Plugin API gained a host-side ENFORCEMENT layer around the capabilities
that already existed (see "v0.2.0 — Enforcement layer" below). No
guest-visible capability was added, and a plugin that declares no domains
and is granted the default permissions sees exactly the 0.1.0 surface.

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
- **Plugin API** — the only surface a plugin may call. Small, stable, and
  versioned (`ENGINE_API_VERSION`). Since v0.2.0 each capability is also
  individually grantable: the host decides which parts of the surface a
  given plugin receives, and undeclared network hosts are refused.
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
  `HTTP_FORBIDDEN_TARGET`, `HTTP_NETWORK_ERROR`, `HTTP_INVALID_JSON`.
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
  nothing runs away. Operations on ONE plugin are **serialized** (see
  `LoadedPluginHandle.queue` in `src/runtime.ts`): a QuickJS runtime has a
  single interrupt-handler slot and a single job queue, so overlapping
  operations would race on the timeout guard and could leave an operation
  running with no deadline at all. Different plugins have different runtimes
  and still execute concurrently. A per-plugin cap on simultaneous in-flight
  requests is future work, not a global scheduler.
- **Network policy (SSRF defence).** `src/network.ts` decides which request
  TARGETS are reachable, independently of the scheme check. By default
  loopback, RFC 1918, CGNAT, link-local (including cloud metadata endpoints
  such as `169.254.169.254`), multicast, and other reserved ranges are
  rejected with `HTTP_FORBIDDEN_TARGET` before any I/O. Hostnames are
  resolved and EVERY resolved address is checked, so a name pointing at an
  internal host is rejected too. IPv4-mapped IPv6 (`::ffff:7f00:1`) and
  IPv4-embedding tunnel prefixes (6to4, NAT64, Teredo) cannot be used to
  smuggle a blocked address. The check runs on the initial URL and on every
  redirect hop. A host application may opt in to private ranges with
  `{ http: { network: { allowPrivateNetwork: true } } }` — that is what
  local development and the offline test suite use. A plugin can never
  influence the policy.
  Residual risk, stated plainly: the policy resolves DNS to decide, and the
  request resolves DNS again to connect, so a hostile authoritative server
  can still rebind between the two. Closing that needs connection-level
  address pinning, which is beyond a lightweight engine; deployments running
  untrusted plugins should also apply OS/network-level egress controls.

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
- **Deep-structure behavior.** All host-side tree transforms are
  iterative, so the host API (`parseHtml`/`selectHtml`/`extractHtml`)
  supports the full node budget including 50,000-deep chains. The
  `apiVersion: 2` handle path never delivers a tree into the sandbox, so it
  has no nesting limit at all. The legacy `apiVersion: 1` path does
  deliver one, and caps nesting at `PHASE5_LIMITS.maxHtmlDeliveryDepth`
  (128), failing deeper documents with a structured `HTML_PARSE_ERROR`
  naming the limit. That cap is an enforced constant, because the depth at
  which delivery exhausts the stack is a property of the host platform, not
  of the document: before the cap, a 300-level document parsed on Ubuntu
  and failed on macOS. Per-element extraction/serialization of extremely
  deep subtrees similarly fails structured (`HTML_EXTRACT_ERROR`). 128
  levels is far beyond real-world HTML (renderers stop far below that), and
  the behaviour is now identical on every operating system.
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

### v0.2.0 — Enforcement layer (no new phase)

Four related gaps, all of the same kind: the engine described a
restriction or a contract without enforcing it. The fix in each case is
host-side and structural — the plugin contract itself is unchanged.

**1. Declared domains are enforced, not documented.**
`src/network.ts` gained a declared-domain allowlist
(`normalizeDomainPattern`, `domainPatternMatches`, `isHostAllowed`,
`checkDeclaredDomain`) and `src/http.ts` applies it to the initial URL
**and every redirect hop**, before DNS and before any I/O. The two gates
are deliberately independent and answer different questions:

```
                       request URL (host side)
                              ↓
   ┌──────────────────────────────────────────────────────┐
   │ 1. DECLARED-DOMAIN gate   src/network.ts             │
   │    "is this host inside the surface the plugin       │
   │     told the user about?"  (manifest `domains`)      │
   │    no DNS · no I/O · fail closed on bad patterns     │
   └──────────────────────────────────────────────────────┘
                              ↓
   ┌──────────────────────────────────────────────────────┐
   │ 2. NETWORK gate           src/network.ts             │
   │    "is this address reachable at all?"  (SSRF)       │
   │    loopback/RFC1918/link-local/etc. blocked,         │
   │    every resolved address checked                    │
   └──────────────────────────────────────────────────────┘
                              ↓
                        Node fetch (undici)
```

Semantics are exact-label and deterministic: a bare domain covers the
apex and subdomains, `*.example.com` covers subdomains only, matching is
case- and trailing-dot-insensitive, IDN is canonicalised to punycode, and
`allowed.example.evil.test` does NOT match `allowed.example`. Malformed
patterns never match (fail closed, so a typo cannot widen access).
Backward compatible by construction: **no declared domains ⇒ no
restriction from this gate**, and the host can disable enforcement
(`enforceManifestDomains: false`) or widen every plugin
(`extraAllowedDomains`). Both are host decisions a plugin cannot
influence — the same trust rule the network policy already followed.

**2. Capability permissions (deny per plugin, host-side).**
`PluginPermissions` (`http`, `json`, `html`; all present by default)
resolves in `PluginRuntime` as: per-plugin override → runtime default →
enabled. A disabled capability is **not installed on the context object**
at all (`buildPluginContext`), so there is nothing for guest code to
detect, wrap, or re-enable; `http: false` removes the plugin's entire
network surface. The granted set is exposed host-side as
`LoadedPlugin.permissions` for audit. This is "capability-based API"
applied where it actually bites: at the boundary where the host builds the
guest's context, not as a runtime check inside the guest.

**3. Plugin API versioning.** `ENGINE_API_VERSION` (currently 1) names the
plugin↔engine contract (context surface + capability semantics).
`validateManifest` rejects a manifest whose `apiVersion` exceeds it, so an
incompatible plugin fails at validation with a clear message instead of
mysteriously at runtime. Absent means 1 — the original contract.

**4. Enable/disable is engine-owned.** `PluginManager` tracks disabled
IDs; the state survives `discoverPlugins()` and `Plugin.enabled` carries
it to the runtime, which refuses to load a disabled plugin
(`PLUGIN_DISABLED`) — so "disabled" means no plugin code is evaluated,
not merely "hidden from the list". Persistence stays an application
concern, as before.

**What did NOT change:** no guest-visible capability, no phase bump
(`ENGINE_PHASE` stays 6), no change to `execute()` semantics, the result
pipeline, or the sandbox isolation model. Error codes, limits, and the
"engine-authored messages only" rule continue to apply to the new
`HTTP_DOMAIN_NOT_ALLOWED` path.

### v0.3.0 — App-readiness and the boundary fast path (no new phase)

Three changes, all in service of one question: *can an application play
what this engine returns, and can it ask many plugins at once?*

**1. Playback metadata is now part of the trusted result.**
`SourceResult` gained `format` (closed container/playlist enum) and
`headers`; subtitles gained `name` and `headers`. This is a deliberate
exception to "results are inert data": an application hands these to a
player, so they are validated the way request headers are (token names,
CR/LF/NUL rejected, bounded count/length, hop-by-hop and request-forging
names denylisted). The engine still never fetches or plays a result URL.
Rationale: a resolved media URL without its `Referer` is not playable,
which made the Phase 6 model unusable for real sources.

**2. `PluginCoordinator` owns multi-plugin fan-out.**
The runtime serializes operations on ONE plugin (a QuickJS runtime has a
single interrupt slot and job queue). The coordinator adds the missing
scheduling layer *outside* the runtime:

```
Application
    ↓  coordinator.collectSources(plugins, args)
PluginCoordinator        bounded concurrency, per-plugin isolation,
    ↓                    deterministic ordering
PluginRuntime.execute(plugin, "sources", args)      ← unchanged
    ↓
normalizeSourceResults(value)   ← per plugin, so one bad plugin
    ↓                             cannot spoil the merged list
merge → dedupe by canonical URL → rank by quality → SourceResult[]
```

It is host-side policy only: it performs no I/O and executes no guest
code itself, and it accepts any `PluginExecutor`, so an application can
wrap or stub the runtime. Bounded by `concurrency` (default 4); one
plugin's failure, timeout, or invalid output is reported per plugin and
never fails the batch. Speed is claimed only where it is real: fan-out
overlaps *waiting*, measured at 3.8x for 4 plugins against a 120 ms
source, and ~1.2x against a zero-latency loopback fixture.

**3. The sandbox boundary left the HTML hot path (plugin API v2).**
Version 1 shipped the parsed document INTO the guest and serialized
matched nodes back OUT on every call, so the Wasm boundary dominated:
`select` cost ~5.5 ms of which the parser was ~0.3 ms. Version 2 keeps
the tree in `LoadedPluginHandle.htmlHandles` and crosses integers:

```
v1:  html.parse(html)            host → guest : entire document tree
     html.select(doc, sel)       guest → host : tree again
                                 host → guest : matched element nodes
     html.extract(el)            guest → host : element again

v2:  html.parse(html)     → id    (a number)
     html.select(id, sel) → id[]  (numbers)
     html.extract(id)     → info  (a small object)
```

Consequences beyond speed (6.5x / 7.1x / 4.7x measured): no value is
delivered into the guest for HTML work, so the legacy nesting limit that
the tree-based API needs does not apply; hand-built document objects can no longer be fed to the
selector engine; and the handle table is bounded per call
(`PHASE5_LIMITS.maxHtmlHandles`) and cleared when the call ends — which
is what makes `HTML_STALE_HANDLE` a structured answer rather than a
cross-call surprise. `ENGINE_API_VERSION` is 2; the runtime selects the
implementation per plugin from the manifest's `apiVersion`, so v1
plugins behave exactly as before.

**What did NOT change:** no new phase (`ENGINE_PHASE` stays 6), no
guest-visible capability beyond the v2 html surface, the same permission,
domain, SSRF, timeout, memory and result limits, and the same rule that
every error a plugin can observe is engine-authored.

### v0.4.0 — Storage, settings, distribution (no new phase)

The three reference ecosystems were studied for this release. Two
conclusions shaped it: they all give plugins **persistence** (and we did
not), and none of them verify what they install.

**1. `context.store` — persistence without a bridge crossing.**

```
guest: context.store.get(key)          → host map lookup        (no Wasm traffic)
guest: context.store.set(key, value)   → validate + write in place
end of capability call                 → ONE backend.save() for everything written
```

```
PluginRuntime
   ├─ handle.store : PluginStore          ← loaded once at plugin load
   │    ├─ values (host-side map)         ← reads are local
   │    ├─ defaults (manifest settings)   ← visible before any write
   │    └─ dirty flag                     ← cleared only after a successful save
   └─ storeBackend : StoreBackend         ← in-memory default, injectable
```

The alternative design — `await store.get()` crossing the boundary per
read — is what an injected async KV API costs. Measured here: a read is
~6.5 µs, while one host round trip is ~290 µs.

Persisted data is untrusted input on the way back in: every entry is
re-validated at load, and anything that fails (bad key, oversized value,
forbidden key, wrong shape) is DROPPED rather than surfaced. A store that
returns garbage is worse than one that returns nothing.

**2. `settings[]` + `mirrors[]` — declared configuration, enforced.**

Settings exist so an application can render UI for a plugin it has never
seen. The engine's job is the part a UI cannot do:

- a `select` default must be one of its own options;
- a `mirror` default (and every later write to that key) must be one of
  the manifest's declared `mirrors`;
- `mirrors` themselves join the ENFORCED allowlist next to `domains`.

So "user picks a mirror" cannot become "plugin talks to an undeclared
host": the write is refused by the store, and the HTTP layer refuses the
host anyway.

**3. `PluginRegistry` — distribution with a hostile-server assumption.**

```
feed URL ──► validateRegistryFeed()   (format marker + version + every field)
                     │
        install(id) ─┴─► fetch entry ─► sha256 == feed.sha256 ?  ── no ──► REFUSE
                         fetch manifest ─► valid + id/version agree? ─ no ─► REFUSE
                     │
                     └─► write to .install-<id>-<pid>-<t>  ─► rename() ─► ./<id>
```

Fetch → verify → write, in that order, with nothing written on failure and
a staging directory that makes the final step atomic. The registry is a
pure host-side module: it runs no guest code, and its network access goes
through the same `HttpClient` the plugins use, so host policy applies.

**What did NOT change:** no new phase (`ENGINE_PHASE` stays 6),
`ENGINE_API_VERSION` stays **2** (store and `isLive` are additive —
existing plugins are unaffected and the version gate keeps meaning "needs
a contract this engine does not implement"), and the same permission,
domain, SSRF, timeout, memory and result limits.

## Planned plugin entry-point types (not implemented)

- Search
- Details
- Episodes
- Sources

## Future application concerns (deliberately out of engine scope)

These are concerns of the FUTURE APPLICATION that consumes this engine —
they are not engine phases and are not implemented here:

- Plugin enable/disable POLICY (the engine now owns and enforces the
  on/off state per plugin — `PluginManager.setEnabled` — but persisting it
  across process restarts, and deciding what should be disabled, remain
  application concerns)
- Parallel plugin execution with per-plugin scheduling (the runtime is
  concurrency-safe per plugin; a scheduler is an application concern)
- Benchmarking/observability dashboards. A minimal, developer-only
  benchmark harness exists (`tools/benchmark.mjs`, `npm run bench`); it is
  validation tooling, not a runtime feature, and is not part of the engine's
  public API or the test suite

(Implemented: manifest schema + validation, discovery, loading, manager,
sandboxed JavaScript execution, controlled context, per-operation
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

## Phase roadmap (complete)

- **Phase 1** — Repository foundation, toolchain, this document. *(complete)*
- **Phase 2** — Plugin manifest schema, validation, discovery, loading,
  plugin manager, example plugin, CLI. *(complete)*
- **Phase 3** — Sandboxed plugin runtime (QuickJS/Wasm), plugin export
  contract, controlled context, timeouts, memory limits, error isolation,
  `plugin:run` CLI. *(complete)*
- **Phase 4** — Engine-controlled HTTP capability: `context.http`
  (get/getJson/request), engine-enforced limits, structured error model,
  redirect re-validation, cancellation on operation end. *(complete — HTTP
  only; HTML parsing lands in Phase 5, and enable/disable policy and
  parallel scheduling are future-application concerns, not engine
  phases.)*
- **Phase 5** — HTML + JSON parsing capabilities: `context.json`
  (parse/stringify, bounded, guest-side) and `context.html`
  (parse/select/extract on htmlparser2 + css-select, bounded, data-only),
  structured error model, engine-enforced size/node/result limits.
  *(complete)*
- **Phase 6** — Normalized source-result pipeline: `SourceResult` model,
  `normalizeSourceResults()` (raw → validated → normalized), http/https
  URL policy, explicit limits, prototype-pollution-safe metadata,
  structured errors. **Final project phase.** *(complete)*

- **Phase 7** — Final validation and developer tooling. *(complete —
  developer-only; adds no production runtime capability)* An independent
  audit of the actual source, tests, and Git history found that the
  "Phase 6 is complete, no Phase 7 needed" claim was premature: the audit
  reproduced three real defects (a missing SSRF/network policy, a
  prototype-chain bug in response-header collection, and an
  interrupt-handler race that could hang the host process) plus a QuickJS
  teardown abort when a plugin was disposed mid-request. Those were fixed
  in the Phase 1–6 layers. Phase 7 is the validation layer that locks the
  fixes down and closes the coverage gaps the audit exposed: a network
  policy / SSRF regression suite, CLI end-to-end tests (the CLI had none),
  and lifecycle/concurrency/teardown tests. It also adds a small
  developer-only benchmark harness. Phase 7 changes no production runtime
  behaviour of its own.

**PROJECT COMPLETE.** Production runtime capabilities are Phases 1 → 6;
Phase 7 is developer-only validation tooling. The roadmap is closed.
