# Changelog

All notable changes to this project are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).
While the version is `0.x`, the plugin contract may still change; the
engine reports the contract revision it implements as `ENGINE_API_VERSION`.

## [0.4.0] — 2026-10-04

**Theme: what the other plugin systems have, without their trade-offs.**
Three ecosystems were studied for this release — Nuvio, SkyStream and
Vega — and every capability they share but this engine lacked was
implemented from scratch, then benchmarked against the same job done the
way they do it.

### Added

- **`context.store` — per-plugin persistent key-value storage.** The one
  capability every other system has and this engine did not (Vega's
  `kvStore`, SkyStream's `getPreference`/`setPreference`, Nuvio settings).
  Reads are **synchronous in guest code** and cost ~6.5 µs, because the
  store lives host-side and is loaded once per plugin: no Wasm round trip
  and no promise tick per read (a single host round trip measures ~290 µs,
  which is what a bridge-per-get design pays for every read). Writes are
  validated in place and the whole store is persisted **once per
  capability call**, so a plugin that writes 200 keys pays one save.
  Quotas are enforced host-side (256 keys, 64-char keys, 4 KiB per value,
  64 KiB per plugin, depth 8); values are deep-copied through a JSON round
  trip; `__proto__`/`constructor`/`prototype` are refused as keys and
  anywhere inside a value. Storage is a pluggable `StoreBackend`
  (in-memory default; file/MMKV/SQLite by injection). New permission:
  `store` (default true) — disabling it removes the capability and with it
  any way for a plugin to leave data behind.
- **Declarative settings (`settings[]`) and mirrors (`mirrors[]`).** A
  manifest can now declare settings with types `string | number | boolean
  | select | mirror`, so an application can generate UI without knowing the
  plugin: `{ key, type, default, label, description, options }`. Declared
  defaults are visible to the plugin through `context.store.get()` and a
  stored user value always wins. `mirrors` are alternate hosts for the same
  plugin, and they join the ENFORCED HTTP allowlist alongside `domains`;
  a `mirror`-typed setting may only ever hold one of the declared mirrors,
  enforced at write time, so a user choice cannot point a plugin somewhere
  its own manifest never declared.
- **`isLive` on results.** A boolean marking continuous streams (live HLS
  channels), so an application can skip resume-position bookkeeping, hide
  download actions and choose live-aware UI. Only a real boolean is
  accepted; `false` is preserved so "not live" stays distinguishable from
  "unknown".
- **`PluginRegistry` — distribution with integrity.** A feed URL yields a
  catalog; `install()` downloads, verifies and installs a plugin. Unlike
  the provider repositories this is modelled on, integrity is **required**:
  the feed must declare a sha256 per entry, the downloaded code must hash
  to it, and the manifest must agree with the feed on both id and version —
  all checked BEFORE anything is written. Installs are atomic (staged
  directory, then rename), so an interrupted install can never leave a
  half-written plugin for the loader to execute. `checkUpdates()` uses real
  semver ordering, pre-releases included.
- **`STANDARD_CAPABILITIES`** (`home`, `search`, `getDetails`,
  `getEpisodes`, `getSources`) — one vocabulary mapping onto Nuvio
  (`getStreams`), SkyStream (`getHome`/`search`/`load`/`loadStreams`) and
  Vega (`getPosts`/`getSearch`/`getMeta`/`getEpisodes`/`getStream`), so an
  application model can span all of them without per-provider adapters.
- New subpath exports: `stream-plugin-engine/store`,
  `stream-plugin-engine/registry`.
- Example `plugins/example-media` now demonstrates the mirror setting, a
  quality select, the persistent store (including a `lastRunAt` write) and
  a live channel flagged `isLive`.
- Tests: 278 → **316**. New suites: `store` (host-side validation, quotas,
  defaults, persistence), `store-runtime` (in-sandbox reads/writes,
  per-call persistence, gating, cross-plugin isolation, abuse), `registry`
  (feed validation, hash verification, atomic install, updates, and an
  end-to-end install → discover → execute).

### Changed

- `ENGINE_VERSION` is `0.4.0`. `ENGINE_API_VERSION` stays **2**: the store
  and result additions are backward compatible for existing plugins, and
  the version gate still means "this plugin needs a contract I do not
  implement".
- `PluginPermissions` gained `store`; `ResolvedPluginPermissions` therefore
  reports it, and the context surface is now
  `manifest + log + http + json + html + store`.
- `PluginRuntimeOptions` gained `storeBackend`.

### Fixed

- A failed store save no longer clears the dirty flag: the store stays
  marked for retry instead of silently losing the plugin's writes.
- Guest functions passed to `store.set()` are refused explicitly. QuickJS
  `dump()` renders a function as its own source text, so without the guard
  `set("f", () => 1)` would have quietly stored the string `"() => 1"`.

## [0.3.0] — 2026-10-04

**Theme: app-ready and faster.** 0.2.0 made the engine enforce what it
promises; 0.3.0 makes its output something an application can actually
play, and removes the sandbox boundary from the hot path.

### Added

- **Playback metadata on results.** `SourceResult` gained `format`
  (closed enum: `mp4`, `m3u8`, `mpd`, `mkv`, `webm`, `ts`, `other`) and
  `headers`. Subtitles gained `name` and per-subtitle `headers`. These
  are what an application needs to hand a URL to a player — most scraped
  media endpoints refuse to serve without a matching `Referer`. Because a
  player *uses* them, the engine validates them like request headers:
  token names, no CR/LF/NUL in values, bounded count/length, and a
  denylist of hop-by-hop/request-forging names (`host`, `connection`,
  `content-length`, `transfer-encoding`, `upgrade`, `keep-alive`, `te`,
  `trailer`, `proxy-connection`). Invalid entries are dropped; an
  over-count `headers` map rejects the input. The engine itself never
  fetches or plays a result URL.
- **`PluginCoordinator`** — multi-plugin fan-out. Runs a capability
  across many plugins with bounded concurrency, isolates failures per
  plugin, then `collectSources()` normalizes each contribution, merges,
  deduplicates by canonical URL (first wins), and ranks by quality
  (documented, deterministic ordering). Measured against a source with
  120 ms latency, 4 plugins resolve 4x faster than sequentially
  (494 ms → 129 ms per round); with a zero-latency loopback fixture
  there is nothing to overlap, so it is ~1.2x — both numbers are in
  `npm run bench`.
- **Per-plugin in-flight request cap** (`http.maxInFlightPerPlugin`,
  default 8). A plugin fanning out with `Promise.all` gets a structured
  `HTTP_TOO_MANY_REQUESTS` for the surplus instead of the host opening
  unbounded sockets. `0` disables the cap (host decision).
- **Plugin API version 2: handle-based `context.html`.** `parse` returns
  a numeric document handle, `select` returns numeric element handles,
  and only `extract` produces an object — the document tree stays
  host-side. Measured on the same 20-item catalog page:
  `parse` 3.28 → 0.50 ms, `select` 5.54 → 0.78 ms, `extract` x20
  8.63 → 1.82 ms (up to ~7x). Two further consequences: the ~500-level
  nesting limit is gone (nothing is delivered into the guest), and
  hand-built document objects can no longer be fed to the selector
  engine. Handles are valid for one capability call; a handle used later
  fails with the new structured code `HTML_STALE_HANDLE`, and the table
  is bounded by `PHASE5_LIMITS.maxHtmlHandles` (`HTML_HANDLE_LIMIT`).
  `ENGINE_API_VERSION` is now 2; manifests declaring 1 (or nothing) keep
  the tree-based behaviour unchanged, so no existing plugin breaks.
- **Second example plugin** (`plugins/example-media`, apiVersion 2): an
  app-shaped source plugin using handle-based HTML, `format`, playback
  headers, nested `select`, and structured error handling — fully
  offline.
- Tests: 246 → **278**. New suites cover playback-metadata validation,
  coordinator scheduling/isolation/merge/rank (through both a stub
  executor and the real sandbox), the in-flight cap, and the v2 HTML
  contract including deep documents, stale/forged handles, and v1
  backward compatibility.

### Changed

- `ENGINE_VERSION` is `0.3.0`; `ENGINE_API_VERSION` is `2`.
  `ENGINE_PHASE` stays `6` (no new phase).
- `npm run bench` now measures both HTML API versions side by side, the
  coordinator fan-out, and both the no-latency and realistic-latency
  fan-out cases.

### Notes

- Ranking (`qualityScore`) is exported so an application can reuse the
  same ordering the coordinator applies.
- The `PluginCoordinator` takes any object satisfying `PluginExecutor`,
  so an application can wrap or stub the runtime without subclassing it.

## [0.2.0] — 2026-10-04

**Theme: the engine now enforces what the manifest declares.** A review of
0.1.0 found that `domains` was validated and stored but never read —
documentation that promised a restriction the engine did not apply — and
that every plugin automatically received every capability. Both are fixed,
and the remaining gaps from that review (no CI, no linter, no packaging
metadata, no security policy) are closed.

### Added

- **Enforced manifest domains.** When a plugin declares `domains`, its
  `context.http` requests — including **every redirect hop** — are limited
  to those hosts. Anything else fails with the new structured code
  `HTTP_DOMAIN_NOT_ALLOWED` **before any I/O**. A plugin that declares no
  domains is unrestricted by this gate (backward compatible), and the host
  can switch enforcement off with
  `{ http: { enforceManifestDomains: false } }`. Host-level
  `extraAllowedDomains` can widen every plugin's allowlist (e.g. a shared
  CDN or a test fixture host). Pattern semantics: a bare domain matches the
  apex and subdomains, `*.example.com` matches subdomains only, matching is
  case- and trailing-dot-insensitive, IDN patterns are canonicalised to
  punycode, and matching is label-anchored (`allowed.example.evil.test` is
  NOT `allowed.example`). Malformed patterns fail closed.
