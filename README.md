# StreamPluginEngine

Lightweight, cross-platform plugin engine for a future media/streaming application. This repository contains the **engine only** — no UI, browser automation, or media-player application.

## Current status: Phases 1–6 complete + Phase 7 validation tooling

**Phases 1–6 are the production runtime and are complete.** Phase 7 is
final validation and developer-only tooling (security regression, CLI
end-to-end, and lifecycle/concurrency tests plus a benchmark harness); it
adds no runtime capability. See the roadmap in `ARCHITECTURE.md`.

An independent audit of the source, tests, and Git history found and fixed
four real defects in the Phase 1–6 layers — a missing network/SSRF policy,
a prototype-chain bug in response-header collection, an interrupt-handler
race that could hang the host process, and a QuickJS teardown abort when a
plugin was disposed mid-request. Each has a regression test.

Phases 1–5 remain implemented:

- Typed plugin manifest format, validation, discovery, and loading (Phases 1–2)
- In-memory plugin registry with duplicate-ID protection
- `PluginRuntime` executing plugin JavaScript inside isolated QuickJS/Wasm
- Runtime memory and CPU/deadline limits and error isolation
- Controlled engine-side HTTP through `context.http` (Phase 4)
- HTML + JSON parsing capabilities (`context.html`, `context.json`) (Phase 5)
- CLI plugin discovery and execution
- Offline tests for foundation, runtime, security, HTTP, parsing, and results

### Phase 6

Phase 6 adds the **normalized source result pipeline**: a clean result
model, a central validation/normalization layer, and a simple plugin
contract that lets plugins return structured source results to the
future application.

- `SourceResult` model: `id`, `title`, `type`, `url` (required) plus
  `source`, `thumbnail`, `quality`, `language`, `subtitles`, `metadata`
  (optional) — result types: `movie`, `episode`, `series`, `search`,
  `source`
- `normalizeSourceResults(raw)` (host-side, exported by the engine):
  validates untrusted raw plugin output and returns trusted
  normalized `SourceResult[]` — or a structured `{ code, message }` error
- Plugin contract: the plugin does HTTP (Phase 4) → HTML/JSON parsing
  (Phase 5) → transform, and returns raw result objects; the engine is
  responsible for producing trusted normalized results
- Engine-enforced limits (result count, field lengths, metadata size,
  subtitle count), duplicate-ID handling (first wins), http/https-only
  URL policy (result URLs are data — never fetched)
- Prototype-pollution-safe metadata handling; all plugin output treated
  as untrusted

A typical Phase 6 flow:

```js
// Plugin (guest): do the work, return RAW structured results.
export const plugin = {
  sources: async (url, context) => {
    const res = await context.http.get(url);
    const doc = await context.html.parse(res.body);
    const items = await context.html.select(doc, ".item");
    const out = [];
    for (const el of items) {
      const info = await context.html.extract(el);
      out.push({
        id: info.data.id,
        title: info.text,
        type: "movie",
        url: "https://provider.example" + info.href,
        metadata: { year: Number(info.data.year) },
      });
    }
    return out;
  },
};

// Application layer (host): normalize the untrusted raw output.
const executed = await runtime.execute(plugin, "sources", [url]);
const normalized = normalizeSourceResults(executed.value);
// normalized: { ok: true, results: SourceResult[] } | { ok: false, error }
```

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

Requires Node.js >= 20.19 (the HTML parsing stack declares `>=20.19`).

```bash
npm install
npm run build
npm test
npm run plugins:list
npm run plugin:run -- example.source test
npm run bench          # optional: developer-only benchmark harness
```

`npm test` builds the TypeScript project first and then runs the built-in Node.js test runner.

## Project layout

```text
src/        Engine source (production runtime — Phases 1-6)
tests/      Tests (correctness suite, run by `npm test`)
tools/      Developer-only tooling (benchmark harness — Phase 7)
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

### Network policy (SSRF defence)

Beyond the scheme check, every request TARGET is validated against the engine network policy (`src/network.ts`). Under the default policy a plugin **cannot** reach:

- loopback (`127.0.0.0/8`, `::1`, `localhost`)
- private ranges (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`)
- link-local (`169.254/16`, `fe80::/10`) — including cloud metadata endpoints such as `169.254.169.254`
- CGNAT, multicast, and other reserved ranges
- IPv4-mapped IPv6 (`::ffff:7f00:1`) and IPv4-embedding tunnels (6to4, NAT64, Teredo)
- obfuscated IPv4 literals (`2130706433`, `0x7f.1`, `0177.0.0.1`) — the URL parser normalises these first

