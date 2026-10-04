/**
 * v0.3.0: handle-based HTML capability (plugin API version 2).
 *
 * Version 1 of `context.html` serialized the whole document tree INTO
 * the guest and serialized matched nodes back OUT on every call, so the
 * Wasm boundary — not the parser — dominated cost, and documents deeper
 * than ~500 nesting levels could not be delivered at all. Version 2
 * keeps the tree host-side and crosses only numeric handles.
 *
 * These tests prove the behavioural contract: same function names, same
 * structured errors, plus (a) handles are per-call, (b) forged handles
 * are rejected, (c) the ~500-level limit is gone, and (d) apiVersion 1
 * plugins keep the old tree-based behaviour untouched.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { ENGINE_API_VERSION } from "../src/manifest.js";
import { PluginManager } from "../src/manager.js";
import { PluginRuntime } from "../src/runtime.js";
import type { LoadedPlugin } from "../src/types.js";

/** Wrap a plugin body in the module contract. */
const pluginSource = (body: string): string => `export const plugin = {${body}};`;

const SHAPE_PLUGIN = pluginSource(`
  parse(html, context) {
    return context.html.parse(html);
  },
  pipeline(html, context) {
    const doc = context.html.parse(html);
    const items = context.html.select(doc, "a.link");
    return {
      handles: items,
      handleTypes: items.map((h) => typeof h),
      texts: items.map((h) => context.html.extract(h).text),
      hrefs: items.map((h) => context.html.extract(h).href),
    };
  },
  selectFromElement(html, context) {
    const doc = context.html.parse(html);
    const sections = context.html.select(doc, "section");
    const links = context.html.select(sections[0], "a");
    return links.map((h) => context.html.extract(h).text);
  },
  async badSelector(html, context) {
    const doc = context.html.parse(html);
    try {
      await context.html.select(doc, "!!!not a selector(");
      return { handled: true };
    } catch (e) {
      return { handled: false, code: e.code };
    }
  },
  async forged(elementId, context) {
    try {
      return await context.html.extract(elementId);
    } catch (e) {
      return { code: e.code };
    }
  },
  async tooMany(html, context) {
    const doc = context.html.parse(html);
    try {
      await context.html.select(doc, "i");
      return { handled: true };
    } catch (e) {
      return { handled: false, code: e.code };
    }
  },
  async errors(html, context) {
    const report = {};
    try {
      await context.html.select(html, "a");
    } catch (e) {
      report.notAHandle = { code: e.code };
    }
    try {
      await context.html.parse(123);
    } catch (e) {
      report.nonString = { code: e.code };
    }
    return report;
  },
`);

/** Stores a handle on the plugin object across capability calls. */
const CROSS_CALL_PLUGIN = `
let saved = null;
${pluginSource(`
  stash(html, context) {
    saved = context.html.parse(html);
    return saved;
  },
  async reuse(context) {
    try {
      return { ok: true, links: (await context.html.select(saved, "a")).length };
    } catch (e) {
      return { ok: false, code: e.code };
    }
  },
`)}`;

/** apiVersion 1: the tree-based behaviour must be unchanged. */
const V1_PLUGIN = pluginSource(`
  pipeline(html, context) {
    const doc = context.html.parse(html);
    const isTree = doc && doc.type === "document" && Array.isArray(doc.children);
    const items = context.html.select(doc, "a.link");
    return {
      isTree,
      nodeTypes: items.map((el) => el.type),
      texts: items.map((el) => context.html.extract(el).text),
    };
  },
  async deep(levels, context) {
    let html = "";
    for (let i = 0; i < levels; i++) html += "<div>";
    try {
      await context.html.parse(html);
      return { ok: true };
    } catch (e) {
      return { ok: false, code: e.code, message: e.message };
    }
  },
`);

