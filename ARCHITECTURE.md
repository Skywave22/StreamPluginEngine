# Architecture (planned)

Status: **design document for future phases. Nothing described here is implemented yet.**

## Layering

```
Application
    ↓
Plugin Engine
    ↓
Plugin Runtime
    ↓
Plugin API
    ↓
HTTP / HTML / JSON capabilities
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

## Planned plugin entry-point types (not implemented)

- Search
- Details
- Episodes
- Sources

## Planned engine features (not implemented)

- Plugin loading from a manifest (e.g. `plugin.json` next to plugin code)
- Sandboxed JavaScript execution
- Plugin manifests: name, version, entry point, required capabilities
- HTTP requests (capability, with timeouts)
- HTML parsing (capability)
- JSON parsing (capability)
- Parallel plugin execution with per-plugin timeouts
- Error isolation: a failing plugin must not crash the engine or other plugins
- Per-plugin enable/disable
- Testing and benchmarking hooks

## Design constraints

- TypeScript, Node.js (development and testing), npm; minimal dependencies.
- No Electron, Flutter, React, Next.js, full web frameworks, databases,
  Chromium, or Playwright.
- Must remain compatible with running inside a lightweight JavaScript
  runtime in the future.
- No Cloudflare bypass, CAPTCHA solving, DRM or authentication bypassing,
  or other security-control circumvention — by design, out of scope.

## Phase roadmap (indicative, not a contract)

- **Phase 1** — Repository foundation, toolchain, this document.
- **Phase 2** — Plugin manifest schema; engine core: loading,
  enable/disable, error isolation.
- **Phase 3** — Sandboxed plugin runtime and Plugin API v1 (HTTP, JSON,
  HTML capabilities).
- **Phase 4** — Standard plugin entry points (search, details, episodes,
  sources); parallel execution and timeouts.
- **Phase 5** — Testing and benchmarking tooling.
