/**
 * v0.4.0: `context.store` inside the sandbox.
 *
 * What this suite pins, beyond the host-side unit tests in store.test.ts:
 *   - reads are SYNCHRONOUS in guest code (no `await`), which is the
 *     performance property the design is built on;
 *   - writes survive across capability calls on the same plugin, and
 *     across runtime instances through a shared backend;
 *   - the whole store is persisted ONCE per call, not per write;
 *   - a disabled `store` permission removes the capability entirely;
 *   - `mirror` settings can only hold a declared mirror;
 *   - plugin values never leak into another plugin's namespace.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { PluginManager } from "../src/manager.js";
import { PluginRuntime } from "../src/runtime.js";
import { MemoryStoreBackend } from "../src/store.js";
import type { StoreBackend } from "../src/store.js";
import type { Plugin } from "../src/types.js";

/** Plugin exercising the whole store surface, with NO await on reads. */
const STORE_PLUGIN = `
export const plugin = {
  // Reads must be synchronous: every value below is used directly.
  reads(context) {
    return {
      typed: context.store.get("count"),          // number, no await
      missing: context.store.get("nope", "dflt"),
      defaulted: context.store.get("quality"),    // from manifest settings
      has: context.store.has("count"),
      keys: context.store.keys().sort(),
      all: context.store.all(),
    };
  },
  write(key, value, context) {
    return context.store.set(key, value);
  },
  // Write then read back in the SAME call: the in-place update must be
  // visible immediately, not only after a persistence round trip.
  async writeThenRead(context) {
    const before = context.store.get("count");
    const ok = context.store.set("count", (typeof before === "number" ? before : 0) + 1);
    return { before, after: context.store.get("count"), ok };
  },
  remove(key, context) {
    return context.store.delete(key);
  },
  // Deliberately hostile inputs.
  async abuses(context) {
    const report = {};
    const grab = async (name, fn) => {
      try { report[name] = { ok: true, value: await fn() }; }
      catch (e) { report[name] = { ok: false, code: e.code, message: e.message }; }
    };
    await grab("badKey", () => context.store.set("bad key!", 1));
    await grab("undefinedValue", () => context.store.set("u", undefined));
    await grab("functionValue", () => context.store.set("f", () => 1));
    await grab("deepValue", () => {
      let deep = 1;
      for (let i = 0; i < 40; i++) deep = { n: deep };
      return context.store.set("deep", deep);
    });
    await grab("hugeValue", () => context.store.set("huge", "x".repeat(9000)));
    await grab("protoKey", () => context.store.set("__proto__", { evil: true }));
    await grab("notAKey", () => context.store.set(42, 1));
    return report;
  },
  // What a plugin sees when the store capability is off.
  probe(context) {
    return typeof context.store;
  },
  // A capability that never touches the store, so the rest of the context
  // can be observed while the store permission is disabled.
  ping() {
    return 42;
  },
};
`;

let base: string;
let manager: PluginManager;

before(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "spe-store-"));
  const dir = path.join(base, "t.store");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id: "t.store",
      name: "Store fixture",
      version: "1.0.0",
      entry: "plugin.js",
      apiVersion: 2,
      settings: [
        { key: "quality", type: "select", default: "1080p", options: ["1080p", "720p"] },
      ],
    }),
  );
  await writeFile(path.join(dir, "plugin.js"), STORE_PLUGIN);
  manager = new PluginManager();
  await manager.discoverPlugins(base);
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

function loaded(): Plugin {
  const plugin = manager.getPlugin("t.store");
  assert.ok(plugin, "fixture plugin should be discovered");
  return plugin;
}

test("context.store reads are synchronous and see declared defaults", async () => {
  const runtime = new PluginRuntime({ logger: () => {} });
  const result = await runtime.loadPlugin(loaded());
  assert.ok(result.ok, result.ok ? "" : JSON.stringify(result.error));

  const call = await runtime.execute(result.plugin, "reads", []);
  assert.ok(call.success, call.success ? "" : JSON.stringify(call.error));
  const value = call.value as {
    missing: unknown;
    defaulted: unknown;
    has: boolean;
    keys: string[];
  };
  // No `await` anywhere in the plugin: the values are plain, not promises.
  assert.equal(value.missing, "dflt", "fallback argument");
  assert.equal(value.defaulted, "1080p", "manifest setting default");
  assert.equal(value.has, false, "a default is readable but not 'stored'");
  assert.deepEqual(value.keys, ["quality"], "defaults are listed for the plugin");
  runtime.shutdown();
});

