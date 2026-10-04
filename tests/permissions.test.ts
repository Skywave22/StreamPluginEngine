/**
 * v0.2.0 hardening: enforced manifest domains, per-plugin capability
 * permissions, engine-owned enable/disable, and plugin API versioning.
 *
 * These tests are deterministic and offline: hostnames resolve through an
 * injected resolver and every request that would leave the machine is
 * answered by a mocked `fetch`. No external host is contacted.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { PluginManager } from "../src/manager.js";
import { ENGINE_API_VERSION, validateManifest } from "../src/manifest.js";
import { PluginRuntime } from "../src/runtime.js";
import {
  checkDeclaredDomain,
  domainPatternMatches,
  isHostAllowed,
  isSubdomainOnlyPattern,
  normalizeDomainPattern,
} from "../src/network.js";
import type { LoadedPlugin, PluginRuntimeOptions } from "../src/types.js";

/** Every hostname in these tests resolves to a public address. */
const PUBLIC_RESOLVER = async (): Promise<string[]> => ["93.184.216.34"];

interface GuestFixture {
  runtime: PluginRuntime;
  loaded: LoadedPlugin;
  manager: PluginManager;
  pluginId: string;
}

/**
 * Write a plugin (manifest + entry), discover it, and load it into a
 * runtime. The caller supplies runtime options (resolver, permissions,
 * domain enforcement) and the plugin source.
 */
async function setup(
  t: TestContext,
  options: {
    source: string;
    manifest?: Record<string, unknown>;
    runtimeOptions?: PluginRuntimeOptions;
    dirName?: string;
  },
): Promise<GuestFixture> {
  const base = await mkdtemp(path.join(os.tmpdir(), "spe-perm-"));
  t.after(() => rm(base, { recursive: true, force: true }));

  const dirName = options.dirName ?? "permtest";
  const pluginId = `t.${dirName}`;
  const dir = path.join(base, dirName);
  await mkdir(dir, { recursive: true });
  const manifest = {
    id: pluginId,
    name: "Permission Fixture",
    version: "1.0.0",
    entry: "plugin.js",
    ...options.manifest,
  };
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  await writeFile(path.join(dir, "plugin.js"), options.source);

  const manager = new PluginManager();
  await manager.discoverPlugins(base);
  const discovered = manager.getPlugin(pluginId);
  assert.ok(discovered, "plugin must be discovered");

  const runtime = new PluginRuntime({
    ...options.runtimeOptions,
    // The injected resolver must survive caller-supplied http options,
    // otherwise these tests would fall back to real DNS.
    http: { resolver: PUBLIC_RESOLVER, ...options.runtimeOptions?.http },
  });
  t.after(() => runtime.shutdown());

  const load = await runtime.loadPlugin(discovered);
  assert.ok(load.ok, load.ok ? "" : `load failed: ${JSON.stringify(load.error)}`);
  return { runtime, loaded: load.plugin, manager, pluginId };
}

/** Run a capability and return the guest's value (asserting success). */
async function run(
  fixture: GuestFixture,
  capability: string,
  args: readonly unknown[] = [],
): Promise<unknown> {
  const result = await fixture.runtime.execute(
    fixture.loaded,
    capability,
    args,
  );
  assert.ok(
    result.success,
    result.success ? "" : `execute failed: ${JSON.stringify(result.error)}`,
  );
  return result.value;
}

/** Mock `fetch` globally; returns a call counter + captured URLs. */
function mockFetch(
  t: TestContext,
  handler: (url: string) => Response,
): { calls: string[] } {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  });
  return { calls };
}

/** A capability that reports the context surface it actually received. */
const SURFACE_SOURCE = `
export const plugin = {
  surface(context) {
    return {
      keys: Object.keys(context).sort(),
      hasHttp: typeof context.http,
      hasJson: typeof context.json,
      hasHtml: typeof context.html,
      httpKeys: context.http ? Object.keys(context.http).sort() : null,
      manifestId: context.manifest.id,
    };
  },
  parseOk(context) {
    const doc = context.html.parse("<div class='x'>hi</div>");
    const els = context.html.select(doc, ".x");
    return context.html.extract(els[0]).text;
  },
  jsonOk(context) {
    return context.json.parse('{"a":1}').a;
  },
};
`;

