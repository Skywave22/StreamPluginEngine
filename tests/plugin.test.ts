import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { PluginLoader } from "../src/loader.js";
import { PluginManager } from "../src/manager.js";
import type { PluginManifest } from "../src/types.js";

/** plugins/ directory at the repository root, independent of cwd. */
const REPO_PLUGINS_DIR = fileURLToPath(new URL("../../plugins/", import.meta.url));

async function makeTempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "spe-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function validManifest(id: string): PluginManifest {
  return { id, name: "Test Plugin", version: "1.0.0", entry: "plugin.js" };
}

/**
 * Writes a plugin directory (manifest.json + placeholder plugin.js) under
 * `base` and returns its path.
 */
async function writePlugin(
  base: string,
  dirName: string,
  manifest: object,
): Promise<string> {
  const dir = path.join(base, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  await writeFile(
    path.join(dir, "plugin.js"),
    'export const pluginName = "Test";\n',
  );
  return dir;
}

test("example plugin is discovered from the plugins directory", async () => {
  const manager = new PluginManager();
  await manager.discoverPlugins(REPO_PLUGINS_DIR);

  const plugins = manager.listPlugins();
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0]?.status, "loaded");

  const example = manager.getPlugin("example.source");
  assert.ok(example, "example.source should be registered");
  assert.equal(example.status, "loaded");
  assert.equal(example.manifest?.name, "Example Source");
  assert.equal(example.manifest?.version, "1.0.0");
  assert.equal(example.manifest?.entry, "plugin.js");
  assert.equal(manager.getProblems().length, 0);
});

test("example plugin manifest is loaded with a safe entry path", async () => {
  const loader = new PluginLoader();
  const plugin = await loader.loadPlugin(path.join(REPO_PLUGINS_DIR, "example"));

  assert.equal(plugin.status, "loaded");
  assert.ok(plugin.manifest);
  assert.equal(plugin.manifest.id, "example.source");
  assert.ok(plugin.entryPath, "entryPath should be set for a loaded plugin");
  assert.ok(
    plugin.entryPath.endsWith(path.join("plugins", "example", "plugin.js")),
  );
  // Entry must stay inside the plugin directory.
  assert.equal(path.relative(plugin.pluginPath, plugin.entryPath), "plugin.js");
});

test("plugin without id is rejected and not registered", async (t) => {
  const base = await makeTempDir(t);
  const manifest: Record<string, unknown> = { ...validManifest("broken.id") };
  delete manifest.id;
  await writePlugin(base, "broken", manifest);

  const manager = new PluginManager();
  await manager.discoverPlugins(base);

  assert.equal(manager.listPlugins().length, 0);
  const [problem] = manager.getProblems();
  assert.ok(problem, "broken plugin should be recorded as a problem");
  assert.equal(problem.status, "invalid");
  assert.ok(problem.errors?.some((e) => e.includes("'id' is required")));
});

test("duplicate plugin IDs are not both registered", async (t) => {
  const base = await makeTempDir(t);
  await writePlugin(base, "first", validManifest("dup.id"));
  await writePlugin(base, "second", validManifest("dup.id"));

  const manager = new PluginManager();
  await manager.discoverPlugins(base);

  const plugins = manager.listPlugins();
  assert.equal(plugins.length, 1, "only one of the duplicates may be registered");
  // Discovery is sorted by directory name, so "first" wins.
  assert.equal(manager.getPlugin("dup.id")?.pluginPath, path.resolve(base, "first"));

  const [problem] = manager.getProblems();
  assert.ok(problem, "duplicate should be recorded as a problem");
  assert.equal(problem.status, "failed");
  assert.ok(problem.errors?.some((e) => e.includes("Duplicate plugin ID")));
});

test("one invalid plugin does not prevent valid plugins from loading", async (t) => {
  const base = await makeTempDir(t);
  await writePlugin(base, "bad", {
    id: 42,
    name: "Bad",
    version: "1.0",
    entry: "../outside.js",
  });
  await writePlugin(base, "good-one", validManifest("good.one"));
  await writePlugin(base, "good-two", validManifest("good.two"));

  const manager = new PluginManager();
  await manager.discoverPlugins(base);

  const loadedIds = manager.listPlugins().map((p) => p.manifest?.id).sort();
  assert.deepEqual(loadedIds, ["good.one", "good.two"]);
  assert.equal(manager.getProblems().length, 1, "only the bad plugin is a problem");
  assert.equal(manager.getProblems()[0]?.status, "invalid");
});

test("malformed manifest JSON is reported, not thrown", async (t) => {
  const base = await makeTempDir(t);
  const dir = path.join(base, "corrupt");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "manifest.json"), "{ not json");

  const manager = new PluginManager();
  await manager.discoverPlugins(base);

  assert.equal(manager.listPlugins().length, 0);
  const [problem] = manager.getProblems();
  assert.ok(problem, "corrupt plugin should be recorded as a problem");
  assert.equal(problem.status, "failed");
  assert.ok(problem.errors?.some((e) => e.includes("not valid JSON")));
});

test("valid manifest with missing entry file is marked failed", async (t) => {
  const base = await makeTempDir(t);
  const dir = path.join(base, "noentry");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({ ...validManifest("x.y"), entry: "missing.js" }, null, 2),
  );

  const loader = new PluginLoader();
  const plugin = await loader.loadPlugin(dir);
  assert.equal(plugin.status, "failed");
  assert.ok(plugin.errors?.some((e) => e.includes("Entry file not found")));
});

test("subdirectories without manifest.json are skipped", async (t) => {
  const base = await makeTempDir(t);
  await mkdir(path.join(base, "notes"), { recursive: true });
  await writeFile(path.join(base, "notes", "README.md"), "not a plugin\n");
  await writePlugin(base, "real", validManifest("real.one"));

  const manager = new PluginManager();
  await manager.discoverPlugins(base);

  assert.equal(manager.listPlugins().length, 1);
  assert.equal(manager.listPlugins()[0]?.manifest?.id, "real.one");
  assert.equal(manager.getProblems().length, 0);
});

test("empty plugins directory yields no plugins", async (t) => {
  const base = await makeTempDir(t);
  const manager = new PluginManager();
  await manager.discoverPlugins(base);
  assert.equal(manager.listPlugins().length, 0);
  assert.equal(manager.getProblems().length, 0);
});

test("missing plugins directory throws", async (t) => {
  const base = await makeTempDir(t);
  const manager = new PluginManager();
  await assert.rejects(
    manager.discoverPlugins(path.join(base, "does-not-exist")),
    /Plugins directory not found/,
  );
});

test("unregister removes a plugin from the registry", async (t) => {
  const base = await makeTempDir(t);
  await writePlugin(base, "one", validManifest("reg.one"));

  const manager = new PluginManager();
  await manager.discoverPlugins(base);
  assert.ok(manager.getPlugin("reg.one"));

  assert.equal(manager.unregister("reg.one"), true);
  assert.equal(manager.getPlugin("reg.one"), undefined);
  assert.equal(manager.listPlugins().length, 0);
  assert.equal(manager.unregister("reg.one"), false);
});
