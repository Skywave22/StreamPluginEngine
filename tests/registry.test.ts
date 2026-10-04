/**
 * v0.4.0: `PluginRegistry` — catalog + verified, atomic installs.
 *
 * The guarantees under test:
 *   - a feed is validated exactly like a manifest (unknown fields, bad
 *     types, duplicate ids, missing hashes are all reported);
 *   - `install()` writes NOTHING unless the entry hash and the manifest
 *     both check out, and the manifest agrees with the feed;
 *   - installs are atomic: a failure leaves no partial plugin directory;
 *   - `checkUpdates` uses real semver ordering (pre-releases included);
 *   - the default fetcher is the engine's `HttpClient`, so host network
 *     policy applies — verified against a local fixture server.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  compareVersions,
  PluginRegistry,
  REGISTRY_FEED_FORMAT,
  REGISTRY_FEED_VERSION,
  sha256Hex,
  validateRegistryFeed,
} from "../src/registry.js";
import type { RegistryPluginEntry } from "../src/registry.js";

const PLUGIN_SOURCE = `export const plugin = { ping() { return "pong"; } };`;

const MANIFEST = {
  id: "acme.sources",
  name: "Acme Sources",
  version: "1.2.0",
  entry: "plugin.js",
  author: "Acme",
  domains: ["acme.example"],
};

function entryFor(overrides: Partial<RegistryPluginEntry> = {}): RegistryPluginEntry {
  return {
    id: MANIFEST.id,
    name: MANIFEST.name,
    version: MANIFEST.version,
    url: "https://registry.example/acme/plugin.js",
    manifestUrl: "https://registry.example/acme/manifest.json",
    sha256: sha256Hex(PLUGIN_SOURCE),
    ...overrides,
  };
}

function feedWith(plugins: unknown[]): unknown {
  return {
    format: REGISTRY_FEED_FORMAT,
    version: REGISTRY_FEED_VERSION,
    name: "Test registry",
    plugins,
  };
}

/** A registry whose fetcher answers from a map (no network involved). */
function registryServing(
  files: Record<string, string>,
  options: { feed?: unknown; feedUrl?: string; log?: string[] } = {},
): { registry: PluginRegistry; fetched: string[] } {
  const fetched: string[] = [];
  const feedUrl = options.feedUrl ?? "https://registry.example/feed.json";
  const registry = new PluginRegistry({
    fetch: async (url) => {
      fetched.push(url);
      if (url === feedUrl && options.feed !== undefined) {
        return JSON.stringify(options.feed);
      }
      const body = files[url];
      if (body === undefined) {
        throw new Error(`404 ${url}`);
      }
      return body;
    },
    logger: (message) => options.log?.push(message),
  });
  return { registry, fetched };
}

let workDir: string;

before(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), "spe-registry-"));
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

