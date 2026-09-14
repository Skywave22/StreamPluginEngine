#!/usr/bin/env node
/**
 * Phase 7 — developer benchmark harness (NOT part of the test suite).
 *
 *   npm run build && npm run bench
 *
 * Why this lives in tools/ and not src/
 * -------------------------------------
 * It is developer-only validation tooling. It adds no runtime cost to
 * engine consumers, exports nothing from the public API, and is never
 * imported by src/ or by `npm test`. Timing-sensitive measurements do not
 * belong in the correctness suite, where they would be flaky.
 *
 * Determinism
 * -----------
 * Every input is static or served from a local 127.0.0.1 fixture server.
 * Nothing here touches the public Internet, and no result is asserted on —
 * these are relative numbers for spotting regressions, not pass/fail gates.
 *
 * Output is plain text so it can be diffed between commits.
 */
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distSrc = path.join(repoRoot, "dist", "src");

const { PluginRuntime } = await import(path.join(distSrc, "runtime.js"));
const { HttpClient } = await import(path.join(distSrc, "http.js"));
const { parseHtml, selectHtml, extractHtml } = await import(path.join(distSrc, "phase5.js"));
const { normalizeSourceResults } = await import(path.join(distSrc, "results.js"));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const results = [];

/**
 * Time `fn` over enough iterations to be meaningful.
 * Returns { ops, msPerOp, opsPerSec }.
 */
async function bench(name, fn, { iterations = 200, warmup = 20 } = {}) {
  for (let i = 0; i < warmup; i++) await fn(i);
  const started = performance.now();
  for (let i = 0; i < iterations; i++) await fn(i);
  const elapsed = performance.now() - started;
  const row = {
    name,
    ops: iterations,
    totalMs: elapsed,
    msPerOp: elapsed / iterations,
    opsPerSec: (iterations / elapsed) * 1000,
  };
  results.push(row);
  return row;
}

function report(title) {
  console.log(`\n${title}`);
  console.log("─".repeat(title.length));
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    console.log(
      `  ${r.name.padEnd(width)}  ${r.msPerOp.toFixed(4).padStart(10)} ms/op` +
        `  ${Math.round(r.opsPerSec).toLocaleString("en-US").padStart(10)} ops/s` +
        `   (${r.ops} ops in ${r.totalMs.toFixed(0)} ms)`,
    );
  }
  results.length = 0;
}

// ---------------------------------------------------------------------------
// Static fixtures (deterministic, offline)
// ---------------------------------------------------------------------------

/** A small but structurally realistic HTML catalog page. */
function makeHtml(items) {
  const rows = [];
  for (let i = 0; i < items; i++) {
    rows.push(
      `<article class="item" data-id="${i}">` +
        `<a class="link" href="/watch/title-${i}" title="Title ${i}">` +
        `<span class="name">  Title ${i}  </span>` +
        `<span class="quality">${i % 3 === 0 ? "1080p" : "720p"}</span>` +
        `</a>` +
        `<div class="meta"><em>20${10 + (i % 15)}</em></div>` +
        `</article>`,
    );
  }
  return (
    `<!doctype html><html><head><title>Catalog</title>` +
    `<style>.item{color:red}</style><script>window.x=1;</script>` +
    `</head><body><div id="list">${rows.join("")}</div></body></html>`
  );
}

const HTML_SMALL = makeHtml(20);
const HTML_MEDIUM = makeHtml(500);

/** Raw source results in the Phase 6 plugin contract shape. */
function makeRawResults(count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      id: `title-${i}`,
      title: `  Title ${i}  `,
      type: i % 2 === 0 ? "movie" : "episode",
      url: `https://example.test/watch/title-${i}?q=${i}`,
      source: "bench.source",
      thumbnail: `https://cdn.example.test/img/${i}.jpg`,
      quality: "1080p",
      language: "en",
      subtitles: [{ url: `https://cdn.example.test/subs/${i}.srt`, language: "en" }],
      metadata: { year: 2020 + (i % 6), rating: 7.5, featured: i % 5 === 0 },
    });
  }
  return out;
}

const RAW_RESULTS_100 = makeRawResults(100);
const RAW_RESULTS_1000 = makeRawResults(1000);

const JSON_TEXT = JSON.stringify({
  items: RAW_RESULTS_100.map((r) => ({ id: r.id, title: r.title, url: r.url })),
  page: 1,
  total: 100,
});

// ---------------------------------------------------------------------------
// Guest plugin used for the sandboxed measurements
// ---------------------------------------------------------------------------

const BENCH_PLUGIN = `
const HTML = ${JSON.stringify(HTML_SMALL)};
const JSON_TEXT = ${JSON.stringify(JSON_TEXT)};

export const plugin = {
  noop() { return 1; },
  makeObject() { return { a: 1, b: [1, 2, 3], c: { d: "text" } }; },
  jsonParse(ctx) { const v = ctx.json.parse(JSON_TEXT); return v.total; },
  jsonStringify(ctx) { return ctx.json.stringify({ a: 1, b: [1, 2, 3] }).length; },
  htmlParse(ctx) { return ctx.html.parse(HTML).children.length; },
  htmlSelect(ctx) {
    const doc = ctx.html.parse(HTML);
    return ctx.html.select(doc, "article.item a.link").length;
  },
  htmlExtract(ctx) {
    const doc = ctx.html.parse(HTML);
    const els = ctx.html.select(doc, "article.item");
    return els.map((el) => ctx.html.extract(el)).length;
  },
  async httpGet(url, ctx) {
    const res = await ctx.http.get(url, { timeoutMs: 10000 });
    return res.status;
  },
};`;

