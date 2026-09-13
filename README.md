# StreamPluginEngine

Lightweight, cross-platform plugin engine for a future
media/streaming application. This repository contains the **engine only** —
no UI, no browser, no scraping targets.

## Current status: Phase 2 — plugin manifest and loader

Implemented and tested:

- Typed plugin manifest format (`PluginManifest`)
- Manifest validation (untrusted input, descriptive errors)
- Plugin discovery and metadata loading (`PluginLoader`)
- In-memory plugin registry (`PluginManager`): duplicate-ID protection,
  get/list/unregister, problem tracking
- Example plugin (`plugins/example/`) and a `plugins:list` CLI

**Not implemented yet:** plugin JavaScript execution (sandboxed runtime),
Plugin API, HTTP/HTML/JSON capabilities, enable/disable, timeouts, parallel
execution. The loader reads and validates manifests only — it never runs
plugin code.

## Quick start

Requires Node.js >= 20.

```bash
npm install
npm run build        # compile TypeScript with tsc
npm test             # build, then run tests with the built-in node:test runner
npm run plugins:list # list plugins discovered in plugins/
```

## Project layout

```
src/        Engine source (manifest, validator, loader, manager, CLI)
tests/      Tests, run with the built-in Node.js test runner
plugins/    Example plugin used by tests and the CLI
dist/       Build output (generated, not committed)
```

## Writing a plugin (format only — code is not executed yet)

A plugin is a directory inside `plugins/` containing `manifest.json` and an
entry file:

```
plugins/my-plugin/
├── manifest.json
└── plugin.js
```

`manifest.json` — required: `id`, `name`, `version`, `entry`;
optional: `author`, `description`, `domains`:

```json
{
  "id": "my.example",
  "name": "My Example",
  "version": "1.0.0",
  "entry": "plugin.js"
}
```

Rules:

- `id` is unique and uses a predictable safe format: lowercase letters,
  digits, and hyphens separated by dots (e.g. `my.example`).
- `version` is a semantic version (e.g. `1.0.0`).
- `entry` is relative to the plugin directory, uses forward slashes, and
  must not contain `..` or absolute paths.
- Unknown manifest fields are rejected.

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — overall architecture. Phase 1 and
  Phase 2 components are implemented; the rest is planned design.

## Constraints

- TypeScript, Node.js, npm; minimal dependencies.
- No Electron, Flutter, React, Next.js, full web frameworks, databases,
  Chromium, or Playwright.
- The engine must stay compatible with running plugins inside a lightweight
  JavaScript runtime.
- No Cloudflare bypass, CAPTCHA solving, DRM/authentication bypassing, or
  other security-control circumvention.

## Rules for future phases

1. Inspect the repository before modifying it; previous code may be
   incomplete or inconsistent.
2. Run `npm test` before declaring a phase complete.
3. Keep changes small and understandable.
4. Do not implement future phases early; do not ship placeholder code.
5. Never commit secrets, tokens, or credentials.