Blocked targets fail with the structured code `HTTP_FORBIDDEN_TARGET` **before any I/O**. Hostnames are DNS-resolved and every resolved address is checked, and the policy is re-applied to every redirect hop.

Host applications opt in to internal ranges explicitly — this is a host decision a plugin can never make for itself:

```js
const runtime = new PluginRuntime({
  http: { network: { allowPrivateNetwork: true } }, // local dev / test fixtures
});
```

Residual risk, stated plainly: the policy resolves DNS to decide and the request resolves DNS again to connect, so a hostile authoritative server can still rebind between the two. Fully closing that needs connection-level address pinning. Deployments running untrusted plugins should also apply OS/network-level egress controls — this is engine-level defence in depth, not an OS boundary.

The HTTP layer does **not** provide browser automation, CAPTCHA solving, Cloudflare bypass, DRM bypass, authentication bypass, or other security-control circumvention.

HTTP tests use a local test server and do not depend on the public Internet.

## HTML + JSON capability (Phase 5)

### JSON

`context.json.parse(text)` parses a bounded JSON string and returns JSON-compatible data. It is a pure data operation: it never evaluates code.

`context.json.stringify(value)` serializes a JSON-compatible value.

Both functions are **synchronous** and **throw** a structured error object `{ code, message }` on failure — catch it in the plugin:

| Code | Meaning |
| --- | --- |
| `JSON_INVALID_INPUT` | Non-string input / unserializable top-level value (undefined, function) |
| `JSON_INPUT_TOO_LARGE` | Input exceeds the 5 MiB limit |
| `JSON_INVALID` | The text is not valid JSON |
| `JSON_STRINGIFY_ERROR` | Value is not JSON-serializable (e.g. circular structure) |
| `JSON_OUTPUT_TOO_LARGE` | Output exceeds the 5 MiB limit |

### HTML

`context.html.parse(html)` parses an HTML string into an engine-owned, JSON-serializable document tree:

```js
{ type: "document", children: [
  { type: "element", tagName: "div", attributes: { id: "root" }, children: [
    { type: "text", text: "..." },
    { type: "comment", text: "..." },
  ]},
]}
```

`context.html.select(document, selector)` returns the matched **elements** (tree nodes):

- `div`
- `.card`
- `#main`
- `div.card`
- `div .card` (descendant)
- basic attributes such as `[href]`, `[data-id]`, and `[class="item"]`
- plus the standard CSS3 matchers supported by the underlying selector engine (e.g. pseudo-classes)

`context.html.extract(element)` returns the normalized, JSON-serializable info object: `tagName`, `text` (whitespace-normalized), `attributes`, `href`, `src`, `class`, `id`, `data` (`data-*` without prefix), `innerHTML`, and `outerHTML`.

`context.html.*` are **synchronous on success** (the value is returned directly) and return a **rejected promise** carrying a structured `{ code, message }` object on failure — `await`/`try-catch` handles both.

| Code | Meaning |
| --- | --- |
| `HTML_INVALID_INPUT` | `parse()` received a non-string |
| `HTML_INPUT_TOO_LARGE` | HTML input exceeds 5 MiB |
| `HTML_PARSE_ERROR` | Node limit exceeded / structure too deep |
| `HTML_INVALID_SELECTOR` | `select()` missing/empty selector |
| `HTML_SELECT_ERROR` | Invalid selector or non-document argument |
| `HTML_INVALID_ELEMENT` | `extract()` missing argument |
| `HTML_EXTRACT_ERROR` | `extract()` argument is not a parsed element |
| `HTML_TOO_MANY_RESULTS` | A selector matched more than 1,000 elements |

Error messages are engine-controlled: plugins never see host stack traces or file paths.

### Implementation

HTML parsing runs host-side on the mature, lightweight **htmlparser2** parser with **css-select** for selector matching and **dom-serializer** for `innerHTML`/`outerHTML` (the same parser core cheerio is built on). The chosen packages are small, pure JavaScript, and self-typed; the custom hand-rolled parser prototype was replaced because it could not reliably handle all HTML edge cases (e.g. `>` inside quoted attribute values). JSON work runs guest-side on the guest's native JSON — no value crosses the Wasm boundary for JSON.

The parser:

- tolerates malformed HTML
- normalizes extracted text
- does not execute `<script>` contents (they become plain text data)
- does not run event handlers (`onclick` etc. stay inert attribute strings)
- does not load external resources
- never follows `href` or `src`
- does not access cookies, browser storage, or filesystem