/** A capability that performs one GET and reports success or the error. */
const GET_SOURCE = `
export const plugin = {
  async get(url, context) {
    try {
      const res = await context.http.get(url, { timeoutMs: 3000 });
      return { ok: true, status: res.status, body: res.body };
    } catch (e) {
      return { ok: false, code: e && e.code, message: e && e.message };
    }
  },
};
`;

// ---------------------------------------------------------------------------
// Capability permissions
// ---------------------------------------------------------------------------

test("permissions: the default surface is unchanged (http + json + html)", async (t) => {
  const fixture = await setup(t, { source: SURFACE_SOURCE });
  const value = (await run(fixture, "surface")) as Record<string, unknown>;
  assert.deepEqual(value.keys, ["html", "http", "json", "log", "manifest"]);
  assert.deepEqual(value.httpKeys, ["get", "getJson", "request"]);
  assert.equal(value.hasHttp, "object");
  // Introspection: the engine records what it granted.
  assert.deepEqual(fixture.loaded.permissions, {
    http: true,
    json: true,
    html: true,
  });
});

test("permissions: http:false removes the network surface entirely", async (t) => {
  const fixture = await setup(t, {
    source: SURFACE_SOURCE,
    runtimeOptions: { permissions: { http: false } },
  });
  const value = (await run(fixture, "surface")) as Record<string, unknown>;
  // Not "a function that throws" — the capability is absent.
  assert.deepEqual(value.keys, ["html", "json", "log", "manifest"]);
  assert.equal(value.hasHttp, "undefined");
  assert.equal(value.httpKeys, null);
  // The other capabilities still work.
  assert.equal(await run(fixture, "parseOk"), "hi");
  assert.deepEqual(fixture.loaded.permissions, {
    http: false,
    json: true,
    html: true,
  });
});

test("permissions: json:false / html:false remove only that capability", async (t) => {
  const noJson = await setup(t, {
    source: SURFACE_SOURCE,
    runtimeOptions: { permissions: { json: false } },
    dirName: "nojson",
  });
  const noJsonValue = (await run(noJson, "surface")) as Record<string, unknown>;
  assert.deepEqual(noJsonValue.keys, ["html", "http", "log", "manifest"]);
  assert.equal(noJsonValue.hasJson, "undefined");
  assert.equal(await run(noJson, "parseOk"), "hi");

  const noHtml = await setup(t, {
    source: SURFACE_SOURCE,
    runtimeOptions: { permissions: { html: false } },
    dirName: "nohtml",
  });
  const noHtmlValue = (await run(noHtml, "surface")) as Record<string, unknown>;
  assert.deepEqual(noHtmlValue.keys, ["http", "json", "log", "manifest"]);
  assert.equal(noHtmlValue.hasHtml, "undefined");
  assert.equal(await run(noHtml, "jsonOk"), 1);
});

test("permissions: a per-plugin override wins over the runtime default", async (t) => {
  const fixture = await setup(t, {
    source: SURFACE_SOURCE,
    runtimeOptions: {
      permissions: { html: false },
      perPluginPermissions: { "t.permtest": { html: true, http: false } },
    },
  });
  const value = (await run(fixture, "surface")) as Record<string, unknown>;
  assert.deepEqual(value.keys, ["html", "json", "log", "manifest"]);
  assert.equal(value.hasHtml, "object");
  assert.equal(value.hasHttp, "undefined");
  assert.deepEqual(fixture.loaded.permissions, {
    http: false,
    json: true,
    html: true,
  });
});

// ---------------------------------------------------------------------------
// Declared-domain matching (pure host helpers)
// ---------------------------------------------------------------------------

