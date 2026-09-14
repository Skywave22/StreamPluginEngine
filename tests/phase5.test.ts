import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import "../src/phase5.js";
import { PluginRuntime } from "../src/runtime.js";
import type { Plugin } from "../src/types.js";

async function temp(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "spe-phase5-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function plugin(
  base: string,
  name: string,
  source: string,
): Promise<Plugin> {
  const dir = path.join(base, name);
  await mkdir(dir, { recursive: true });
  const manifest = {
    id: `t.${name}`,
    name,
    version: "1.0.0",
    entry: "plugin.js",
  };
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(dir, "plugin.js"), source);
  return {
    pluginPath: dir,
    manifest,
    entryPath: path.join(dir, "plugin.js"),
    status: "loaded",
  };
}

test("Phase 5 JSON parse/stringify works", async (t) => {
  const base = await temp(t);
  const p = await plugin(base, "json", `
    export const plugin = {
      run: (_, context) => {
        const value = context.json.parse('{"name":"Alice","items":[1,2,3]}');
        return {
          name: value.name,
          count: value.items.length,
          encoded: context.json.stringify(value)
        };
      }
    };
  `);

  const runtime = new PluginRuntime();
  t.after(() => runtime.shutdown());

  const loaded = await runtime.loadPlugin(p);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;

  const result = await runtime.execute(loaded.plugin, "run");
  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(result.value, {
      name: "Alice",
      count: 3,
      encoded: '{"name":"Alice","items":[1,2,3]}',
    });
  }
});

test("Phase 5 HTML selectors and extraction work", async (t) => {
  const base = await temp(t);
  const p = await plugin(base, "html", `
    export const plugin = {
      run: (_, context) => {
        const doc = context.html.parse(
          '<div id="root"><article class="card featured" data-id="42"><a href="/watch/1">  Movie One </a></article><article class="card"><a href="/watch/2">Movie Two</a></article></div>'
        );
        const cards = context.html.select(doc, '#root .card');
        const links = context.html.select(doc, 'article.card a[href]');
        return {
          cards: cards.map(context.html.extract),
          links: links.map(context.html.extract)
        };
      }
    };
  `);

  const runtime = new PluginRuntime();
  t.after(() => runtime.shutdown());

  const loaded = await runtime.loadPlugin(p);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;

  const result = await runtime.execute(loaded.plugin, "run");
  assert.equal(result.success, true);
  if (result.success) {
    const value = result.value as {
      cards: Array<{ text: string; id?: string; data: Record<string, string> }>;
      links: Array<{ href?: string; text: string }>;
    };
    assert.equal(value.cards.length, 2);
    assert.equal(value.cards[0].text, "Movie One");
    assert.equal(value.cards[0].id, undefined);
    assert.equal(value.cards[0].data.id, "42");
    assert.equal(value.links.length, 2);
    assert.equal(value.links[1].href, "/watch/2");
  }
});

test("HTML parser does not execute script contents", async (t) => {
  const base = await temp(t);
  const p = await plugin(base, "safehtml", `
    export const plugin = {
      run: (_, context) => {
        const doc = context.html.parse(
          '<script>throw new Error("MUST NOT RUN")</script><p>safe</p>'
        );
        return context.html.select(doc, 'p').map(context.html.extract);
      }
    };
  `);

  const runtime = new PluginRuntime();
  t.after(() => runtime.shutdown());

  const loaded = await runtime.loadPlugin(p);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;

  const result = await runtime.execute(loaded.plugin, "run");
  assert.equal(result.success, true);
  if (result.success) assert.equal((result.value as Array<{text: string}>)[0].text, "safe");
});

test("unsupported CSS selector is rejected", async (t) => {
  const base = await temp(t);
  const p = await plugin(base, "badselector", `
    export const plugin = {
      run: (_, context) => {
        const doc = context.html.parse('<p>one</p>');
        return context.html.select(doc, 'p:first-child');
      }
    };
  `);

  const runtime = new PluginRuntime();
  t.after(() => runtime.shutdown());

  const loaded = await runtime.loadPlugin(p);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;

  const result = await runtime.execute(loaded.plugin, "run");
  assert.equal(result.success, false);
});
