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
  // context.store — the per-plugin key-value store. Reads are synchronous
  // host-side lookups; writes are validated in place and persisted once
  // when the call ends.
  storeReads(ctx) {
    let total = 0;
    for (let i = 0; i < 100; i++) {
      const value = ctx.store.get("counter");
      if (typeof value === "number") total += value;
    }
    return total;
  },
  storeWrites(ctx) {
    for (let i = 0; i < 10; i++) ctx.store.set("key" + i, { i: i, text: "value-" + i });
    return ctx.store.keys().length;
  },
  storeSnapshot(ctx) {
    return Object.keys(ctx.store.all()).length;
  },
  sources(ctx) {
    const doc = ctx.html.parse(HTML);
    const items = ctx.html.select(doc, "article.item a.link");
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const info = ctx.html.extract(items[i]);
      out.push({
        id: "item-" + i,
        title: info.text,
        type: "source",
        url: "https://cdn.example.test" + info.href,
        quality: i % 2 === 0 ? "1080p" : "720p",
        format: "m3u8",
        headers: { Referer: "https://catalog.example.test/" },
      });
    }
    return out;
  },
  async httpGet(url, ctx) {
    const res = await ctx.http.get(url, { timeoutMs: 10000 });
    return res.status;
  },
};`;

/**
 * The SAME work as BENCH_PLUGIN's html capabilities, written against the
 * apiVersion-2 handle API. Comparing the two isolates what the Wasm
 * boundary costs: v1 ships the document tree into the guest and matched
 * nodes back out; v2 ships integers both ways.
 */
const BENCH_PLUGIN_V2 = BENCH_PLUGIN
  .replace(
    "htmlParse(ctx) { return ctx.html.parse(HTML).children.length; },",
    "htmlParse(ctx) { return ctx.html.parse(HTML); },",
  )
  .replace(
    `htmlSelect(ctx) {
    const doc = ctx.html.parse(HTML);
    return ctx.html.select(doc, "article.item a.link").length;
  },`,
    `htmlSelect(ctx) {
    const doc = ctx.html.parse(HTML);
    return ctx.html.select(doc, "article.item a.link").length;
  },`,
  )
  .replace(
    `htmlExtract(ctx) {
    const doc = ctx.html.parse(HTML);
    const els = ctx.html.select(doc, "article.item");
    return els.map((el) => ctx.html.extract(el)).length;
  },`,
    `htmlExtract(ctx) {
    const doc = ctx.html.parse(HTML);
    const els = ctx.html.select(doc, "article.item");
    return els.map((el) => ctx.html.extract(el)).length;
  },`,
  );

async function makeBenchPlugin(id, source, apiVersion) {
  const base = await mkdtemp(path.join(os.tmpdir(), "spe-bench-"));
  const dir = path.join(base, "bench");
  await mkdir(dir, { recursive: true });
  const manifest = {
    id,
    name: "bench",
    version: "1.0.0",
    entry: "plugin.js",
    ...(apiVersion === undefined ? {} : { apiVersion }),
  };
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(dir, "plugin.js"), source);
  return {
    base,
    plugin: {
      pluginPath: dir,
      manifest,
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
const fixture = await makeBenchPlugin("t.bench", BENCH_PLUGIN);
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
await bench("guest: context.html.parse  [v1 tree]", exec("htmlParse"), { iterations: 200, warmup: 20 });
await bench("guest: context.html.select [v1 tree]", exec("htmlSelect"), { iterations: 150, warmup: 15 });
await bench("guest: context.html.extract x20 [v1 tree]", exec("htmlExtract"), { iterations: 100, warmup: 10 });
report("Guest-side, html API v1 — tree crosses the Wasm boundary (Phase 3/4/5)");

// --- Guest-side, apiVersion 2: handles stay host-side ---------------------
const fixtureV2 = await makeBenchPlugin("t.bench2", BENCH_PLUGIN_V2, 2);
const runtimeV2 = new PluginRuntime({
  timeoutMs: 30_000,
  logger: () => {},
  http: { network: { allowPrivateNetwork: true } },
});
const loadedV2 = await runtimeV2.loadPlugin(fixtureV2.plugin);
if (!loadedV2.ok) {
  console.error("benchmark plugin (v2) failed to load:", loadedV2.error);
  process.exitCode = 1;
  await rm(fixtureV2.base, { recursive: true, force: true });
  process.exit(1);
}
const execV2 = (operation, args = []) => async () => {
  const res = await runtimeV2.execute(loadedV2.plugin, operation, args);
  if (!res.success) throw new Error(`${operation} failed: ${res.error.type} ${res.error.message}`);
  return res.value;
};
await bench("guest: context.html.parse  [v2 handles]", execV2("htmlParse"), { iterations: 300, warmup: 30 });
await bench("guest: context.html.select [v2 handles]", execV2("htmlSelect"), { iterations: 300, warmup: 30 });
await bench("guest: context.html.extract x20 [v2 handles]", execV2("htmlExtract"), { iterations: 200, warmup: 20 });
report("Guest-side, html API v2 — only handles cross the Wasm boundary (apiVersion 2)");

// --- context.store --------------------------------------------------------
// The design claim: reads never cross the Wasm boundary. These numbers are
// the cost of the local map plus the call that carries 100 of them; for
// scale, one `guest: execute noop` (a single host round trip, no work) is
// the price an ASYNC bridge would pay PER READ.
await bench("guest: 100x context.store.get (sync reads)", execV2("storeReads"), {
  iterations: 300,
  warmup: 30,
});
await bench("guest: 10x context.store.set + 1 persist", execV2("storeWrites"), {
  iterations: 200,
  warmup: 20,
});
await bench("guest: context.store.all snapshot", execV2("storeSnapshot"), {
  iterations: 300,
  warmup: 30,
});
report("Per-plugin persistent store (context.store)");

runtimeV2.shutdown();
await rm(fixtureV2.base, { recursive: true, force: true });

// --- Repeated load/dispose -------------------------------------------------
await bench("lifecycle: loadPlugin + dispose", async () => {
  const again = await runtime.loadPlugin(fixture.plugin);
  if (!again.ok) throw new Error("reload failed");
  await runtime.execute(again.plugin, "noop", []);
  runtime.dispose(again.plugin);
}, { iterations: 60, warmup: 5 });
report("Lifecycle");

// --- Multi-plugin fan-out (coordinator) -----------------------------------
{
  const { PluginCoordinator } = await import("../dist/src/coordinator.js");
  const extras = [];
  for (let i = 0; i < 3; i += 1) {
    const made = await makeBenchPlugin(`t.fan${i}`, BENCH_PLUGIN_V2, 2);
    const loadedExtra = await runtime.loadPlugin(made.plugin);
    if (loadedExtra.ok) extras.push({ loaded: loadedExtra.plugin, base: made.base });
  }
  const coordinator = new PluginCoordinator(runtime, { concurrency: 4 });
  const all = [loaded.plugin, ...extras.map((e) => e.loaded)];
  await bench(
    `coordinator: collectSources across ${all.length} plugins (${"htmlSelect"} each)`,
    async () => {
      const merged = await coordinator.collectSources(all);
      if (merged.stats.pluginsRun !== all.length) throw new Error("fan-out incomplete");
      if (merged.stats.totalResults === 0) throw new Error("fan-out produced no results");
      return merged.stats;
    },
    { iterations: 40, warmup: 5 },
  );
  {
    const sample = await coordinator.collectSources(all);
    console.log(
      `\n  fan-out sanity: ${sample.stats.pluginsRun} plugins, ` +
        `${sample.stats.pluginsSucceeded} succeeded, ` +
        `${sample.stats.totalResults} results ` +
        `(${sample.stats.duplicatesRemoved} duplicate URLs removed)`,
    );
  }
  report("Multi-plugin fan-out (PluginCoordinator)");
  for (const extra of extras) {
    runtime.dispose(extra.loaded);
    await rm(extra.base, { recursive: true, force: true });
  }
}

// --- HTTP through the sandbox (local fixture server) -----------------------
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON_TEXT);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const addr = server.address();
const localUrl = `http://127.0.0.1:${addr.port}/payload`;