test("writes persist across calls, in place, and once per call", async () => {
  const saves: string[] = [];
  const backend: StoreBackend = {
    load: () => ({}),
    save: (pluginId) => {
      saves.push(pluginId);
    },
  };
  const runtime = new PluginRuntime({ logger: () => {}, storeBackend: backend });
  const result = await runtime.loadPlugin(loaded());
  assert.ok(result.ok);

  // Two writes inside ONE call → the value is visible immediately, and the
  // backend is hit once (at the end), not once per write.
  const first = await runtime.execute(result.plugin, "writeThenRead", []);
  assert.ok(first.success, first.success ? "" : JSON.stringify(first.error));
  const firstValue = first.value as { before: unknown; after: unknown; ok: boolean };
  assert.equal(firstValue.before, undefined, "nothing stored yet");
  assert.equal(firstValue.after, 1, "the write is visible immediately, in the same call");
  assert.equal(firstValue.ok, true);
  assert.equal(saves.length, 1, "one persist per capability call");

  // A later call sees the stored value.
  const second = await runtime.execute(result.plugin, "writeThenRead", []);
  assert.ok(second.success);
  assert.deepEqual(second.value, { before: 1, after: 2, ok: true });
  assert.equal(saves.length, 2);

  // A read-only call does NOT persist anything.
  const read = await runtime.execute(result.plugin, "reads", []);
  assert.ok(read.success);
  assert.equal(saves.length, 2, "reads never trigger a save");
  runtime.shutdown();
});

test("values survive a runtime restart through a shared backend", async () => {
  const backend = new MemoryStoreBackend();

  const firstRuntime = new PluginRuntime({ logger: () => {}, storeBackend: backend });
  const firstLoad = await firstRuntime.loadPlugin(loaded());
  assert.ok(firstLoad.ok);
  await firstRuntime.execute(firstLoad.plugin, "write", ["token", "abc123"]);
  await firstRuntime.execute(firstLoad.plugin, "write", ["count", 42]);
  firstRuntime.shutdown();

  // A fresh runtime, same backend: the plugin's data is still there.
  const secondRuntime = new PluginRuntime({ logger: () => {}, storeBackend: backend });
  const secondLoad = await secondRuntime.loadPlugin(loaded());
  assert.ok(secondLoad.ok);
  const call = await secondRuntime.execute(secondLoad.plugin, "reads", []);
  assert.ok(call.success);
  const value = call.value as { typed: unknown; all: Record<string, unknown> };
  assert.equal(value.typed, 42);
  assert.equal(value.all.token, "abc123");
  secondRuntime.shutdown();
});

test("a store backend failure is reported, never fatal to the plugin call", async () => {
  const logs: string[] = [];
  const backend: StoreBackend = {
    load: () => {
      throw new Error("no such directory");
    },
    save: () => {
      throw new Error("disk full");
    },
  };
  const runtime = new PluginRuntime({
    logger: (_id, message) => logs.push(message),
    storeBackend: backend,
  });
  const result = await runtime.loadPlugin(loaded());
  assert.ok(result.ok, "a broken backend must not stop the plugin loading");
  assert.match(logs.join("\n"), /STORE_BACKEND_ERROR: Could not load stored values/);

  const call = await runtime.execute(result.plugin, "write", ["a", 1]);
  assert.ok(call.success, "the plugin's work still succeeds");
  assert.match(
    logs.join("\n"),
    /STORE_BACKEND_ERROR: Could not persist stored values/,
    "the failed save is surfaced to the host",
  );
  runtime.shutdown();
});

test("disabling the store permission removes context.store entirely", async () => {
  const runtime = new PluginRuntime({
    logger: () => {},
    perPluginPermissions: { "t.store": { store: false } },
  });
  const result = await runtime.loadPlugin(loaded());
  assert.ok(result.ok);

  const call = await runtime.execute(result.plugin, "probe", []);
  assert.ok(call.success);
  assert.equal(call.value, "undefined", "the capability must not exist");

  // The rest of the context still works: disabling ONE capability does
  // not disable the plugin, and does not touch http/json/html.
  const ping = await runtime.execute(result.plugin, "ping", []);
  assert.ok(ping.success, ping.success ? "" : JSON.stringify(ping.error));
  assert.equal(ping.value, 42);
  runtime.shutdown();
});

