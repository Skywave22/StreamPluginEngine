# Integration — StormStream (All-OS)

This document explains how [StormStream](https://github.com/Skywave22/StormStream) embeds **StreamPluginEngine** and why a plugin written for one runs on the other.

## Why Two Engines?

| Engine | Language | Runs On | Sandbox |
|--------|----------|---------|---------|
| **StreamPluginEngine** (`this repo`) | TypeScript / Node | Windows, macOS, Linux (Node), CI | QuickJS/Wasm (`quickjs-emscripten`) |
| **StormStream** (`StormStream/lib/engine`) | Dart / Flutter | Android, iOS, Windows, macOS, Linux, Web | QuickJS via `flutter_js` (native) + Browser ES modules (web) |

Both implement **the same contract** so a plugin is portable:

* Same `PluginManifest` validation (id, version, entry, domains/mirrors/settings, apiVersion)
* Same `PluginContext` surface: `manifest` + `log` + `http` + `json` + `html` + `store`
* Same network policy: SSRF block + enforced `domains`/`mirrors` on every hop
* Same storage quotas (256 keys, 64-char keys, 4 KiB/value, 64 KiB total, depth 8) + one persist per call
* Same result normalization: `normalizeSourceResults()` / `normalizeSourceResults` in Dart

A plugin author targets the **Standard Capabilities** (`home`, `search`, `getDetails`, `getEpisodes`, `getSources`) and the engine normalizes the result — the app never sees untrusted output.

## Plugin Portability

A typical plugin works unchanged:

```js
export const plugin = {
  search: async (query, context) => {
    const base = context.store.get("baseUrl", "cdn.example");
    const res = await context.http.get(`https://${base}/search?q=${query}`);
    const doc = await context.html.parse(res.body); // handle API (apiVersion: 2)
    const cards = await context.html.select(doc, ".card");
    return cards.map(el => {
      const info = context.html.extract(el);
      return {
        id: info.data.id,
        title: info.text,
        type: "movie",
        url: `https://${base}${info.href}`,
        quality: info.data.quality,
        format: "m3u8",
        headers: { Referer: `https://${base}/` },
      };
    });
  }
};
```

* On the TypeScript engine: `context.html` returns integer handles (host-side `HtmlService`), `context.store` is sync (~6.5µs).
* On StormStream: same handle integers (Dart `HtmlService`), same sync store (pre-loaded map, one save per call via `SharedPreferences`/`MemoryStoreBackend`).

Always `await context.html.parse/select` — on the TS engine `await` on a sync value is a no-op; on StormStream it awaits the native promise. Both work.

## StormStream Sandbox Backends

```
Flutter build
    ├─ web      → Browser ES modules (web/sandbox.js, web/sandbox_web.dart)
    │             JS engine = browser, no ffi. Security note: web shares origin — not a security boundary like QuickJS. Use for dev.
    └─ native   → QuickJS/JavascriptCore via flutter_js (lib/engine/sandbox_native.dart)
                  Android: QuickJS (ffi), iOS/macOS: JavascriptCore, Windows/Linux: QuickJS
                  Sandboxed, deadlines, isolated heap — mirrors TypeScript engine's guarantees.
```

`lib/engine/sandbox.dart` is the interface; conditional import picks the implementation. Everything above it (`manifest.dart`, `policy.dart`, `store.dart`, `results.dart`, `runtime.dart`) is shared.

## Adding StormStream as a Consumer

In `StormStream/pubspec.yaml`:

```yaml
dependencies:
  stormstream_engine:
    path: ../StreamPluginEngine  # or git: https://github.com/Skywave22/StreamPluginEngine
```

Or keep the Dart port standalone (current) and keep the two repos in sync via this document and the conformance tests in `StormStream/test/engine_test.dart` (mirrors `tests/store.test.ts`, `tests/network-policy.test.ts`, etc.).

## License

Both repos are now **MIT** (2026 Skywave22). A plugin keeps its own license. No copyleft flows into your app.