const DEEP_PLUGIN = pluginSource(`
  deep(levels, context) {
    let html = "<div class='wrap'>";
    for (let i = 0; i < levels; i++) html += "<div>";
    html += "<a class='deep' href='/x'>bottom</a>";
    for (let i = 0; i < levels; i++) html += "</div>";
    html += "</div>";
    const doc = context.html.parse(html);
    const links = context.html.select(doc, "a.deep");
    return { matches: links.length, text: context.html.extract(links[0]).text };
  },
`);

async function load(
  t: TestContext,
  options: { source: string; apiVersion?: number; dirName?: string },
): Promise<{ runtime: PluginRuntime; plugin: LoadedPlugin }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "spe-html2-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dirName = options.dirName ?? "t.html";
  const dir = path.join(base, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id: `t.${dirName}`,
      name: dirName,
      version: "1.0.0",
      entry: "plugin.js",
      ...(options.apiVersion === undefined
        ? {}
        : { apiVersion: options.apiVersion }),
    }),
  );
  await writeFile(path.join(dir, "plugin.js"), options.source);

  const manager = new PluginManager();
  await manager.discoverPlugins(base);
  const discovered = manager.getPlugin(`t.${dirName}`);
  assert.ok(discovered);
  const runtime = new PluginRuntime({ logger: () => {} });
  t.after(() => runtime.shutdown());
  const result = await runtime.loadPlugin(discovered);
  assert.ok(result.ok, result.ok ? "" : JSON.stringify(result.error));
  return { runtime, plugin: result.plugin };
}

const LINKS_HTML =
  "<div id='main'><a class='link' href='/one'> One </a><a class='link' href='/two'>Two</a></div>";

test("html v2: parse returns a NUMBER handle, not a tree", async (t) => {
  const { runtime, plugin } = await load(t, {
    source: SHAPE_PLUGIN,
    apiVersion: 2,
  });
  const result = await runtime.execute(plugin, "parse", ["<p>hi</p>"]);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.error));
  assert.equal(typeof result.value, "number");
  assert.equal(result.value, 1, "handles start at 1");
  assert.equal(plugin.capabilities.includes("pipeline"), true);
});

test("html v2: the full pipeline works with handles end to end", async (t) => {
  const { runtime, plugin } = await load(t, {
    source: SHAPE_PLUGIN,
    apiVersion: 2,
  });
  const result = await runtime.execute(plugin, "pipeline", [LINKS_HTML]);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.error));
  const value = result.value as {
    handles: number[];
    handleTypes: string[];
    texts: string[];
    hrefs: string[];
  };
  assert.equal(value.handles.length, 2);
  assert.deepEqual(value.handleTypes, ["number", "number"]);
  assert.deepEqual(value.texts, ["One", "Two"]);
  assert.deepEqual(value.hrefs, ["/one", "/two"]);
});

test("html v2: select accepts an element handle as its root", async (t) => {
  const { runtime, plugin } = await load(t, {
    source: SHAPE_PLUGIN,
    apiVersion: 2,
  });
  const html =
    "<section><a>a1</a></section><section><a>a2</a></section>";
  const result = await runtime.execute(plugin, "selectFromElement", [html]);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.error));
  assert.deepEqual(result.value, ["a1"], "only the first section's link");
});

test("html v2: structured errors are preserved (bad selector, wrong types, forged handles)", async (t) => {
  const { runtime, plugin } = await load(t, {
    source: SHAPE_PLUGIN,
    apiVersion: 2,
  });

  const badSelector = await runtime.execute(plugin, "badSelector", [LINKS_HTML]);
  assert.ok(badSelector.success, "the plugin catches the rejection and returns");
  const badSelectorValue = badSelector.value as { handled: boolean; code?: string };
  assert.equal(badSelectorValue.handled, false);
  assert.equal(badSelectorValue.code, "HTML_SELECT_ERROR");

  // Wrong argument types produce their own structured codes.
  const typeErrors = await runtime.execute(plugin, "errors", [LINKS_HTML]);
  assert.ok(typeErrors.success, typeErrors.success ? "" : JSON.stringify(typeErrors.error));
  const errors = typeErrors.value as Record<string, { code: string }>;
  assert.equal(errors.notAHandle?.code, "HTML_SELECT_ERROR");
  assert.equal(errors.nonString?.code, "HTML_INVALID_INPUT");

  // A forged handle (never issued) is rejected, not crashed on.
  const forged = await runtime.execute(plugin, "forged", [999_999]);
  assert.ok(forged.success, forged.success ? "" : JSON.stringify(forged.error));
  const forgedValue = forged.value as { code?: string };
  assert.equal(forgedValue.code, "HTML_STALE_HANDLE");

  // The select result-count limit still applies in v2.
  const tooMany = await runtime.execute(plugin, "tooMany", [
    `<div>${"<i>x</i>".repeat(1_005)}</div>`,
  ]);
  assert.ok(tooMany.success);
  assert.equal((tooMany.value as { code?: string }).code, "HTML_TOO_MANY_RESULTS");
});