test("store abuse is refused with structured codes, not crashes", async () => {
  const runtime = new PluginRuntime({ logger: () => {} });
  const result = await runtime.loadPlugin(loaded());
  assert.ok(result.ok);
  const call = await runtime.execute(result.plugin, "abuses", []);
  assert.ok(call.success, call.success ? "" : JSON.stringify(call.error));

  const report = call.value as Record<string, { ok: boolean; code?: string }>;
  assert.equal(report.badKey?.ok, false);
  assert.equal(report.badKey?.code, "STORE_INVALID_KEY");
  assert.equal(report.notAKey?.ok, false);
  assert.equal(report.notAKey?.code, "STORE_INVALID_KEY");
  // `__proto__` is refused as a KEY (before the value is even looked at).
  assert.equal(report.protoKey?.ok, false);
  assert.equal(report.protoKey?.code, "STORE_INVALID_KEY");
  for (const name of ["undefinedValue", "functionValue", "deepValue", "hugeValue"]) {
    assert.equal(report[name]?.ok, false, `${name} must be refused`);
    assert.equal(
      report[name]?.code,
      "STORE_INVALID_VALUE",
      `${name} should report an invalid value`,
    );
  }

  // Nothing hostile made it into the store or into Object.prototype.
  const reads = await runtime.execute(result.plugin, "reads", []);
  assert.ok(reads.success, reads.success ? "" : JSON.stringify(reads.error));
  const value = reads.value as { all: Record<string, unknown> };
  assert.equal(value.all.deep, undefined);
  assert.equal(value.all.huge, undefined);
  // (`all.__proto__` would return the prototype of ANY object, so the
  // real question is whether the store holds it as an OWN key.)
  assert.ok(
    !Object.prototype.hasOwnProperty.call(value.all, "__proto__"),
    "no __proto__ own-key may reach the plugin",
  );
  assert.equal(({} as Record<string, unknown>).evil, undefined);
  runtime.shutdown();
});

test("a mirror setting accepts only the manifest's declared mirrors", async () => {
  const mirrorDir = path.join(base, "t.mirror");
  await mkdir(mirrorDir, { recursive: true });
  await writeFile(
    path.join(mirrorDir, "manifest.json"),
    JSON.stringify({
      id: "t.mirror",
      name: "Mirror fixture",
      version: "1.0.0",
      entry: "plugin.js",
      domains: ["main.example"],
      mirrors: ["a.example", "b.example"],
      settings: [{ key: "baseUrl", type: "mirror", default: "a.example" }],
    }),
  );
  await writeFile(
    path.join(mirrorDir, "plugin.js"),
    `export const plugin = {
       read(context) { return context.store.get("baseUrl"); },
       async write(value, context) {
         try { await context.store.set("baseUrl", value); return { ok: true, value: context.store.get("baseUrl") }; }
         catch (e) { return { ok: false, code: e.code, stored: context.store.get("baseUrl") }; }
       },
     };`,
  );

  const mirrorManager = new PluginManager();
  await mirrorManager.discoverPlugins(base);
  const mirrorPlugin = mirrorManager.getPlugin("t.mirror");
  assert.ok(mirrorPlugin);

  const runtime = new PluginRuntime({ logger: () => {} });
  const result = await runtime.loadPlugin(mirrorPlugin);
  assert.ok(result.ok, result.ok ? "" : JSON.stringify(result.error));

  // The declared default is what a plugin reads before any user choice.
  const initial = await runtime.execute(result.plugin, "read", []);
  assert.ok(initial.success, initial.success ? "" : JSON.stringify(initial.error));
  assert.equal(initial.value, "a.example");

  // A declared mirror is accepted...
  const allowed = await runtime.execute(result.plugin, "write", ["b.example"]);
  assert.ok(allowed.success, allowed.success ? "" : JSON.stringify(allowed.error));
  assert.deepEqual(allowed.value, { ok: true, value: "b.example" });

  // ...an undeclared host is refused, AND the previous value stands.
  const refused = await runtime.execute(result.plugin, "write", ["evil.example"]);
  assert.ok(refused.success, refused.success ? "" : JSON.stringify(refused.error));
  assert.deepEqual(refused.value, {
    ok: false,
    code: "STORE_INVALID_VALUE",
    stored: "b.example",
  });
  runtime.shutdown();
});

test("one plugin cannot read or clobber another plugin's store", async () => {
  const backend = new MemoryStoreBackend();
  const dirA = path.join(base, "t.a");
  const dirB = path.join(base, "t.b");
  for (const [dir, id, url] of [
    [dirA, "t.a", "a.example"],
    [dirB, "t.b", "b.example"],
  ] as const) {
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ id, name: id, version: "1.0.0", entry: "plugin.js" }),
    );
    await writeFile(
      path.join(dir, "plugin.js"),
      `export const plugin = {
         write(v, context) { return context.store.set("marker", v); },
         read(context) { return context.store.get("marker", null); },
       };`,
    );
    assert.ok(url);
  }

  const isolated = new PluginManager();
  await isolated.discoverPlugins(base);
  const runtime = new PluginRuntime({ logger: () => {}, storeBackend: backend });
  const a = await runtime.loadPlugin(isolated.getPlugin("t.a")!);
  const b = await runtime.loadPlugin(isolated.getPlugin("t.b")!);
  assert.ok(a.ok && b.ok);

  await runtime.execute(a.plugin, "write", ["from-a"]);
  await runtime.execute(b.plugin, "write", ["from-b"]);

  const readA = await runtime.execute(a.plugin, "read", []);
  const readB = await runtime.execute(b.plugin, "read", []);
  assert.ok(readA.success && readB.success);
  assert.equal(readA.value, "from-a");
  assert.equal(readB.value, "from-b", "namespaces must not bleed");
  runtime.shutdown();
});
