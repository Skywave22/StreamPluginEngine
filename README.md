# StreamPluginEngine

Lightweight, cross-platform plugin engine for a future
media/streaming application. This repository contains the **engine only** —
no UI, no browser, no scraping targets.

## Current status: Phase 3 — sandboxed plugin runtime

Implemented and tested:

- Typed plugin manifest format, validation, discovery, loading (Phases 1–2)
- In-memory plugin registry with duplicate-ID protection (Phase 2)
- **`PluginRuntime`** — executes plugin JavaScript inside QuickJS, a
  separate JavaScript engine compiled to WebAssembly
  (`quickjs-emscripten`). Plugins get a controlled context
  (`manifest` + `log`), JSON arguments, and JSON results — and **nothing
  else**: no Node.js globals, no host files, no network.
- Capability detection (`search`, `getDetails`, … or any function export)
- Structured results, timeouts (interrupt hooks), memory limits, and error
  isolation — a broken plugin never crashes the engine
- CLI: `plugins:list` and `plugin:run`
- Example plugin that genuinely executes in the runtime

**Not implemented yet:** network (HTTP) APIs, HTML parsing, scraping,
enable/disable, parallel execution, benchmarking.
**Network and scraping APIs are intentionally not implemented in Phase 3.**

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
};
```

- The module must export an object named `plugin`; at least one function
  capability is required. Non-function properties are ignored.
- `context.manifest` is this plugin's manifest; `context.log(...)` routes
  to the host logger. That is the entire host surface in Phase 3.
- Capability arguments must be JSON-serializable; results are returned to
  the host as JSON (everything else is dropped).
- `import` works for files **inside the plugin directory only**. Host
  modules (`node:fs`), built-ins, absolute paths, and `..` escapes are
  rejected.

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
- The controlled context (`manifest`, `log`) and JSON arguments
- Relative imports within its own directory

What a plugin does NOT have:

- `process`, `require`, `module`, `__dirname`, `Buffer`, `fetch`
- `fs`, `net`, `tls`, `child_process`, or any other Node built-in
- Environment variables, shell access, host objects, other plugins' globals
- Any API beyond the context — the Phase 3 context is intentionally tiny

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

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — overall architecture. Phases 1–3
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