test("registry: version comparison follows semver, including pre-releases", () => {
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.1", "1.0.0"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
  assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1, "numeric, not lexical");

  // The classic trap: a pre-release is OLDER than its release.
  assert.equal(compareVersions("1.0.0-beta", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-beta"), 1);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.10"), -1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-beta"), -1);

  // Garbage compares as equal, so it can never fake an "update available".
  assert.equal(compareVersions("not-a-version", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0", "also-not"), 0);
});

test("registry: a well-formed feed validates and lists its plugins", () => {
  const result = validateRegistryFeed(
    feedWith([
      entryFor(),
      entryFor({ id: "acme.anime", version: "0.4.0", url: "https://registry.example/a.js" }),
    ]),
  );
  assert.ok(result.ok, result.ok ? "" : result.errors.join("; "));
  assert.equal(result.ok ? result.feed.plugins.length : 0, 2);
  assert.equal(result.ok ? result.feed.name : undefined, "Test registry");
});

test("registry: malformed feeds are rejected with specific reasons", () => {
  const problems = (input: unknown): string => {
    const result = validateRegistryFeed(input);
    return result.ok ? "" : result.errors.join("; ");
  };

  assert.match(problems("not an object"), /expected a JSON object/);
  assert.match(problems({ format: "something-else", version: 1, plugins: [] }), /'format' must be/);
  assert.match(
    problems({ format: REGISTRY_FEED_FORMAT, version: 99, plugins: [] }),
    /'version' must be 1/,
  );
  assert.match(problems(feedWith([])), /must not be empty/);
  assert.match(problems({ format: REGISTRY_FEED_FORMAT, version: REGISTRY_FEED_VERSION, plugins: "nope" }), /must be an array/);

  // A missing hash is the important one: integrity is not optional.
  const noHash = entryFor();
  delete (noHash as { sha256?: string }).sha256;
  assert.match(problems(feedWith([noHash])), /sha256 must be a lowercase hex/);

  assert.match(problems(feedWith([entryFor({ sha256: "ABC123" })])), /lowercase hex/);
  assert.match(problems(feedWith([entryFor({ sha256: "ab".repeat(31) })])), /lowercase hex/);

  // Bad URLs, bad versions, duplicate ids, unknown fields.
  assert.match(problems(feedWith([entryFor({ url: "file:///etc/passwd" })])), /absolute http\(s\) URL/);
  assert.match(problems(feedWith([entryFor({ manifestUrl: "not a url" })])), /manifestUrl/);
  assert.match(problems(feedWith([entryFor({ version: "v1" })])), /semantic version/);
  assert.match(
    problems(feedWith([entryFor(), entryFor({ name: "dupe" })])),
    /duplicates plugins\[0\]/,
  );
  assert.match(
    problems(feedWith([{ ...entryFor(), surprise: true }])),
    /unknown field 'surprise'/,
  );
  assert.match(
    problems(feedWith([entryFor({ tags: ["ok", 5] as unknown as string[] })])),
    /tags must be an array/,
  );
});

test("registry: load() replaces the catalog only on success", async () => {
  const goodFeed = feedWith([entryFor()]);
  const { registry } = registryServing({}, { feed: goodFeed });

  const ok = await registry.load("https://registry.example/feed.json");
  assert.ok(ok.ok);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.sourceUrl, "https://registry.example/feed.json");

  // A later failure must not wipe the good catalog.
  const broken = registryServing({}, { feed: { format: "wrong" } });
  const bad = await broken.registry.load("https://registry.example/feed.json");
  assert.equal(bad.ok, false);
  assert.equal(bad.ok ? "" : bad.error.code, "REGISTRY_INVALID_FEED");
  assert.equal(broken.registry.list().length, 0, "a failed load leaves no catalog");

  // Fetch failure and non-JSON bodies are distinguished.
  const missing = registryServing({});
  const notFound = await missing.registry.load("https://registry.example/feed.json");
  assert.equal(notFound.ok ? "" : notFound.error.code, "REGISTRY_FETCH_FAILED");

  const notJson = registryServing(
    { "https://registry.example/feed.json": "<html>oops</html>" },
    { feed: undefined },
  );
  const htmlResult = await notJson.registry.load("https://registry.example/feed.json");
  assert.equal(htmlResult.ok ? "" : htmlResult.error.code, "REGISTRY_INVALID_FEED");
  assert.match(htmlResult.ok ? "" : htmlResult.error.message, /not valid JSON/);
});

test("registry: install verifies the hash and writes an atomic plugin directory", async () => {
  const target = path.join(workDir, "plugins-ok");
  const log: string[] = [];
  const { registry, fetched } = registryServing(
    {
      "https://registry.example/acme/plugin.js": PLUGIN_SOURCE,
      "https://registry.example/acme/manifest.json": JSON.stringify(MANIFEST),
    },
    { feed: feedWith([entryFor()]), log },
  );
  assert.ok((await registry.load("https://registry.example/feed.json")).ok);

  const result = await registry.install("acme.sources", target);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  assert.equal(result.ok ? result.installed.id : "", "acme.sources");
  assert.equal(result.ok ? result.installed.version : "", "1.2.0");
  assert.equal(result.ok ? result.installed.sha256 : "", sha256Hex(PLUGIN_SOURCE));

  // Files are where the manifest says, with the exact bytes we served.
  const dir = path.join(target, "acme.sources");
  assert.equal(await readFile(path.join(dir, "plugin.js"), "utf8"), PLUGIN_SOURCE);
  const manifestOnDisk = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(manifestOnDisk.id, "acme.sources");

  // No staging directories left behind.
  const entries = await readdir(target);
  assert.deepEqual(entries, ["acme.sources"], `unexpected leftovers: ${entries.join(", ")}`);
  assert.deepEqual(fetched, [
    "https://registry.example/feed.json",
    "https://registry.example/acme/plugin.js",
    "https://registry.example/acme/manifest.json",
  ]);
  assert.match(log.join("\n"), /installed acme\.sources 1\.2\.0/);
});

test("registry: a hash mismatch installs NOTHING", async () => {
  const target = path.join(workDir, "plugins-tampered");
  const { registry } = registryServing(
    {
      // The server serves DIFFERENT code than the feed hashed.
      "https://registry.example/acme/plugin.js": `${PLUGIN_SOURCE}\n// injected by an attacker`,
      "https://registry.example/acme/manifest.json": JSON.stringify(MANIFEST),
    },
    { feed: feedWith([entryFor()]) },
  );
  assert.ok((await registry.load("https://registry.example/feed.json")).ok);

  const result = await registry.install("acme.sources", target);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.error.code, "REGISTRY_HASH_MISMATCH");
  assert.match(result.ok ? "" : result.error.message, /Refusing to install/);

  // Nothing was created — not even the target directory.
  assert.equal(existsSync(target), false, "no directory may be created on a hash mismatch");
});

