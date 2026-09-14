# StreamPluginEngine

Lightweight, cross-platform plugin engine for a future media/streaming application. This repository contains the **engine only** — no UI, browser automation, or media-player application.

## Current status: Phase 5 — HTML + JSON parsing capabilities

Phases 1–4 remain implemented:

- Typed plugin manifest format, validation, discovery, and loading (Phases 1–2)
- In-memory plugin registry with duplicate-ID protection
- `PluginRuntime` executing plugin JavaScript inside isolated QuickJS/Wasm
- Runtime memory and CPU/deadline limits and error isolation
- Controlled engine-side HTTP through `context.http` (Phase 4)
- CLI plugin discovery and execution
- Offline tests for foundation, runtime, security, and HTTP behavior

### Phase 5

Phase 5 adds parser-only data capabilities on top of the existing HTTP layer:

- `context.json.parse(text)`
- `context.json.stringify(value)`
- `context.html.parse(html)`
- `context.html.select(document, selector)`
- `context.html.extract(element)`
- CSS selectors: tag, `.class`, `#id`, `tag.class`, descendant selectors, and basic attribute selectors
- Element information including tag name, normalized text, attributes, `href`, `src`, `class`, `id`, `data-*`, `innerHTML`, and `outerHTML`
- Bounded HTML size, JSON size, and parsed-node count
- Malformed HTML tolerance
- Parser-only behavior: HTML parsing never executes JavaScript and never fetches `href`/`src`

A typical Phase 5 plugin flow is:

```js
const response = await context.http.get(url);
const document = context.html.parse(response.body);
const cards = context.html.select(document, ".card");

return cards.map((card) => context.html.extract(card));
```

JSON can be handled directly:

```js
const response = await context.http.get(url);
const data = context.json.parse(response.body);
return data;
```

## Quick start

Requires Node.js >= 20.

```bash
npm install
npm run build
npm test
npm run plugins:list
npm run plugin:run -- example.source test
```

`npm test` builds the TypeScript project first and then runs the built-in Node.js test runner.

## Project layout

```text
src/        Engine source
tests/      Tests
plugins/    Example plugin
dist/       Build output (generated, not committed)
```

## Writing a plugin

A plugin is a directory inside `plugins/` with `manifest.json` and an ES-module entry file.

```js
export const plugin = {
  search: async (query, context) => {
    context.log("search", query);
    return [{ id: "example-1", title: "Example Result" }];
  },

  fetchAndParse: async (url, context) => {
    const res = await context.http.get(url);
    const document = context.html.parse(res.body);
    const items = context.html.select(document, ".item");

    return items.map((item) => context.html.extract(item));
  },

  fetchJson: async (url, context) => {
    const res = await context.http.get(url);
    return context.json.parse(res.body);
  },
};
```

Capability arguments come first and the controlled context is last.

## The sandbox

Plugins run inside QuickJS compiled to WebAssembly. The plugin realm is separate from the host Node.js JavaScript realm.

Plugins do not get direct access to:

- `process`, `require`, `module`, `__dirname`, `Buffer`, or host `fetch`
- Node filesystem/network modules
- Environment variables or shell access
- Other plugins' globals
- Host files or arbitrary sockets

The sanctioned network surface is `context.http`. HTML parsing and JSON parsing do not add direct network or filesystem access.

Execution is bounded by the existing runtime time and memory limits. This is engine-level isolation, not an OS-level security boundary.

## HTTP capability (Phase 4)

Plugins make HTTP/HTTPS requests through `context.http`; the host performs the actual request.

```js
const res = await context.http.get("https://example.com/api", {
  timeoutMs: 8000,
  headers: { accept: "application/json" },
});

res.status;
res.headers;
res.url;
res.body;

const data = await context.http.getJson("https://example.com/api");
```

Requests have engine-enforced limits for timeout, response size, redirects, and headers. URLs must be absolute `http:` or `https:` URLs.

The HTTP layer does **not** provide browser automation, CAPTCHA solving, Cloudflare bypass, DRM bypass, authentication bypass, or other security-control circumvention.

HTTP tests use a local test server and do not depend on the public Internet.

## HTML + JSON capability (Phase 5)

### JSON

`context.json.parse` parses a bounded JSON string and returns JSON-compatible data.

`context.json.stringify` serializes a JSON-compatible value.

Invalid JSON and values that exceed the engine's input limits are rejected with structured runtime errors.

### HTML

`context.html.parse` parses an HTML string into an engine-owned document representation.

`context.html.select` supports:

- `div`
- `.card`
- `#main`
- `div.card`
- `div .card`
- basic attributes such as `[href]`, `[data-id]`, and `[class="item"]`

`context.html.extract` returns normalized, JSON-serializable element information.

The parser:

- tolerates malformed HTML
- normalizes extracted text
- does not execute `<script>` contents
- does not run event handlers
- does not load external resources
- never follows `href` or `src`
- does not access cookies, browser storage, or filesystem

Network access remains explicit: a plugin must call `context.http` to make a request.

### Phase 5 limits

The parser enforces bounded input/resource limits. The current implementation limits HTML input to approximately 5 MiB, JSON input to approximately 5 MiB, and parsed HTML nodes to 50,000. Plugins cannot raise these hard limits.

## Testing

The repository includes deterministic offline tests for:

- foundation and manifest behavior
- plugin runtime behavior
- sandbox security
- controlled HTTP
- Phase 5 JSON parsing
- Phase 5 HTML selectors and extraction
- script/event-handler non-execution
- unsupported selector rejection

Run:

```bash
npm test
```

## Documentation

- `ARCHITECTURE.md` — overall engine architecture and phase boundaries.

## Explicitly out of scope

Phase 5 is **not** a media/stream extractor. It does not implement:

- M3U8/MP4 stream extraction
- media playback
- DRM handling or bypass
- CAPTCHA solving
- Cloudflare/security-control bypass
- authentication bypass
- browser automation
- JavaScript execution from scraped pages
- UI/application code
- plugin marketplace
- database or large persistent cache

## Constraints

- TypeScript, Node.js, npm
- Keep dependencies small and understandable
- No Electron, Flutter, React, Next.js, full web frameworks, databases, Chromium, Playwright, or Puppeteer
- Never commit secrets, tokens, or credentials

## Rules for future phases

1. Inspect the repository before modifying it.
2. Run `npm test` before declaring a phase complete.
3. Keep changes small and understandable.
4. Do not implement future phases early.
5. Never commit secrets, tokens, or credentials.
