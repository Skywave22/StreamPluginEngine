# StreamPluginEngine

Lightweight, cross-platform plugin engine for a future
media/streaming application. This repository contains the **engine only** —
no UI, no browser, no scraping targets.

## Current status: Phase 1 — foundation

The repository currently contains only the project foundation: a
TypeScript + Node.js scaffold that compiles cleanly and has a passing test.
Nothing from the planned architecture is implemented yet.

## Quick start

Requires Node.js >= 20.

```bash
npm install
npm run build   # compile TypeScript with tsc
npm test        # build, then run tests with the built-in node:test runner
```

## Project layout

```
src/        Engine source (currently: entry point with engine identity)
tests/      Tests, run with the built-in Node.js test runner
dist/       Build output (generated, not committed)
```

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — planned architecture for future
  phases. **Design only; nothing in it is implemented.**

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
