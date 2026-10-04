/**
 * v0.3.0 multi-plugin fan-out (PluginCoordinator).
 *
 * The property that matters for an app: querying many source plugins
 * must be BOUNDED, ISOLATED and DETERMINISTIC, and the merged list must
 * be deduplicated and ranked. Concurrency is observed through a stub
 * executor (no QuickJS needed); the merge/rank behaviour is then checked
 * end-to-end through the real runtime and the real sandbox.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { PluginCoordinator, qualityScore } from "../src/coordinator.js";
import type { PluginExecutor } from "../src/coordinator.js";
import { PluginManager } from "../src/manager.js";
import { PluginRuntime } from "../src/runtime.js";
import type {
  LoadedPlugin,
  PluginExecutionResult,
  PluginManifest,
} from "../src/types.js";

/** A LoadedPlugin stub — id is the only field the coordinator reads. */
function fakePlugin(id: string): LoadedPlugin {
  return {
    pluginId: id,
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      entry: "plugin.js",
    } as PluginManifest,
    capabilities: ["sources"],
    permissions: { http: true, json: true, html: true, store: true },
    allowedDomains: [],
  };
}

/** Executor stub: records concurrency and returns scripted results. */
function stubExecutor(
  behaviour: (plugin: LoadedPlugin) => Promise<unknown>,
): { executor: PluginExecutor; peakConcurrency: () => number; order: string[] } {
  let inFlight = 0;
  let peak = 0;
  const order: string[] = [];
  const executor: PluginExecutor = {
    async execute(plugin): Promise<PluginExecutionResult> {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      order.push(plugin.pluginId);
      try {
        const value = await behaviour(plugin);
        return { success: true, value, executionTimeMs: 1 };
      } catch (error) {
        return {
          success: false,
          error: {
            type: "PLUGIN_RUNTIME_ERROR",
            message: error instanceof Error ? error.message : "failed",
          },
          executionTimeMs: 1,
        };
      } finally {
        inFlight -= 1;
      }
    },
  };
  return { executor, peakConcurrency: () => peak, order };
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

test("coordinator: bounded concurrency, results in plugin order", async () => {
  const plugins = Array.from({ length: 7 }, (_unused, i) => fakePlugin(`p${i}`));
  // Yield several times so overlapping is observable if it happens.
  const { executor, peakConcurrency } = stubExecutor(async (plugin) => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    return [{ id: plugin.pluginId, title: plugin.pluginId, type: "source", url: `https://x.example/${plugin.pluginId}` }];
  });

  const coordinator = new PluginCoordinator(executor, { concurrency: 3 });
  const outcomes = await coordinator.runAll(plugins, "sources");

  assert.equal(outcomes.length, 7);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.pluginId),
    plugins.map((plugin) => plugin.pluginId),
    "outcomes must follow the caller's plugin order regardless of completion order",
  );
  assert.ok(
    peakConcurrency() <= 3,
    `concurrency must be capped at 3 (saw ${peakConcurrency()})`,
  );
  assert.ok(peakConcurrency() > 1, "plugins should actually run in parallel");
  assert.ok(outcomes.every((outcome) => outcome.ok));
});

test("coordinator: one plugin failing never fails the run", async () => {
  const plugins = [fakePlugin("good"), fakePlugin("bad"), fakePlugin("good2")];
  const { executor } = stubExecutor(async (plugin) => {
    if (plugin.pluginId === "bad") throw new Error("plugin exploded");
    return [
      { id: plugin.pluginId, title: plugin.pluginId, type: "source", url: `https://x.example/${plugin.pluginId}` },
    ];
  });

  const coordinator = new PluginCoordinator(executor, { concurrency: 2 });
  const result = await coordinator.collectSources(plugins);

  assert.equal(result.stats.pluginsRun, 3);
  assert.equal(result.stats.pluginsSucceeded, 2);
  assert.equal(result.stats.pluginsFailed, 1);
  assert.equal(result.stats.totalResults, 2);
  const bad = result.outcomes.find((outcome) => outcome.pluginId === "bad");
  assert.ok(bad && !bad.ok);
  assert.equal(bad.error?.type, "PLUGIN_RUNTIME_ERROR");
});