- **Per-plugin capability permissions.** `permissions` (runtime default)
  and `perPluginPermissions` (per plugin ID) can turn `http`, `json`, or
  `html` off. A disabled capability is **absent from the context object**,
  not a function that throws; `http: false` removes the plugin's entire
  network surface. The granted set is introspectable host-side on
  `LoadedPlugin.permissions`. Guests cannot detect, request, or re-enable a
  disabled capability.
- **Plugin API versioning.** `ENGINE_API_VERSION` (currently `1`) is
  exported, and a manifest may declare `apiVersion`. A plugin requiring a
  newer version than the engine implements is rejected at validation time
  (loudly, with a clear message) instead of failing mysteriously later.
- **Engine-owned enable/disable.** `PluginManager.setEnabled/enable/disable`,
  `isEnabled`, `listDisabledIds`, and `Plugin.enabled`. The state survives
  rediscovery, and the runtime refuses to load a disabled plugin with the
  new error type `PLUGIN_DISABLED` — disabled means "no plugin code runs".
- **`cli validate <pluginDir | manifest.json>`** — plugin-author tooling:
  runs the engine's own validator and reports every problem (manifest
  fields, entry file, API version, declared domains) with exit code 0/1.
- **`--plugins-dir <dir>`** for `cli list` and `cli run`, so the CLI no
  longer depends on the current working directory.