test("domain patterns: normalization and matching semantics", () => {
  assert.equal(normalizeDomainPattern("Example.COM"), "example.com");
  assert.equal(normalizeDomainPattern("*.example.com"), "example.com");
  assert.equal(normalizeDomainPattern(".example.com"), "example.com");
  assert.equal(normalizeDomainPattern("example.com."), "example.com");
  assert.equal(normalizeDomainPattern("  example.com  "), "example.com");
  assert.equal(normalizeDomainPattern(""), null);
  assert.equal(normalizeDomainPattern("*.example.com/path"), null);
  assert.equal(normalizeDomainPattern("two words.example"), null);
  // IDN is canonicalised to punycode, exactly like a request URL host.
  assert.equal(normalizeDomainPattern("bücher.example"), "xn--bcher-kva.example");

  assert.equal(isSubdomainOnlyPattern("*.example.com"), true);
  assert.equal(isSubdomainOnlyPattern(".example.com"), true);
  assert.equal(isSubdomainOnlyPattern("example.com"), false);

  // A bare domain covers the apex and subdomains.
  assert.equal(domainPatternMatches("example.com", "example.com"), true);
  assert.equal(domainPatternMatches("cdn.example.com", "example.com"), true);
  assert.equal(domainPatternMatches("a.b.example.com", "example.com"), true);
  // Label-anchored: a suffix that is not a label boundary does NOT match.
  assert.equal(domainPatternMatches("evil-example.com", "example.com"), false);
  assert.equal(domainPatternMatches("example.com.evil.test", "example.com"), false);
  // Wildcards do not cover the apex.
  assert.equal(domainPatternMatches("cdn.example.com", "*.example.com"), true);
  assert.equal(domainPatternMatches("example.com", "*.example.com"), false);
  // Case- and trailing-dot-insensitive on the host side.
  assert.equal(domainPatternMatches("CDN.Example.com.", "example.com"), true);
  // An empty allowlist is "no restriction"; an unusable pattern fails closed.
  assert.equal(isHostAllowed("anything.test", []), true);
  assert.equal(isHostAllowed("anything.test", ["***"]), false);
});

test("domain policy helper: a disallowed host yields a structured decision", () => {
  const denied = checkDeclaredDomain(new URL("https://evil.test/x"), [
    "example.com",
  ]);
  assert.equal(denied.allowed, false);
  if (denied.allowed) throw new Error("unreachable");
  assert.equal(denied.code, "HTTP_DOMAIN_NOT_ALLOWED");
  assert.match(denied.message, /evil\.test/);
  assert.match(denied.message, /example\.com/);

  assert.deepEqual(
    checkDeclaredDomain(new URL("https://cdn.example.com/x"), ["example.com"]),
    { allowed: true },
  );
  // Empty allowlist: not restricted by this gate.
  assert.deepEqual(checkDeclaredDomain(new URL("https://x.test/"), []), {
    allowed: true,
  });
});

// ---------------------------------------------------------------------------
// Declared-domain enforcement through the guest HTTP capability
// ---------------------------------------------------------------------------

test("domains: a declared host is reachable, an undeclared host is not (no I/O)", async (t) => {
  const { calls } = mockFetch(
    t,
    () => new Response("allowed-body", { status: 200 }),
  );
  const fixture = await setup(t, {
    source: GET_SOURCE,
    manifest: { domains: ["allowed.example"] },
  });

  // Declared host: the request goes through.
  const good = (await run(fixture, "get", ["https://allowed.example/a"])) as Record<
    string,
    unknown
  >;
  assert.equal(good.ok, true);
  assert.equal(good.body, "allowed-body");
  assert.equal(calls.length, 1);

  // Subdomain of a declared domain: allowed.
  const sub = (await run(fixture, "get", ["https://cdn.allowed.example/b"])) as Record<
    string,
    unknown
  >;
  assert.equal(sub.ok, true);
  assert.equal(calls.length, 2);

  // Undeclared host: rejected BEFORE any I/O — fetch is not called.
  const bad = (await run(fixture, "get", ["https://evil.test/c"])) as Record<
    string,
    unknown
  >;
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "HTTP_DOMAIN_NOT_ALLOWED");
  assert.equal(calls.length, 2, "a blocked host must never be requested");

  // A suffix that is not a label boundary is not a match.
  const suffix = (await run(fixture, "get", [
    "https://allowed.example.evil.test/d",
  ])) as Record<string, unknown>;
  assert.equal(suffix.code, "HTTP_DOMAIN_NOT_ALLOWED");
  assert.equal(calls.length, 2);

  // Introspection: the enforced allowlist is visible host-side.
  assert.deepEqual(fixture.loaded.allowedDomains, ["allowed.example"]);
});