test("coordinator: cancellation stops plugins that have not started", async () => {
  const plugins = Array.from({ length: 5 }, (_unused, i) => fakePlugin(`p${i}`));
  const controller = new AbortController();
  const { executor, order } = stubExecutor(async (plugin) => {
    controller.abort(); // abort after the first plugin begins
    return [{ id: plugin.pluginId, title: plugin.pluginId, type: "source", url: `https://x.example/${plugin.pluginId}` }];
  });

  const coordinator = new PluginCoordinator(executor, { concurrency: 1 });
  const outcomes = await coordinator.runAll(plugins, "sources", [], controller.signal);

  assert.equal(outcomes.length, 5, "every plugin still gets an outcome");
  assert.equal(order.length, 1, "only the already-started plugin ran");
  const cancelled = outcomes.slice(1);
  assert.ok(
    cancelled.every((outcome) => !outcome.ok && /Cancelled/.test(outcome.error?.message ?? "")),
  );
});

// ---------------------------------------------------------------------------
// Merge, dedupe, rank
// ---------------------------------------------------------------------------

const url = (name: string): string => `https://cdn.example/${name}`;
const src = (
  id: string,
  quality?: string,
  u: string = url(id),
): Record<string, unknown> => ({
  id,
  title: id,
  type: "source",
  url: u,
  ...(quality === undefined ? {} : { quality }),
});

test("coordinator: merge deduplicates by canonical URL and ranks by quality", async () => {
  const plugins = [fakePlugin("a"), fakePlugin("b")];
  const { executor } = stubExecutor(async (plugin) =>
    plugin.pluginId === "a"
      ? [src("a-720", "720p"), src("a-1080", "1080p"), src("shared", "480p", url("shared"))]
      : [src("b-4k", "4K"), src("b-shared-dup", "2160p", url("shared"))],
  );

  const coordinator = new PluginCoordinator(executor, { concurrency: 2 });
  const result = await coordinator.collectSources(plugins);

  assert.equal(result.stats.totalResults, 4);
  assert.equal(result.stats.duplicatesRemoved, 1, "the duplicate URL is dropped");
  assert.deepEqual(
    result.results.map((entry) => entry.id),
    ["b-4k", "a-1080", "a-720", "shared"],
    "highest quality first; the first-seen copy of a duplicate URL wins",
  );
  // Plugin "a" is processed first, so it keeps the shared URL; plugin
  // "b" contributes its unique 4K result and loses the duplicate.
  assert.deepEqual(result.stats.resultsPerPlugin, [3, 1]);
});

test("coordinator: a plugin whose output fails normalization is isolated", async () => {
  const plugins = [fakePlugin("good"), fakePlugin("garbage")];
  const { executor } = stubExecutor(async (plugin) =>
    plugin.pluginId === "good"
      ? [src("ok")]
      : [{ id: "missing-required-fields" }, "not an object"],
  );

  const coordinator = new PluginCoordinator(executor, { concurrency: 2 });
  const result = await coordinator.collectSources(plugins);

  assert.equal(result.stats.totalResults, 1);
  const garbage = result.outcomes.find((outcome) => outcome.pluginId === "garbage");
  assert.ok(garbage?.ok, "the plugin ran fine — its OUTPUT was invalid");
  assert.equal(garbage.normalized?.count, 0);
  assert.ok(garbage.normalized?.error, "the normalization error is reported per plugin");
  assert.match(String(garbage.normalized.error.code), /^RESULT_/);
});

test("coordinator: ranking is deterministic for equal qualities", async () => {
  // Same quality, reversed insertion order → title order decides.
  const plugins = [fakePlugin("a"), fakePlugin("b")];
  const { executor } = stubExecutor(async (plugin) =>
    plugin.pluginId === "a"
      ? [src("zeta", "720p"), src("alpha", "720p")]
      : [src("mid", "720p")],
  );
  const coordinator = new PluginCoordinator(executor);
  const first = await coordinator.collectSources(plugins);
  const second = await coordinator.collectSources(plugins);
  assert.deepEqual(
    first.results.map((entry) => entry.id),
    ["alpha", "mid", "zeta"],
  );
  assert.deepEqual(
    first.results.map((entry) => entry.id),
    second.results.map((entry) => entry.id),
  );
});