- **CI** (`.github/workflows/ci.yml`): typecheck + lint + full test suite on
  Node 20.19/22/24 on Linux, plus Windows and macOS on Node 22 — the
  cross-platform claim is now actually exercised — and a packaging job that
  imports the public entry point to guard the new `exports` map.
- **Linter** (ESLint flat config, type-aware) and `.editorconfig`.
- **`exports` map** in `package.json` with explicit subpaths for the
  documented modules, plus `CHANGELOG.md`, `SECURITY.md`, and
  `CONTRIBUTING.md`.
- New tests (`tests/permissions.test.ts`, 15 cases, plus 4 CLI cases): the
  capability surface, permission overrides, domain matching semantics,
  enforcement at the request and redirect level with a mocked `fetch`
  proving blocked hosts are never contacted, backward compatibility, the
  host switches, enable/disable including rediscovery, and API versioning.

### Changed

- `ENGINE_VERSION` is `0.2.0`. `ENGINE_PHASE` stays `6`: no runtime phase
  was added, and the sandbox's capability surface is unchanged for plugins
  that are granted the default permissions and declare no domains.
- The example plugin declares `apiVersion: 1` and documents that its
  `domains` are enforced.
- `LoadedPlugin` gained `permissions` and `allowedDomains` (host-side
  introspection only).
- `PluginRuntimeOptions.http` gained `enforceManifestDomains` and
  `extraAllowedDomains`; `PluginRuntimeOptions` gained `permissions` and
  `perPluginPermissions`.
- `HttpClient.request()` accepts an optional fourth argument
  (`RequestPolicy`) for the per-call declared-domain allowlist.

### Fixed

- 0.1.0's documentation implied `domains` restricted a plugin's network
  access. It did not. It does now.

### Test suite

- 225 tests at 0.1.0 → **246 tests**, still fully offline and deterministic.

## [0.1.0] — 2026-09-14

Initial release: Phases 1–6 of the roadmap as the production runtime, plus
Phase 7 validation tooling.

- Phase 1 — TypeScript/Node scaffold, strict config, docs, tests.
- Phase 2 — manifest format + validation, loader, in-memory manager with
  duplicate-ID protection, CLI, example plugin.
- Phase 3 — sandboxed plugin runtime on QuickJS/Wasm (one runtime per
  plugin), capability contract, timeouts, memory limits, module-loader
  confinement, structured error taxonomy.
- Phase 4 — engine-controlled HTTP (`context.http`) with clamped limits,
  abort scoping, and an SSRF network policy applied to every hop.
- Phase 5 — `context.json` (guest-native) and `context.html`
  (htmlparser2/css-select, data-only) with engine-enforced limits.
- Phase 6 — `SourceResult` model and `normalizeSourceResults()`: the
  trusted boundary between raw plugin output and the application.
- Phase 7 — validation tooling: child-process CLI end-to-end tests,
  network-policy regression suite, lifecycle/concurrency tests, and a
  benchmark harness.
- Self-audit fixes: missing SSRF policy, response-header prototype-chain
  leak, overlapping-operation timeout loss, and `dispose()` mid-request
  aborting QuickJS.