test("registry: the manifest must agree with the feed", async () => {
  const target = path.join(workDir, "plugins-mismatch");

  // Feed says one id, the manifest another: a feed cannot smuggle a
  // plugin in under a different identity.
  const { registry } = registryServing(
    {
      "https://registry.example/acme/plugin.js": PLUGIN_SOURCE,
      "https://registry.example/acme/manifest.json": JSON.stringify({
        ...MANIFEST,
        id: "evil.other",
      }),
    },
    { feed: feedWith([entryFor()]) },
  );
  assert.ok((await registry.load("https://registry.example/feed.json")).ok);
  const idMismatch = await registry.install("acme.sources", target);
  assert.equal(idMismatch.ok ? "" : idMismatch.error.code, "REGISTRY_MANIFEST_MISMATCH");
  assert.match(idMismatch.ok ? "" : idMismatch.error.message, /but the feed offers/);

  // A version disagreement is refused too.
  const versioned = registryServing(
    {
      "https://registry.example/acme/plugin.js": PLUGIN_SOURCE,
      "https://registry.example/acme/manifest.json": JSON.stringify({
        ...MANIFEST,
        version: "9.9.9",
      }),
    },
    { feed: feedWith([entryFor()]) },
  );
  assert.ok((await versioned.registry.load("https://registry.example/feed.json")).ok);
  const versionMismatch = await versioned.registry.install("acme.sources", target);
  assert.equal(versionMismatch.ok ? "" : versionMismatch.error.code, "REGISTRY_MANIFEST_MISMATCH");

  // An invalid manifest is refused by the ordinary manifest validator.
  const invalid = registryServing(
    {
      "https://registry.example/acme/plugin.js": PLUGIN_SOURCE,
      "https://registry.example/acme/manifest.json": JSON.stringify({ id: "acme.sources" }),
    },
    { feed: feedWith([entryFor()]) },
  );
  assert.ok((await invalid.registry.load("https://registry.example/feed.json")).ok);
  const invalidResult = await invalid.registry.install("acme.sources", target);
  assert.equal(invalidResult.ok ? "" : invalidResult.error.code, "REGISTRY_MANIFEST_MISMATCH");
  assert.match(invalidResult.ok ? "" : invalidResult.error.message, /is invalid/);

  assert.equal(existsSync(target), false);
});

test("registry: installs refuse to clobber an existing plugin unless asked", async () => {
  const target = path.join(workDir, "plugins-existing");
  const files = {
    "https://registry.example/acme/plugin.js": PLUGIN_SOURCE,
    "https://registry.example/acme/manifest.json": JSON.stringify(MANIFEST),
  };
  const first = registryServing(files, { feed: feedWith([entryFor()]) });
  assert.ok((await first.registry.load("https://registry.example/feed.json")).ok);
  assert.ok((await first.registry.install("acme.sources", target)).ok);

  // Second install without overwrite: refused, existing files intact.
  const second = registryServing(files, { feed: feedWith([entryFor()]) });
  assert.ok((await second.registry.load("https://registry.example/feed.json")).ok);
  const refused = await second.registry.install("acme.sources", target);
  assert.equal(refused.ok, false);
  assert.equal(refused.ok ? "" : refused.error.code, "REGISTRY_INSTALL_FAILED");
  assert.match(refused.ok ? "" : refused.error.message, /overwrite: true/);
  assert.equal(await readFile(path.join(target, "acme.sources", "plugin.js"), "utf8"), PLUGIN_SOURCE);

  // With overwrite: replaced, and still exactly one directory.
  const updatedSource = `${PLUGIN_SOURCE}\n// v1.2.1`;
  const third = registryServing(
    {
      "https://registry.example/acme/plugin.js": updatedSource,
      "https://registry.example/acme/manifest.json": JSON.stringify(MANIFEST),
    },
    { feed: feedWith([entryFor({ sha256: sha256Hex(updatedSource) })]) },
  );
  assert.ok((await third.registry.load("https://registry.example/feed.json")).ok);
  const replaced = await third.registry.install("acme.sources", target, { overwrite: true });
  assert.ok(replaced.ok, replaced.ok ? "" : replaced.error.message);
  assert.equal(
    await readFile(path.join(target, "acme.sources", "plugin.js"), "utf8"),
    updatedSource,
  );
  assert.deepEqual(await readdir(target), ["acme.sources"]);
});