test("domains: matching is case-insensitive and wildcard patterns exclude the apex", async (t) => {
  const { calls } = mockFetch(t, () => new Response("ok", { status: 200 }));

  const caseFixture = await setup(t, {
    source: GET_SOURCE,
    manifest: { domains: ["Mixed.Example"] },
    dirName: "casetest",
  });
  const upper = (await run(caseFixture, "get", ["https://MIXED.example/"])) as Record<
    string,
    unknown
  >;
  assert.equal(upper.ok, true);
  assert.equal(calls.length, 1);

  const wildcard = await setup(t, {
    source: GET_SOURCE,
    manifest: { domains: ["*.only.example"] },
    dirName: "wildtest",
  });
  const sub = (await run(wildcard, "get", ["https://a.only.example/"])) as Record<
    string,
    unknown
  >;
  assert.equal(sub.ok, true);
  const apex = (await run(wildcard, "get", ["https://only.example/"])) as Record<
    string,
    unknown
  >;
  assert.equal(apex.ok, false);
  assert.equal(apex.code, "HTTP_DOMAIN_NOT_ALLOWED");
  assert.equal(calls.length, 2, "the wildcard apex must not reach the network");
});

test("domains: a redirect into an undeclared host is blocked before the second request", async (t) => {
  const { calls } = mockFetch(t, (url) => {
    if (url.includes("allowed.example")) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.test/landing" },
      });
    }
    return new Response("should-never-be-read", { status: 200 });
  });
  const fixture = await setup(t, {
    source: GET_SOURCE,
    manifest: { domains: ["allowed.example"] },
  });

  const result = (await run(fixture, "get", ["https://allowed.example/start"])) as Record<
    string,
    unknown
  >;
  assert.equal(result.ok, false);
  assert.equal(result.code, "HTTP_DOMAIN_NOT_ALLOWED");
  assert.equal(calls.length, 1, "the redirect target must never be requested");
});

test("domains: a plugin with no declared domains is unrestricted (backward compatible)", async (t) => {
  const { calls } = mockFetch(t, () => new Response("free", { status: 200 }));
  const fixture = await setup(t, { source: GET_SOURCE });
  const value = (await run(fixture, "get", ["https://anywhere.test/"])) as Record<
    string,
    unknown
  >;
  assert.equal(value.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(fixture.loaded.allowedDomains, []);
});

test("domains: enforcement is a host switch (enforceManifestDomains:false)", async (t) => {
  const { calls } = mockFetch(t, () => new Response("unrestricted", { status: 200 }));
  const fixture = await setup(t, {
    source: GET_SOURCE,
    manifest: { domains: ["allowed.example"] },
    runtimeOptions: { http: { enforceManifestDomains: false } },
  });
  const value = (await run(fixture, "get", ["https://other.test/"])) as Record<
    string,
    unknown
  >;
  assert.equal(value.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(fixture.loaded.allowedDomains, []);
});

test("domains: host-level extraAllowedDomains widen every plugin's allowlist", async (t) => {
  const { calls } = mockFetch(t, () => new Response("shared", { status: 200 }));

  // Declared domain + host extra: both reachable, a third host is not.
  const declared = await setup(t, {
    source: GET_SOURCE,
    manifest: { domains: ["mine.example"] },
    runtimeOptions: {
      http: { extraAllowedDomains: ["shared.example"] },
    },
    dirName: "shared",
  });
  assert.deepEqual(declared.loaded.allowedDomains, [
    "mine.example",
    "shared.example",
  ]);
  assert.equal(
    ((await run(declared, "get", ["https://shared.example/x"])) as { ok: boolean }).ok,
    true,
  );
  assert.equal(
    ((await run(declared, "get", ["https://mine.example/x"])) as { ok: boolean }).ok,
    true,
  );
  const third = (await run(declared, "get", ["https://third.test/x"])) as Record<
    string,
    unknown
  >;
  assert.equal(third.code, "HTTP_DOMAIN_NOT_ALLOWED");
  assert.equal(calls.length, 2);

  // No declared domains + host extra: the plugin is limited to the extra.
  const extraOnly = await setup(t, {
    source: GET_SOURCE,
    runtimeOptions: { http: { extraAllowedDomains: ["shared.example"] } },
    dirName: "extraonly",
  });
  assert.deepEqual(extraOnly.loaded.allowedDomains, ["shared.example"]);
  assert.equal(
    ((await run(extraOnly, "get", ["https://shared.example/y"])) as { ok: boolean }).ok,
    true,
  );
  const blocked = (await run(extraOnly, "get", ["https://random.test/y"])) as Record<
    string,
    unknown
  >;
  assert.equal(blocked.code, "HTTP_DOMAIN_NOT_ALLOWED");
  assert.equal(calls.length, 3);
});

// ---------------------------------------------------------------------------
// Engine-owned enable/disable
// ---------------------------------------------------------------------------

const TRIVIAL_SOURCE = `
export const plugin = {
  ping() {
    return "pong";
  },
};
`;

test("enable/disable: a disabled plugin is not loaded at all", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "spe-enable-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = path.join(base, "toggle");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id: "t.toggle",
      name: "Toggle",
      version: "1.0.0",
      entry: "plugin.js",
    }),
  );
  await writeFile(path.join(dir, "plugin.js"), TRIVIAL_SOURCE);

  const manager = new PluginManager();
  await manager.discoverPlugins(base);
  const runtime = new PluginRuntime();
  t.after(() => runtime.shutdown());

  // Enabled by default.
  const plugin = manager.getPlugin("t.toggle");
  assert.ok(plugin);
  assert.equal(plugin.enabled, true);
  assert.equal(manager.isEnabled("t.toggle"), true);

  // Disable → the engine refuses to evaluate the plugin.
  assert.equal(manager.disable("t.toggle"), true);
  assert.equal(manager.isEnabled("t.toggle"), false);
  assert.deepEqual(manager.listDisabledIds(), ["t.toggle"]);
  const blocked = await runtime.loadPlugin(plugin);
  assert.equal(blocked.ok, false);
  assert.ok(!blocked.ok);
  assert.equal(blocked.error.type, "PLUGIN_DISABLED");

  // Re-enable → the normal load path works again.
  assert.equal(manager.enable("t.toggle"), true);
  const allowed = await runtime.loadPlugin(plugin);
  assert.ok(allowed.ok, allowed.ok ? "" : JSON.stringify(allowed.error));
  assert.equal(await run(
    { runtime, loaded: allowed.plugin, manager, pluginId: "t.toggle" },
    "ping",
  ), "pong");

  // Unknown IDs and unregister behaviour.
  assert.equal(manager.setEnabled("t.missing", false), false);
  assert.equal(manager.isEnabled("t.missing"), false);
  assert.equal(manager.unregister("t.toggle"), true);
  assert.deepEqual(manager.listDisabledIds(), []);
});

