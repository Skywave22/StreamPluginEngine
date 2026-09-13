# Architecture (planned)

Status: the layering below is the overall design. **Phase 1 (foundation)
and Phase 2 (plugin manifest + loader) are implemented; everything else is
still planned and not implemented.**

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

Example plugin: `plugins/example/` (manifest.json + harmless placeholder
plugin.js) is used by the tests and the `npm run plugins:list` CLI.

## Planned plugin entry-point types (not implemented)

- Search
- Details
- Episodes
- Sources

## Planned engine features (not implemented)

- Sandboxed JavaScript execution
- Plugin enable/disable (the manager only has registry-level unregister)
- HTTP requests (capability, with timeouts)
- HTML parsing (capability)
- JSON parsing (capability)
- Parallel plugin execution with per-plugin timeouts
- Runtime error isolation (Phase 2 only isolates discovery/loading failures)
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

- **Phase 1** — Repository foundation, toolchain, this document. *(complete)*
- **Phase 2** — Plugin manifest schema, validation, discovery, loading,
  plugin manager, example plugin, CLI. *(complete)*
- **Phase 3** — Sandboxed plugin runtime and Plugin API v1 (HTTP, JSON,
  HTML capabilities); per-plugin enable/disable.
- **Phase 4** — Standard plugin entry points (search, details, episodes,
  sources); parallel execution and timeouts.
- **Phase 5** — Testing and benchmarking tooling.