test("qualityScore: known labels, numeric forms, and unknowns", () => {
  assert.ok(qualityScore("4K") > qualityScore("1080p"));
  assert.ok(qualityScore("2160p") > qualityScore("1440p"));
  assert.ok(qualityScore("1080p") > qualityScore("720p"));
  assert.ok(qualityScore("720p") > qualityScore("CAM"));
  assert.ok(qualityScore("1080p60") > 0, "numeric forms are parsed");
  assert.equal(qualityScore(undefined), 0);
  assert.equal(qualityScore("unlabelled"), 0);
});

// ---------------------------------------------------------------------------
// End-to-end through the real sandbox
// ---------------------------------------------------------------------------

const SOURCES_PLUGIN = (quality: string, id: string) => `
export const plugin = {
  async sources(context) {
    context.log("sources", "${id}");
    return [
      { id: "${id}", title: "${id} stream", type: "source",
        url: "https://cdn.example/${id}.m3u8", quality: "${quality}",
        format: "m3u8", headers: { Referer: "https://provider.example/" } },
      { id: "${id}-dup", title: "dup", type: "source", url: "https://cdn.example/shared.m3u8" },
    ];
  },
  async fails() {
    throw new Error("nope");
  },
};
`;

test("coordinator + real runtime: parallel plugin execution merges real sandbox output", async (t: TestContext) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "spe-coord-"));
  t.after(() => rm(base, { recursive: true, force: true }));

  const manifests: Array<{ id: string; quality: string }> = [
    { id: "t.one", quality: "720p" },
    { id: "t.two", quality: "1080p" },
    { id: "t.three", quality: "4K" },
  ];
  for (const { id, quality } of manifests) {
    const dir = path.join(base, id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        id,
        name: id,
        version: "1.0.0",
        entry: "plugin.js",
        apiVersion: 2,
      }),
    );
    await writeFile(path.join(dir, "plugin.js"), SOURCES_PLUGIN(quality, id));
  }

  const manager = new PluginManager();
  await manager.discoverPlugins(base);
  const runtime = new PluginRuntime({ logger: () => {} });
  t.after(() => runtime.shutdown());

  const loaded: LoadedPlugin[] = [];
  for (const { id } of manifests) {
    const plugin = manager.getPlugin(id);
    assert.ok(plugin);
    const result = await runtime.loadPlugin(plugin);
    assert.ok(result.ok, result.ok ? "" : JSON.stringify(result.error));
    loaded.push(result.plugin);
  }

  const coordinator = new PluginCoordinator(runtime, { concurrency: 3 });
  const merged = await coordinator.collectSources(loaded);

  assert.equal(merged.stats.pluginsRun, 3);
  assert.equal(merged.stats.pluginsSucceeded, 3);
  // 6 results across plugins, 2 of them the same URL → 4 kept.
  assert.equal(merged.stats.totalResults, 4);
  assert.equal(merged.stats.duplicatesRemoved, 2);
  assert.equal(merged.results[0]?.id, "t.three", "4K ranks first");
  assert.equal(merged.results[0]?.format, "m3u8");
  assert.equal(merged.results[0]?.headers?.Referer, "https://provider.example/");
});

test("coordinator + real runtime: a missing capability is reported per plugin", async (t: TestContext) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "spe-coord2-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = path.join(base, "t.nocaps");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({ id: "t.nocaps", name: "nc", version: "1.0.0", entry: "plugin.js" }),
  );
  await writeFile(path.join(dir, "plugin.js"), "export const plugin = { other() { return 1; } };");

  const manager = new PluginManager();
  await manager.discoverPlugins(base);
  const runtime = new PluginRuntime({ logger: () => {} });
  t.after(() => runtime.shutdown());
  const plugin = manager.getPlugin("t.nocaps");
  assert.ok(plugin);
  const loaded = await runtime.loadPlugin(plugin);
  assert.ok(loaded.ok, loaded.ok ? "" : JSON.stringify(loaded.error));

  const coordinator = new PluginCoordinator(runtime);
  const result = await coordinator.collectSources([loaded.plugin]);

  assert.equal(result.stats.totalResults, 0);
  assert.equal(result.stats.pluginsFailed, 1);
  assert.equal(result.outcomes[0]?.error?.type, "PLUGIN_CAPABILITY_NOT_FOUND");
});