test("html v2: handles do not survive the capability call", async (t) => {
  const { runtime, plugin } = await load(t, {
    source: CROSS_CALL_PLUGIN,
    apiVersion: 2,
    dirName: "t.stash",
  });
  const first = await runtime.execute(plugin, "stash", [LINKS_HTML]);
  assert.ok(first.success, first.success ? "" : JSON.stringify(first.error));
  assert.equal(typeof first.value, "number");

  const second = await runtime.execute(plugin, "reuse");
  assert.ok(second.success);
  const value = second.value as { ok: boolean; code?: string };
  assert.equal(value.ok, false, "the stashed handle must be rejected");
  assert.equal(value.code, "HTML_STALE_HANDLE");
});

test("html v2: deep documents work (the ~500-level delivery limit is gone)", async (t) => {
  const { runtime, plugin } = await load(t, {
    source: DEEP_PLUGIN,
    apiVersion: 2,
    dirName: "t.deep2",
  });
  const result = await runtime.execute(plugin, "deep", [5_000]);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.error));
  assert.deepEqual(result.value, { matches: 1, text: "bottom" });
});

test("html v1 (no apiVersion declared): tree-based behaviour is unchanged", async (t) => {
  const { runtime, plugin } = await load(t, { source: V1_PLUGIN, dirName: "t.v1" });
  const result = await runtime.execute(plugin, "pipeline", [LINKS_HTML]);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.error));
  const value = result.value as {
    isTree: boolean;
    nodeTypes: string[];
    texts: string[];
  };
  assert.equal(value.isTree, true, "v1 still receives the document tree");
  assert.deepEqual(value.nodeTypes, ["element", "element"]);
  assert.deepEqual(value.texts, ["One", "Two"]);
});

test("html v1: the deep-document limitation is still reported structurally", async (t) => {
  const { runtime, plugin } = await load(t, {
    source: V1_PLUGIN,
    apiVersion: 1,
    dirName: "t.v1deep",
  });
  const result = await runtime.execute(plugin, "deep", [2_000]);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.error));
  const value = result.value as { ok: boolean; code?: string; message?: string };
  assert.equal(value.ok, false, "v1 cannot deliver a tree this deep");
  assert.equal(value.code, "HTML_PARSE_ERROR");
  assert.match(String(value.message), /too deep|depth/i);
});

test("manifest: apiVersion above the engine's is still rejected", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "spe-html2-bad-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = path.join(base, "t.future");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id: "t.future",
      name: "future",
      version: "1.0.0",
      entry: "plugin.js",
      apiVersion: ENGINE_API_VERSION + 1,
    }),
  );
  await writeFile(path.join(dir, "plugin.js"), pluginSource(" ping() { return 1; },"));

  const manager = new PluginManager();
  await manager.discoverPlugins(base);
  assert.equal(manager.getPlugin("t.future"), undefined, "invalid plugins are not registered");
  const problems = manager.getProblems();
  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.status, "invalid");
  assert.match(
    (problems[0]?.errors ?? []).join("\n"),
    /apiVersion.*not supported/i,
  );
});
