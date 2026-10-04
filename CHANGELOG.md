# Changelog

All notable changes to this project are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).
While the version is `0.x`, the plugin contract may still change; the
engine reports the contract revision it implements as `ENGINE_API_VERSION`.

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
