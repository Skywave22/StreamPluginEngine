# Architecture (planned)

Status: the layering below is the overall design. **Phases 1 (foundation),
2 (plugin manifest + loader), and 3 (sandboxed plugin runtime) are
implemented; everything else is still planned and not implemented.**

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

**Plugin JavaScript execution is implemented in Phase 3, but network and
scraping APIs are intentionally not implemented in Phase 3.** There is no
HTTP, no HTML parsing, no DOM, and no capability for a plugin to reach a
website. Those belong to the Plugin API v1 capabilities in Phase 4.

Sandbox limitations (do not mistake engine isolation for OS isolation):

- QuickJS runs in-process on WebAssembly: this is engine-level isolation,
  NOT an OS-level security boundary.
- CPU DoS is bounded by the per-operation timeout; memory is bounded by
  the per-plugin heap limit; both are configurable `PluginRuntimeOptions`.
- A bug in the engine/Wasm boundary is outside the sandbox's reach.
- Future hardening: per-plugin OS-level isolation and a
  capabilities-based Plugin API.

## Planned plugin entry-point types (not implemented)

- Search
- Details
- Episodes
- Sources

## Planned engine features (not implemented)

- Plugin enable/disable (the manager only has registry-level unregister)
- HTTP requests (capability, with timeouts)
- HTML parsing (capability)
- JSON parsing (capability)
- Parallel plugin execution with per-plugin timeouts
- Testing and benchmarking hooks

(Implemented so far: manifest schema + validation, discovery, loading,
manager, sandboxed JavaScript execution, controlled context, per-operation
timeouts, memory limits, and error isolation at the load/execute level.)

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
- **Phase 4** — Plugin API v1 capabilities (HTTP, JSON, HTML), per-plugin
  enable/disable; standard plugin entry points (search, details, episodes,
  sources); parallel execution and timeouts.
- **Phase 5** — Testing and benchmarking tooling.