Network access remains explicit: a plugin must call `context.http` to make a request.

### Phase 5 limits

| Limit | Value |
| --- | --- |
| HTML input size | 5 MiB (UTF-8 bytes) |
| JSON input / output size | 5 MiB |
| Parsed HTML nodes (elements + text + comments) | 50,000 |
| `html.select` result count | 1,000 elements |

All limits are engine constants (`PHASE5_LIMITS`); plugins cannot raise
them.

**Deep-structure behavior:** the host-side parser supports the full node
budget (including 50,000-deep chains — all tree transforms are
iterative). Through the guest (`context.html.*`), documents deeper than
roughly 500 nesting levels — the sandbox value-delivery boundary — fail
with a structured `HTML_PARSE_ERROR` instead of crashing. This is far
beyond real-world HTML depth and is deterministic.

## Source result pipeline (Phase 6)

### Result model

The trusted, normalized result type is `SourceResult`:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | trimmed; unique within a result set (first wins on duplicates) |
| `title` | string | yes | trimmed, non-empty |
| `type` | `"movie" \| "episode" \| "series" \| "search" \| "source"` | yes | closed enum |
| `url` | string | yes | canonical absolute `http:`/`https:` URL |
| `source` | string | no | origin name; invalid/oversized values are dropped |
| `thumbnail` | string | no | absolute `http:`/`https:` URL; invalid values dropped |
| `quality` | string | no | e.g. `1080p`; invalid/oversized values dropped |
| `language` | string | no | e.g. `en`; invalid/oversized values dropped |
| `subtitles` | `Array<{ url, language?, format? }>` | no | bounded list; entries with invalid URLs are dropped |
| `metadata` | flat `Record<string, string \| number \| boolean>` | no | always present (empty object when absent); bounded |

Unknown fields are dropped. Numbers must be finite. The output is always
`SourceResult[]` (a single raw object is normalized into a one-element
array).

### Plugin contract

- The plugin performs HTTP (Phase 4), parses HTML/JSON (Phase 5),
  transforms the extracted data, and returns **raw** structured results:
  one result object or an array of them.
- The engine receives the raw output (already plain JSON data from the
  sandbox), validates it, normalizes it, and the application layer gets
  a trusted `SourceResult[]` or a structured error.
- `runtime.execute()` itself stays generic: it returns whatever the
  capability returned. Normalization is applied at the engine/app
  boundary by `normalizeSourceResults(raw)`.

### Validation and normalization

- Required fields (`id`, `title`, `type`, `url`) must be present, the
  right type, non-empty, and within length limits — otherwise the whole
  input is rejected (all-or-nothing) with a structured error naming the
  item and field.
- Strings are trimmed; URLs are canonicalized (standard URL form:
  lowercased scheme/host, default ports removed, dot segments resolved).
- Only `http:` and `https:` URLs are accepted for `url`, `thumbnail`,
  and subtitle URLs. **Result URLs are never fetched or verified** —
  they are data.
- Invalid optional values (wrong type, empty, malformed URL, over
  length) are **dropped**, not fatal; size-limit violations and invalid
  required values **reject** the input.
- Duplicate `id`s keep the first occurrence.
- `metadata` keys `__proto__`, `constructor`, and `prototype` are
  rejected (prototype-pollution protection); metadata values must be
  plain scalars (string/number/boolean); the metadata object is bounded
  in key count and serialized size.
- Error codes: `RESULT_INVALID_INPUT`, `RESULT_INVALID`,
  `RESULT_INVALID_URL`, `RESULT_TOO_MANY_RESULTS`,
  `RESULT_FIELD_TOO_LONG`, `RESULT_METADATA_TOO_LARGE`
  (`RESULT_ERROR_CODES`). Messages are engine-controlled — no host stack
  traces or paths.

### Phase 6 limits

| Limit | Value |
| --- | --- |
| Results per return value | 1,000 |
| `id` length | 200 characters |
| `title` length | 500 characters |
| URL length (`url`, `thumbnail`, subtitle URLs) | 2,048 characters |
| `source` length | 200 characters |
| `quality` length | 50 characters |
| `language` length | 20 characters |
| Subtitle `format` length | 30 characters |
| Subtitles per result | 50 |
| Metadata keys per result | 64 |
| Metadata key length | 100 characters |
| Metadata string value length | 500 characters |
| Metadata serialized size | 8 KiB |