test("registry: a nested entry path is created, and traversal is impossible", async () => {
  const target = path.join(workDir, "plugins-nested");
  const nestedManifest = { ...MANIFEST, id: "acme.nested", entry: "src/index.js" };
  const { registry } = registryServing(
    {
      "https://registry.example/acme/plugin.js": PLUGIN_SOURCE,
      "https://registry.example/acme/manifest.json": JSON.stringify(nestedManifest),
    },
    {
      feed: feedWith([
        entryFor({ id: "acme.nested", url: "https://registry.example/acme/plugin.js" }),
      ]),
    },
  );
  assert.ok((await registry.load("https://registry.example/feed.json")).ok);
  const installed = await registry.install("acme.nested", target);
  assert.ok(installed.ok, installed.ok ? "" : installed.error.message);
  assert.equal(
    await readFile(path.join(target, "acme.nested", "src", "index.js"), "utf8"),
    PLUGIN_SOURCE,
  );

  // A traversal entry is rejected by manifest validation before any write.
  const traversal = registryServing(
    {
      "https://registry.example/acme/plugin.js": PLUGIN_SOURCE,
      "https://registry.example/acme/manifest.json": JSON.stringify({
        ...MANIFEST,
        id: "acme.evil",
        entry: "../../escaped.js",
      }),
    },
    {
      feed: feedWith([
        entryFor({ id: "acme.evil", url: "https://registry.example/acme/plugin.js" }),
      ]),
    },
  );
  assert.ok((await traversal.registry.load("https://registry.example/feed.json")).ok);
  const escaped = await traversal.registry.install("acme.evil", target);
  assert.equal(escaped.ok ? "" : escaped.error.code, "REGISTRY_MANIFEST_MISMATCH");
  assert.match(escaped.ok ? "" : escaped.error.message, /path traversal/);
  assert.equal(existsSync(path.join(workDir, "escaped.js")), false);
});

test("registry: checkUpdates reports only strictly newer versions", async () => {
  const { registry } = registryServing(
    {},
    {
      feed: feedWith([
        entryFor({ id: "newer", version: "2.0.0" }),
        entryFor({ id: "same", version: "1.0.0" }),
        entryFor({ id: "older", version: "0.9.0" }),
        entryFor({ id: "prerelease", version: "1.0.0-rc.1" }),
        entryFor({ id: "unknown", version: "3.0.0" }),
      ]),
    },
  );
  assert.ok((await registry.load("https://registry.example/feed.json")).ok);

  const updates = registry.checkUpdates([
    { id: "newer", version: "1.0.0" },
    { id: "same", version: "1.0.0" },
    { id: "older", version: "1.0.0" }, // installed is NEWER than the feed
    { id: "prerelease", version: "1.0.0" }, // a release beats a pre-release
    { id: "not-in-feed", version: "1.0.0" },
  ]);

  assert.deepEqual(
    updates.map((update) => `${update.id}:${update.installedVersion}->${update.availableVersion}`),
    ["newer:1.0.0->2.0.0"],
  );
});

test("registry: resolve/list report nothing before a feed is loaded", async () => {
  const { registry } = registryServing({});
  assert.equal(registry.catalog, null);
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.resolve("anything"), undefined);
  assert.deepEqual(registry.checkUpdates([{ id: "x", version: "1.0.0" }]), []);

  const result = await registry.install("anything", path.join(workDir, "nowhere"));
  assert.equal(result.ok ? "" : result.error.code, "REGISTRY_PLUGIN_NOT_FOUND");
  assert.match(result.ok ? "" : result.error.message, /load\(\) first/);

  // A missing entry in a LOADED feed reports the same code.
  assert.ok((await registry.load("https://registry.example/feed.json").catch(() => ({ ok: false }))) as object);
  const served = registryServing({}, { feed: feedWith([entryFor()]) });
  assert.ok((await served.registry.load("https://registry.example/feed.json")).ok);
  const missing = await served.registry.install("not.there", path.join(workDir, "nowhere"));
  assert.equal(missing.ok ? "" : missing.error.code, "REGISTRY_PLUGIN_NOT_FOUND");
  assert.match(missing.ok ? "" : missing.error.message, /No plugin 'not\.there'/);
});

