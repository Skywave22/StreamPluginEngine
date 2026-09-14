import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { PluginRuntime } from "../src/runtime.js";
import type { Plugin, PluginRuntimeOptions } from "../src/types.js";

async function makeTempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "spe-rt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Writes a plugin directory (manifest.json + plugin.js with the given
 * source) and returns the Phase 2 Plugin representation for it.
 */
async function writePlugin(
  base: string,
  dirName: string,
  source: string,
): Promise<Plugin> {
  const dir = path.join(base, dirName);
  await mkdir(dir, { recursive: true });
  const manifest = {
    id: `t.${dirName}`,
    name: dirName,
    version: "1.0.0",
    entry: "plugin.js",
  };
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(dir, "plugin.js"), source);
  return {
    pluginPath: dir,
    manifest,
    entryPath: path.join(dir, "plugin.js"),
    status: "loaded",
  };
}

function withRuntime(t: TestContext, options?: PluginRuntimeOptions): PluginRuntime {
  const runtime = new PluginRuntime(options);
  t.after(() => runtime.shutdown());
  return runtime;
}

/** Fail the test (instead of hanging) if the runtime exceeds `ms`. */
function guard<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${label} hung (>${ms} ms)`)),
        ms,
      );
      timer.unref();
    }),
  ]);
}

test("valid plugin loads and executes", async (t) => {
  const base = await makeTempDir(t);
  const plugin = await writePlugin(
    base,
    "calc",
    `export const plugin = {
      add: (a, b) => a + b,
      greet: (name) => "hello " + name,
    };`,
  );
  const runtime = withRuntime(t);

  const load = await runtime.loadPlugin(plugin);
  assert.equal(load.ok, true, load.ok ? "" : JSON.stringify(load.error));
  if (!load.ok) return;
  assert.equal(load.plugin.pluginId, "t.calc");
  assert.deepEqual([...load.plugin.capabilities].sort(), ["add", "greet"]);
  assert.ok(load.loadTimeMs >= 0);

  const result = await runtime.execute(load.plugin, "add", [2, 3]);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.error));
  if (result.success) {
    assert.equal(result.value, 5);
    assert.ok(result.executionTimeMs >= 0);
  }
});

test("async capability results resolve", async (t) => {
  const base = await makeTempDir(t);
  const plugin = await writePlugin(
    base,
    "asynctest",
    `export const plugin = {
      async run() {
        await Promise.resolve();
        await Promise.resolve();
        return { done: true };
      },
    };`,
  );
  const runtime = withRuntime(t);
  const load = await runtime.loadPlugin(plugin);
  assert.equal(load.ok, true);
  if (!load.ok) return;

  const result = await guard(runtime.execute(load.plugin, "run"), 5000, "async execute");
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.error));
  if (result.success) {
    assert.deepEqual(result.value, { done: true });
  }
});

test("capability receives manifest and working log", async (t) => {
  const base = await makeTempDir(t);
  const logs: string[] = [];
  const runtime = withRuntime(t, {
    logger: (id, message) => logs.push(`${id} ${message}`),
  });
  const plugin = await writePlugin(
    base,
    "ctx",
    `export const plugin = {
      info(context) {
        context.log("ping", 42);
        return { id: context.manifest.id, name: context.manifest.name };
      },
    };`,
  );
  const load = await runtime.loadPlugin(plugin);
  assert.equal(load.ok, true);
  if (!load.ok) return;

  const result = await runtime.execute(load.plugin, "info");
  assert.ok(result.success);
  if (result.success) {
    assert.deepEqual(result.value, { id: "t.ctx", name: "ctx" });
  }
  assert.ok(logs.some((line) => line.includes("ping 42")), `logs: ${logs.join(" | ")}`);
});

test("capability detection finds only function properties", async (t) => {
  const base = await makeTempDir(t);
  const plugin = await writePlugin(
    base,
    "detect",
    `export const plugin = {
      search: () => 1,
      getDetails: () => 2,
      version: "1.0.0",
      note: "not a function",
    };`,
  );
  const runtime = withRuntime(t);
  const load = await runtime.loadPlugin(plugin);
  assert.equal(load.ok, true);
  if (!load.ok) return;
  assert.deepEqual(load.plugin.capabilities, ["getDetails", "search"]);
});

test("throwing plugin is isolated and the engine stays usable", async (t) => {
  const base = await makeTempDir(t);
  const bad = await writePlugin(
    base,
    "bad",
    `export const plugin = {
      test: () => { throw new Error("boom"); },
    };`,
  );
  const good = await writePlugin(
    base,
    "good",
    `export const plugin = { test: () => "ok" };`,
  );
  const runtime = withRuntime(t);

  const loadBad = await runtime.loadPlugin(bad);
  assert.equal(loadBad.ok, true);
  if (!loadBad.ok) return;
  const r1 = await runtime.execute(loadBad.plugin, "test");
  assert.ok(!r1.success);
  if (!r1.success) {
    assert.equal(r1.error.type, "PLUGIN_RUNTIME_ERROR");
    assert.ok(r1.error.message.includes("boom"), r1.error.message);
  }

  const loadGood = await runtime.loadPlugin(good);
  assert.equal(loadGood.ok, true);
  if (!loadGood.ok) return;
  const r2 = await runtime.execute(loadGood.plugin, "test");
  assert.ok(r2.success);
  if (r2.success) {
    assert.equal(r2.value, "ok");
  }
});

test("invalid exports are rejected with PLUGIN_EXPORT_ERROR", async (t) => {
  const base = await makeTempDir(t);
  const noPlugin = await writePlugin(
    base,
    "noplug",
    `export const other = { test: () => 1 };`,
  );
  const stringPlugin = await writePlugin(
    base,
    "strplug",
    `export const plugin = "nope";`,
  );
  const noFunctions = await writePlugin(
    base,
    "nofns",
    `export const plugin = { version: "1.0.0" };`,
  );
  const runtime = withRuntime(t);
  for (const p of [noPlugin, stringPlugin, noFunctions]) {
    const load = await runtime.loadPlugin(p);
    assert.equal(load.ok, false, `expected ${p.pluginPath} to fail`);
    if (!load.ok) {
      assert.equal(load.error.type, "PLUGIN_EXPORT_ERROR", load.error.message);
    }
  }
});

test("plugin cannot reach host globals (process)", async (t) => {
  const base = await makeTempDir(t);
  const plugin = await writePlugin(
    base,
    "hosty",
    `export const plugin = {
      test: () => { process.exit(1); return "unreachable"; },
    };`,
  );
  const runtime = withRuntime(t);
  const load = await runtime.loadPlugin(plugin);
  assert.equal(load.ok, true, "module eval must not touch process");
  if (!load.ok) return;

  const result = await runtime.execute(load.plugin, "test");
  assert.ok(!result.success);
  if (!result.success) {
    assert.equal(result.error.type, "PLUGIN_RUNTIME_ERROR");
    assert.match(result.error.message, /process is not defined|ReferenceError/);
  }
  // The host process is still alive (we are still running this test).
});

test("runaway plugin is interrupted at the time limit", async (t) => {
  const base = await makeTempDir(t);
  const plugin = await writePlugin(
    base,
    "spin",
    `export const plugin = {
      test: () => { let n = 0; while (true) n++; return n; },
    };`,
  );
  const runtime = withRuntime(t, { timeoutMs: 200 });
  const load = await guard(runtime.loadPlugin(plugin), 5000, "load");
  assert.equal(load.ok, true);
  if (!load.ok) return;

  const started = Date.now();
  const result = await guard(runtime.execute(load.plugin, "test"), 5000, "execute");
  assert.ok(Date.now() - started < 5000, "execute must not hang");
  assert.ok(!result.success);
  if (!result.success) {
    assert.equal(result.error.type, "PLUGIN_TIMEOUT");
    assert.ok(result.executionTimeMs < 5000);
  }
});

test("plugin exceeding the memory limit fails with PLUGIN_MEMORY_LIMIT", async (t) => {
  const base = await makeTempDir(t);
  const plugin = await writePlugin(
    base,
    "hungry",
    `export const plugin = {
      test: () => {
        const a = [];
        for (;;) a.push("x".repeat(1024));
        return a;
      },
    };`,
  );
  const runtime = withRuntime(t, { memoryLimitBytes: 2 * 1024 * 1024 });
  const load = await guard(runtime.loadPlugin(plugin), 10000, "load");
  if (!load.ok) {
    // The limit may be hit during module evaluation already.
    assert.equal(load.error.type, "PLUGIN_MEMORY_LIMIT", load.error.message);
    return;
  }
  const result = await guard(runtime.execute(load.plugin, "test"), 10000, "execute");
  assert.ok(!result.success);
  if (!result.success) {
    assert.equal(result.error.type, "PLUGIN_MEMORY_LIMIT", result.error.message);
  }
});

test("entry file with a syntax error fails to load", async (t) => {
  const base = await makeTempDir(t);
  const plugin = await writePlugin(
    base,
    "broken",
    `export const plugin = { test: ( => 1 };`,
  );
  const runtime = withRuntime(t);
  const load = await runtime.loadPlugin(plugin);
  assert.equal(load.ok, false);
  if (!load.ok) {
    assert.equal(load.error.type, "PLUGIN_LOAD_ERROR");
  }
});

test("importing a host module is rejected", async (t) => {
  const base = await makeTempDir(t);
  const plugin = await writePlugin(
    base,
    "hostimport",
    `import fs from "node:fs";
export const plugin = { test: () => 1 };`,
  );
  const runtime = withRuntime(t);
  const load = await runtime.loadPlugin(plugin);
  assert.equal(load.ok, false, "node: imports must be rejected");
  if (!load.ok) {
    assert.equal(load.error.type, "PLUGIN_LOAD_ERROR");
    assert.match(load.error.message, /node:fs|module|export/);
  }
});

test("relative imports inside the plugin directory work", async (t) => {
  const base = await makeTempDir(t);
  const dir = path.join(base, "multi");
  await mkdir(dir, { recursive: true });
  const manifest = {
    id: "t.multi",
    name: "multi",
    version: "1.0.0",
    entry: "plugin.js",
  };
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  await writeFile(
    path.join(dir, "plugin.js"),
    `import { half } from "./util.js";
export const plugin = { test: () => half(10) };`,
  );
  await writeFile(path.join(dir, "util.js"), `export function half(n) { return n / 2; }`);
  const plugin: Plugin = {
    pluginPath: dir,
    manifest,
    entryPath: path.join(dir, "plugin.js"),
    status: "loaded",
  };

  const runtime = withRuntime(t);
  const load = await runtime.loadPlugin(plugin);
  assert.equal(load.ok, true, load.ok ? "" : JSON.stringify(load.error));
  if (!load.ok) return;
  const result = await runtime.execute(load.plugin, "test");
  assert.ok(result.success);
  if (result.success) {
    assert.equal(result.value, 5);
  }
});

test("imports escaping the plugin directory are rejected", async (t) => {
  const base = await makeTempDir(t);
  // A real file outside the plugin dir — proves the import is rejected by
  // the containment rule, not by a missing file.
  await writeFile(path.join(base, "secret.js"), `export const s = 1;`);
  const plugin = await writePlugin(
    base,
    "escape",
    `import { s } from "../secret.js";
export const plugin = { test: () => s };`,
  );
  const runtime = withRuntime(t);
  const load = await runtime.loadPlugin(plugin);
  assert.equal(load.ok, false, "escaping imports must be rejected");
  if (!load.ok) {
    assert.equal(load.error.type, "PLUGIN_LOAD_ERROR");
  }
});

test("unknown capability returns PLUGIN_CAPABILITY_NOT_FOUND", async (t) => {
  const base = await makeTempDir(t);
  const plugin = await writePlugin(
    base,
    "onecap",
    `export const plugin = { only: () => 1 };`,
  );
  const runtime = withRuntime(t);
  const load = await runtime.loadPlugin(plugin);
  assert.equal(load.ok, true);
  if (!load.ok) return;

  const result = await runtime.execute(load.plugin, "nope");
  assert.ok(!result.success);
  if (!result.success) {
    assert.equal(result.error.type, "PLUGIN_CAPABILITY_NOT_FOUND");
    assert.match(result.error.message, /nope/);
    assert.match(result.error.message, /only/);
  }
});

test("JSON arguments are passed through to the capability", async (t) => {
  const base = await makeTempDir(t);
  const plugin = await writePlugin(
    base,
    "args",
    `export const plugin = {
      all: (a, b, c, context) => ({
        a, b, c,
        manifestId: context.manifest.id,
      }),
    };`,
  );
  const runtime = withRuntime(t);
  const load = await runtime.loadPlugin(plugin);
  assert.equal(load.ok, true);
  if (!load.ok) return;

  const result = await runtime.execute(load.plugin, "all", [1, "two", [3, 4]]);
  assert.ok(result.success);
  if (result.success) {
    assert.deepEqual(result.value, {
      a: 1,
      b: "two",
      c: [3, 4],
      manifestId: "t.args",
    });
  }
});

test("capability that never settles times out", async (t) => {
  const base = await makeTempDir(t);
  const plugin = await writePlugin(
    base,
    "stall",
    `export const plugin = {
      test: async () => { return await new Promise(() => {}); },
    };`,
  );
  const runtime = withRuntime(t, { timeoutMs: 300 });
  const load = await guard(runtime.loadPlugin(plugin), 5000, "load");
  assert.equal(load.ok, true);
  if (!load.ok) return;

  const result = await guard(runtime.execute(load.plugin, "test"), 5000, "execute");
  assert.ok(!result.success);
  if (!result.success) {
    assert.equal(result.error.type, "PLUGIN_TIMEOUT");
    assert.ok(result.executionTimeMs < 5000);
  }
});

test("dispose frees a plugin's guest environment", async (t) => {
  const base = await makeTempDir(t);
  const plugin = await writePlugin(
    base,
    "disp",
    `export const plugin = { test: () => 1 };`,
  );
  const runtime = withRuntime(t);
  const load = await runtime.loadPlugin(plugin);
  assert.equal(load.ok, true);
  if (!load.ok) return;
  assert.equal(runtime.dispose(load.plugin), true);
  assert.equal(runtime.dispose(load.plugin), false, "double dispose returns false");
  // Runtime itself is still usable for other plugins.
  const other = await writePlugin(
    base,
    "after",
    `export const plugin = { test: () => 2 };`,
  );
  const loadOther = await runtime.loadPlugin(other);
  assert.equal(loadOther.ok, true);
  if (loadOther.ok) {
    const result = await runtime.execute(loadOther.plugin, "test");
    assert.ok(result.success);
    if (result.success) assert.equal(result.value, 2);
  }
});