async function makeBenchPlugin() {
  const base = await mkdtemp(path.join(os.tmpdir(), "spe-bench-"));
  const dir = path.join(base, "bench");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({ id: "t.bench", name: "bench", version: "1.0.0", entry: "plugin.js" }),
  );
  await writeFile(path.join(dir, "plugin.js"), BENCH_PLUGIN);
  return {
    base,
    plugin: {
      pluginPath: dir,
      manifest: { id: "t.bench", name: "bench", version: "1.0.0", entry: "plugin.js" },
      entryPath: path.join(dir, "plugin.js"),
      status: "loaded",
    },
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log("StreamPluginEngine — developer benchmark");
console.log(`node ${process.version}, ${process.platform} ${process.arch}`);
console.log("All inputs are static or local; no external network is used.");

// --- Host-side (no sandbox) ------------------------------------------------
const started = performance.now();
const { getQuickJS } = await import("quickjs-emscripten");
await getQuickJS();
console.log(`\nQuickJS/Wasm module init: ${(performance.now() - started).toFixed(0)} ms (one-time, cached)`);

await bench("host: parseHtml (20 items)", () => parseHtml(HTML_SMALL), { iterations: 300, warmup: 30 });
await bench("host: parseHtml (500 items)", () => parseHtml(HTML_MEDIUM), { iterations: 40, warmup: 5 });
await bench("host: selectHtml (20 matches)", () => selectHtml(parseHtml(HTML_SMALL), "article.item"), { iterations: 200, warmup: 20 });
await bench("host: extractHtml (1 element)", () => {
  const matched = selectHtml(parseHtml(HTML_SMALL), "article.item");
  extractHtml(matched[0]);
}, { iterations: 200, warmup: 20 });
await bench("host: normalizeSourceResults (100)", () => normalizeSourceResults(RAW_RESULTS_100), { iterations: 300, warmup: 30 });
await bench("host: normalizeSourceResults (1000)", () => normalizeSourceResults(RAW_RESULTS_1000), { iterations: 40, warmup: 5 });
await bench("host: JSON.parse (100-item payload)", () => JSON.parse(JSON_TEXT), { iterations: 500, warmup: 50 });
report("Host-side (Phase 5 + Phase 6, no sandbox)");

// --- Guest-side (real QuickJS sandbox) ------------------------------------
const fixture = await makeBenchPlugin();
const runtime = new PluginRuntime({
  timeoutMs: 30_000,
  logger: () => {},
  http: { network: { allowPrivateNetwork: true } },
});

const loadStart = performance.now();
const loaded = await runtime.loadPlugin(fixture.plugin);
const firstLoadMs = performance.now() - loadStart;
if (!loaded.ok) {
  console.error("benchmark plugin failed to load:", loaded.error);
  process.exitCode = 1;
  await rm(fixture.base, { recursive: true, force: true });
  process.exit(1);
}
console.log(`\nFirst plugin load (incl. context creation): ${firstLoadMs.toFixed(1)} ms`);

const exec = (operation, args = []) => async () => {
  const res = await runtime.execute(loaded.plugin, operation, args);
  if (!res.success) throw new Error(`${operation} failed: ${res.error.type} ${res.error.message}`);
  return res.value;
};

await bench("guest: execute noop capability", exec("noop"), { iterations: 500, warmup: 50 });
await bench("guest: execute returning an object", exec("makeObject"), { iterations: 500, warmup: 50 });
await bench("guest: context.json.parse", exec("jsonParse"), { iterations: 200, warmup: 20 });
await bench("guest: context.json.stringify", exec("jsonStringify"), { iterations: 500, warmup: 50 });
await bench("guest: context.html.parse", exec("htmlParse"), { iterations: 200, warmup: 20 });
await bench("guest: context.html.select", exec("htmlSelect"), { iterations: 150, warmup: 15 });
await bench("guest: context.html.extract x20", exec("htmlExtract"), { iterations: 100, warmup: 10 });
report("Guest-side (Phase 3/4/5 through the real sandbox)");

// --- Repeated load/dispose -------------------------------------------------
await bench("lifecycle: loadPlugin + dispose", async () => {
  const again = await runtime.loadPlugin(fixture.plugin);
  if (!again.ok) throw new Error("reload failed");
  await runtime.execute(again.plugin, "noop", []);
  runtime.dispose(again.plugin);
}, { iterations: 60, warmup: 5 });
report("Lifecycle");

// --- HTTP through the sandbox (local fixture server) -----------------------
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON_TEXT);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const addr = server.address();
const localUrl = `http://127.0.0.1:${addr.port}/payload`;

await bench("guest: context.http.get (loopback)", exec("httpGet", [localUrl]), { iterations: 100, warmup: 10 });

const client = new HttpClient({ network: { allowPrivateNetwork: true } });
await bench("host: HttpClient.request (loopback)", async () => {
  const res = await client.request(localUrl, { timeoutMs: 10_000 });
  if (res.status !== 200) throw new Error("unexpected status");
}, { iterations: 100, warmup: 10 });
report("HTTP (local loopback fixture — relative only, machine-dependent)");

// --- Cleanup ---------------------------------------------------------------
runtime.shutdown();
await new Promise((resolve) => server.close(resolve));
await rm(fixture.base, { recursive: true, force: true });

console.log("\nDone. Numbers are relative — compare the same machine across commits.");
console.log("Memory after shutdown:", {
  rssMiB: Number((process.memoryUsage().rss / 1048576).toFixed(1)),
  heapUsedMiB: Number((process.memoryUsage().heapUsed / 1048576).toFixed(1)),
});