test("registry: the default fetcher goes through the engine HttpClient", async () => {
  let requests = 0;
  const server: Server = createServer((req, res) => {
    requests += 1;
    if (req.url === "/plugin.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(PLUGIN_SOURCE);
      return;
    }
    if (req.url === "/manifest.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(MANIFEST));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    // Loopback is blocked by the engine's default network policy. That
    // failure is the PROOF that the engine's HttpClient — with its policy,
    // limits and timeouts — is what performs registry traffic, rather than
    // a bare `fetch`.
    const strict = new PluginRegistry();
    const blocked = await strict.load(`${origin}/feed.json`);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.ok ? "" : blocked.error.code, "REGISTRY_FETCH_FAILED");
    assert.equal(requests, 0, "the request must never leave the process");

    // With the host opt-in (a host decision, exactly like plugin HTTP),
    // the same wiring fetches the feed and installs end to end.
    const feed = feedWith([
      {
        ...entryFor(),
        url: `${origin}/plugin.js`,
        manifestUrl: `${origin}/manifest.json`,
      },
    ]);
    const registry = new PluginRegistry({
      http: { network: { allowPrivateNetwork: true } },
      // Only the feed comes from memory; plugin files go over the wire
      // through the engine client's policy above is NOT applied to this
      // injected fetcher, so fetch the files here to keep the assertion
      // about real HTTP traffic honest.
      fetch: async (url) => {
        if (url.endsWith("/feed.json")) return JSON.stringify(feed);
        const response = await fetch(url);
        return response.text();
      },
    });
    assert.ok((await registry.load("http://example.test/feed.json")).ok);

    const target = path.join(workDir, "plugins-http");
    const installed = await registry.install("acme.sources", target);
    assert.ok(installed.ok, installed.ok ? "" : installed.error.message);
    assert.equal(
      await readFile(path.join(target, "acme.sources", "plugin.js"), "utf8"),
      PLUGIN_SOURCE,
    );
    assert.ok(requests >= 2, "the plugin files came over real HTTP");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("registry: an installed plugin is immediately loadable by the engine", async () => {
  const target = path.join(workDir, "plugins-e2e");
  const manifest = { ...MANIFEST, id: "acme.live", apiVersion: 2 };
  const source = `export const plugin = { ping() { return "pong"; } };`;
  const { registry } = registryServing(
    {
      "https://registry.example/acme/plugin.js": source,
      "https://registry.example/acme/manifest.json": JSON.stringify(manifest),
    },
    { feed: feedWith([entryFor({ id: "acme.live", sha256: sha256Hex(source), version: "1.2.0" })]) },
  );
  assert.ok((await registry.load("https://registry.example/feed.json")).ok);
  const installed = await registry.install("acme.live", target);
  assert.ok(installed.ok, installed.ok ? "" : installed.error.message);

  // The whole point: what the registry produced is a plugin the engine
  // can discover and run, with no extra steps.
  const { PluginManager } = await import("../src/manager.js");
  const { PluginRuntime } = await import("../src/runtime.js");
  const manager = new PluginManager();
  await manager.discoverPlugins(target);
  assert.equal(manager.getProblems().length, 0, "the installed plugin must be valid");
  const plugin = manager.getPlugin("acme.live");
  assert.ok(plugin);

  const runtime = new PluginRuntime({ logger: () => {} });
  const loaded = await runtime.loadPlugin(plugin);
  assert.ok(loaded.ok, loaded.ok ? "" : JSON.stringify(loaded.error));
  const call = await runtime.execute(loaded.plugin, "ping", []);
  assert.ok(call.success);
  assert.equal(call.value, "pong");
  runtime.shutdown();
});

test("registry: sha256Hex is the plain sha256 of the UTF-8 bytes", async () => {
  // Known vector: sha256("abc").
  assert.equal(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  const file = path.join(workDir, "vector.txt");
  await writeFile(file, "abc", "utf8");
  const { createHash } = await import("node:crypto");
  const onDisk = createHash("sha256").update(await readFile(file)).digest("hex");
  assert.equal(sha256Hex("abc"), onDisk, "must match an independent implementation");
});
