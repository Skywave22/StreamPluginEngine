/**
 * Sandbox security tests.
 *
 * IMPORTANT: these tests demonstrate the *engine-level* isolation the
 * runtime provides (a separate QuickJS/Wasm engine with no Node.js
 * globals and no host objects). They are NOT proof of an OS-level
 * security boundary — see README.md / ARCHITECTURE.md for the documented
 * limitations.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { PluginRuntime } from "../src/runtime.js";
import type { Plugin } from "../src/types.js";

async function makeTempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "spe-sec-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writePlugin(
  base: string,
  dirName: string,
  source: string,
): Promise<Plugin> {
  const dir = path.join(base, dirName);
  await mkdir(dir, { recursive: true });
  const manifest = {
    id: `sec.${dirName}`,
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

test("host globals are unavailable inside the sandbox", async (t) => {
  const base = await makeTempDir(t);
  const plugin = await writePlugin(
    base,
    "probe",
    `export const plugin = {
      probe: () => ({
        process: typeof process,
        require: typeof require,
        fetch: typeof fetch,
        Buffer: typeof Buffer,
        module: typeof module,
        __dirname: typeof __dirname,
        __filename: typeof __filename,
        child_process: typeof child_process,
        globalThisProcess: typeof globalThis.process,
        globalThisRequire: typeof globalThis.require,
        functionScope: (() => {
          try {
            return typeof new Function("return process")();
          } catch {
            return "threw";
          }
        })(),
      }),
    };`,
  );
  const runtime = new PluginRuntime();
  t.after(() => runtime.shutdown());

  const load = await runtime.loadPlugin(plugin);
  assert.equal(load.ok, true);
  if (!load.ok) return;
  const result = await runtime.execute(load.plugin, "probe");
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.error));
  if (result.success) {
    assert.deepEqual(result.value, {
      process: "undefined",
      require: "undefined",
      fetch: "undefined",
      Buffer: "undefined",
      module: "undefined",
      __dirname: "undefined",
      __filename: "undefined",
      child_process: "undefined",
      globalThisProcess: "undefined",
      globalThisRequire: "undefined",
      functionScope: "threw",
    });
  }
});

test("eval and Function exist but stay confined to the guest realm (no host escape)", async (t) => {
  // The sandbox intentionally does not delete the JS `eval`/`Function`
  // built-ins: they execute code in the GUEST realm only. This test pins
  // the security-relevant fact that dynamic code execution CANNOT reach
  // the host — no Node globals, no host objects, no module loading.
  const base = await makeTempDir(t);
  const plugin = await writePlugin(
    base,
    "dyn",
    `export const plugin = {
      probe: () => {
        const out = {};
        out.evalType = typeof eval;
        // eval runs, but only against the guest global (no process).
        try { out.evalProcess = eval("typeof process"); } catch { out.evalProcess = "threw"; }
        try { out.evalArith = eval("6 * 7"); } catch { out.evalArith = "threw"; }
        // The Function constructor builds guest-realm functions only.
        try { out.fnProcess = new Function("return typeof process")(); } catch { out.fnProcess = "threw"; }
        // A direct reference to an undeclared host name throws (no leakage).
        try { new Function("return process")(); out.directRef = "resolved"; }
        catch { out.directRef = "threw"; }
        // The guest global is not the host global.
        out.gtProcess = typeof globalThis.process;
        out.gtRequire = typeof globalThis.require;
        return out;
      },
    };`,
  );
  const runtime = new PluginRuntime();
  t.after(() => runtime.shutdown());

  const load = await runtime.loadPlugin(plugin);
  assert.equal(load.ok, true);
  if (!load.ok) return;
  const result = await runtime.execute(load.plugin, "probe");
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.error));
  if (result.success) {
    assert.deepEqual(result.value, {
      evalType: "function",
      evalProcess: "undefined",
      evalArith: 42,
      fnProcess: "undefined",
      directRef: "threw",
      gtProcess: "undefined",
      gtRequire: "undefined",
    });
  }
});

test("the plugin context surface is exactly http + json + html + log + manifest (unchanged through Phase 6)", async (t) => {
  // Phase 5 adds context.json and context.html to the Phase 4 surface
  // (manifest + log + http). The surface must stay exactly this
  // controlled set — no host objects.
  const base = await makeTempDir(t);
  const plugin = await writePlugin(
    base,
    "surface",
    `export const plugin = {
      surface: (context) =>
        Object.keys(context)
          .sort()
          .map((k) => {
            let kind = typeof context[k];
            if (k === "http" || k === "json" || k === "html") {
              const obj = context[k];
              if (typeof obj === "object" && obj !== null) {
                kind = k + "(" + Object.keys(obj).sort().join(",") + ")";
              }
            }
            return k + ":" + kind;
          }),
    };`,
  );
  const runtime = new PluginRuntime();
  t.after(() => runtime.shutdown());

  const load = await runtime.loadPlugin(plugin);
  assert.equal(load.ok, true);
  if (!load.ok) return;
  const result = await runtime.execute(load.plugin, "surface");
  assert.ok(result.success);
  if (result.success) {
    assert.deepEqual(result.value, [
      "html:html(extract,parse,select)",
      "http:http(get,getJson,request)",
      "json:json(parse,stringify)",
      "log:function",
      "manifest:object",
    ]);
  }
});

test("a plugin cannot read host files through imports", async (t) => {
  const base = await makeTempDir(t);
  // Try to import a real absolute path that exists on the host.
  const plugin = await writePlugin(
    base,
    "readhost",
    `import contents from "${process.execPath}";
export const plugin = { test: () => contents };`,
  );
  const runtime = new PluginRuntime();
  t.after(() => runtime.shutdown());

  const load = await runtime.loadPlugin(plugin);
  assert.equal(load.ok, false, "host file imports must be rejected");
});

test("two plugins cannot see each other's globals", async (t) => {
  const base = await makeTempDir(t);
  const a = await writePlugin(
    base,
    "isoa",
    `globalThis.__shared = "from-a";
export const plugin = { peek: () => (typeof globalThis.__from_b === "string" ? globalThis.__from_b : "absent") };`,
  );
  const b = await writePlugin(
    base,
    "isob",
    `globalThis.__from_b = "from-b";
export const plugin = { peek: () => (typeof globalThis.__shared === "string" ? globalThis.__shared : "absent") };`,
  );
  const runtime = new PluginRuntime();
  t.after(() => runtime.shutdown());

  const loadA = await runtime.loadPlugin(a);
  const loadB = await runtime.loadPlugin(b);
  assert.equal(loadA.ok, true);
  assert.equal(loadB.ok, true);
  if (!loadA.ok || !loadB.ok) return;

  const resultA = await runtime.execute(loadA.plugin, "peek");
  const resultB = await runtime.execute(loadB.plugin, "peek");
  assert.ok(resultA.success && resultB.success);
  if (resultA.success && resultB.success) {
    assert.equal(resultA.value, "absent", "plugin A must not see plugin B's globals");
    assert.equal(resultB.value, "absent", "plugin B must not see plugin A's globals");
  }
});

test("runtime errors do not leak host internals", async (t) => {
  const base = await makeTempDir(t);
  const plugin = await writePlugin(
    base,
    "leakcheck",
    `export const plugin = {
      test: () => { throw new Error("boom"); },
    };`,
  );
  const runtime = new PluginRuntime();
  t.after(() => runtime.shutdown());

  const load = await runtime.loadPlugin(plugin);
  assert.equal(load.ok, true);
  if (!load.ok) return;
  const result = await runtime.execute(load.plugin, "test");
  assert.ok(!result.success);
  if (!result.success) {
    const blob = `${result.error.type}: ${result.error.message}`;
    assert.ok(blob.includes("boom"));
    assert.doesNotMatch(blob, /node_modules/);
    assert.doesNotMatch(blob, /StreamPluginEngine/);
    assert.doesNotMatch(blob, /\.d\.ts/);
  }
});