test("enable/disable: state survives rediscovery", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "spe-enable2-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = path.join(base, "keeper");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id: "t.keeper",
      name: "Keeper",
      version: "1.0.0",
      entry: "plugin.js",
    }),
  );
  await writeFile(path.join(dir, "plugin.js"), TRIVIAL_SOURCE);

  const manager = new PluginManager();
  await manager.discoverPlugins(base);
  manager.disable("t.keeper");
  await manager.discoverPlugins(base);

  const rediscovered = manager.getPlugin("t.keeper");
  assert.ok(rediscovered);
  assert.equal(rediscovered.enabled, false, "the registry owns the state");
  assert.equal(manager.getProblems().length, 0);
});

// ---------------------------------------------------------------------------
// Plugin API versioning
// ---------------------------------------------------------------------------

test("apiVersion: validated against the engine's implemented version", () => {
  const base = {
    id: "t.api",
    name: "API",
    version: "1.0.0",
    entry: "plugin.js",
  };
  assert.equal(ENGINE_API_VERSION, 1);

  // Absent → accepted, and not injected into the manifest.
  const absent = validateManifest({ ...base });
  assert.ok(absent.ok);
  assert.equal(absent.manifest.apiVersion, undefined);

  // Explicitly 1 → accepted and preserved.
  const one = validateManifest({ ...base, apiVersion: 1 });
  assert.ok(one.ok);
  assert.equal(one.manifest.apiVersion, 1);

  // A newer version than the engine implements → rejected loudly.
  const future = validateManifest({ ...base, apiVersion: 2 });
  assert.equal(future.ok, false);
  assert.ok(!future.ok);
  assert.match(future.errors.join("\n"), /apiVersion.*not supported/i);

  // Malformed values are rejected.
  for (const apiVersion of ["1", 0, -1, 1.5, null, true]) {
    const bad = validateManifest({ ...base, apiVersion });
    assert.equal(bad.ok, false, `apiVersion ${JSON.stringify(apiVersion)} must be rejected`);
  }
});