await bench("guest: context.http.get (loopback)", exec("httpGet", [localUrl]), { iterations: 100, warmup: 10 });

// Wall-clock value of fan-out: plugins that WAIT on the network (the
// common case) overlap; CPU-bound plugins do not, because guest code
// runs synchronously on the host thread. Measuring both makes the claim
// honest instead of assuming concurrency always helps.
{
  const { PluginCoordinator } = await import("../dist/src/coordinator.js");
  const ioPlugins = [];
  for (let i = 0; i < 4; i += 1) {
    const made = await makeBenchPlugin(`t.io${i}`, BENCH_PLUGIN, 1);
    const loadedIo = await runtime.loadPlugin(made.plugin);
    if (loadedIo.ok) ioPlugins.push({ loaded: loadedIo.plugin, base: made.base });
  }
  const coordinator = new PluginCoordinator(runtime, { concurrency: 4 });
  const plugins = ioPlugins.map((p) => p.loaded);
  const args = [localUrl];

  const sequential = async () => {
    for (const plugin of plugins) {
      const res = await runtime.execute(plugin, "httpGet", args);
      if (!res.success) throw new Error("sequential run failed");
    }
  };
  const parallel = async () => {
    const outcomes = await coordinator.runAll(plugins, "httpGet", args);
    if (outcomes.some((o) => !o.ok)) throw new Error("parallel run failed");
  };

  // Warm both paths once (JIT, connection reuse) before timing.
  await sequential();
  await parallel();

  const time = async (fn, runs) => {
    const started = performance.now();
    for (let i = 0; i < runs; i += 1) await fn();
    return (performance.now() - started) / runs;
  };
  const seqMs = await time(sequential, 20);
  const parMs = await time(parallel, 20);
  console.log(
    `\n  I/O-bound fan-out over ${plugins.length} plugins (1 loopback GET each):` +
      `\n    sequential           ${seqMs.toFixed(2)} ms/round` +
      `\n    PluginCoordinator    ${parMs.toFixed(2)} ms/round` +
      `\n    speed-up             ${(seqMs / parMs).toFixed(2)}x` +
      `\n    (an instant loopback fixture has no latency to hide — the win` +
      `\n     scales with per-provider latency, measured next)`,
  );

  // Realistic provider latency: a source plugin typically spends most of
  // its time WAITING on a remote host. That is the wait fan-out hides.
  const { createServer: createSlowServer } = await import("node:http");
  const slow = createSlowServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }, 120);
  });
  await new Promise((resolve) => slow.listen(0, "127.0.0.1", resolve));
  const slowUrl = `http://127.0.0.1:${slow.address().port}/provider`;

  const slowSeq = async () => {
    for (const plugin of plugins) {
      const res = await runtime.execute(plugin, "httpGet", [slowUrl]);
      if (!res.success) throw new Error("slow sequential run failed");
    }
  };
  const slowPar = async () => {
    const outcomes = await coordinator.runAll(plugins, "httpGet", [slowUrl]);
    if (outcomes.some((o) => !o.ok)) throw new Error("slow parallel run failed");
  };
  await slowSeq();
  await slowPar();
  const slowSeqMs = await time(slowSeq, 3);
  const slowParMs = await time(slowPar, 3);
  console.log(
    `\n  Same fan-out against a source with 120 ms latency (the real case):` +
      `\n    sequential           ${slowSeqMs.toFixed(0)} ms/round` +
      `\n    PluginCoordinator    ${slowParMs.toFixed(0)} ms/round` +
      `\n    speed-up             ${(slowSeqMs / slowParMs).toFixed(2)}x`,
  );
  await new Promise((resolve) => slow.close(resolve));

  for (const entry of ioPlugins) {
    runtime.dispose(entry.loaded);
    await rm(entry.base, { recursive: true, force: true });
  }
}

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