All limits are engine constants (`RESULT_LIMITS`); plugins cannot raise
them.

## Dependencies

The dependency set is intentionally small (plus transitive packages of the HTML parser):

- `quickjs-emscripten` — QuickJS compiled to WebAssembly (the sandbox)
- `htmlparser2`, `css-select`, `dom-serializer`, `domhandler`, `domutils` — the mature, lightweight HTML parsing/selection/serialization stack (Phase 5)

No UI frameworks, databases, browser automation, or network-fetch libraries.

## Testing

The repository includes deterministic offline tests for:

- foundation and manifest behavior
- plugin runtime behavior
- sandbox security (including the exact context surface)
- controlled HTTP
- Phase 5 JSON parsing (round-trips, structured error contract, size limits, circular-value rejection)
- Phase 5 HTML parsing (host-level unit tests: structure, attributes, entities, malformed HTML, script/style data-only, node limit)
- Phase 5 CSS selectors and extraction (tag/class/id/descendant/attribute selectors, subtree selection, result-count limit, invalid-selector rejection)
- Phase 5 guest-level integration (structured errors caught in the guest, limits)
- full pipelines over a local server: HTTP → HTML → parse → select → extract, and HTTP → JSON
- script/event-handler non-execution and host-leak checks
- Phase 6 result validation (required fields, types, empty values,
  malformed/unsupported URLs, oversized fields, too many results,
  metadata shape and limits)
- Phase 6 normalization (trimming, URL canonicalization, duplicate
  handling, consistent output shape)
- Phase 6 plugin integration (plugin returns raw results; engine
  normalizes them — HTTP → HTML/JSON → raw results → normalized results
  over a local server)
- Phase 6 security (malicious plugin output, prototype-pollution
  attempts, strange objects, huge values)

Phase 7 adds the validation layer that closes the gaps an independent audit
found:

- **network policy / SSRF regression** (`tests/network-policy.test.ts`) —
  address-range classification, cloud metadata endpoints, IPv4-mapped IPv6
  and tunnel-prefix smuggling, obfuscated IPv4 literals, `localhost`,
  hostname resolution (injected resolver, so no real DNS), mixed
  public/private resolution, redirect-hop enforcement (mocked `fetch`, so no
  external host), and guest-level proof that a plugin cannot reach internal
  targets or grant itself permission
- **HTTP header prototype-chain regression** (`tests/http.test.ts`) —
  server-controlled headers named after `Object.prototype` members are no
  longer corrupted and no longer leak host function source text; genuine
  duplicate headers still join with `", "`; a `__proto__` request header is
  rejected rather than silently dropped
- **CLI end-to-end** (`tests/cli.test.ts`) — the built CLI is run as a real
  child process: `list`/no-arg discovery, empty and missing directories,
  problem reporting, `run` with array/scalar/no JSON arguments, log routing,
  unknown plugin, unknown capability, malformed arguments, load failures,
  cwd-relative `plugins/` resolution, and exit codes
- **lifecycle, stability, and concurrency** (`tests/lifecycle.test.ts`) —
  repeated execution, repeated load/dispose cycles, module-state isolation
  between loads, runtime re-creation after shutdown, idempotent
  dispose/shutdown, execution after dispose, cross-runtime handle rejection,
  concurrent operations on different plugins, serialized operations on one
  plugin, queue recovery after a failed operation, and disposal while an
  HTTP request is in flight. The overlapping-operation timeout regression
  runs in a **child process with a hard timeout**, so if the interrupt-handler
  race ever returns the test fails cleanly instead of freezing the suite.

Run:

```bash
npm test        # correctness suite (225 tests, offline, deterministic)
npm run bench   # developer-only benchmarks — NOT part of the test suite
```

Benchmarks are deliberately kept out of `npm test`: timing assertions are
flaky and would not test correctness. `tools/benchmark.mjs` is not imported
by `src/` and is not part of the public API, so it adds no runtime cost to
engine consumers.

## Documentation

- `ARCHITECTURE.md` — overall engine architecture and phase boundaries.

## Explicitly out of scope

The engine (Phases 1–6) is **not** a media/stream extractor. It does not implement:

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

## Rules for maintainers

The project is complete: Phases 1–6 are the production runtime, and Phase 7
is developer-only validation tooling. For any future maintenance work:

1. Inspect the repository before modifying it.
2. Run `npm test` before declaring a change complete.
3. Keep changes small and understandable.
4. Do not add new phases or new capabilities without an explicit project
   decision.
5. Never commit secrets, tokens, or credentials.
