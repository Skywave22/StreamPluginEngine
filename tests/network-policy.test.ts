/**
 * Phase 7 — engine network policy: SSRF regression suite.
 *
 * Why this file exists
 * --------------------
 * The Phase 1–6 audit found that `context.http` validated the URL SCHEME
 * (http/https only) but never validated the request TARGET. A plugin
 * could therefore reach loopback services, RFC 1918 hosts, and —
 * reproducibly — cloud metadata endpoints such as
 * `http://169.254.169.254/latest/meta-data/`, which on AWS/GCP/Azure
 * hand out temporary instance credentials. Obfuscated IPv4 literals
 * (decimal / hex / octal) were also passed straight through to fetch.
 *
 * This suite locks the fixed behaviour down so it cannot silently
 * regress.
 *
 * Determinism
 * -----------
 * Fully offline. IP-literal checks happen BEFORE any I/O, so asserting a
 * rejection performs no network access. Hostname checks use an INJECTED
 * resolver (never real DNS), and the redirect-hop test mocks `fetch`
 * so no external host is contacted.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";

import { HttpClient, HttpError } from "../src/http.js";
import { PluginRuntime } from "../src/runtime.js";
import {
  DEFAULT_NETWORK_POLICY,
  checkRequestTarget,
  classifyAddress,
  hostFromUrl,
  isAddressAllowed,
} from "../src/network.js";
import type { AddressResolver } from "../src/network.js";
import type { Plugin } from "../src/types.js";

// ---------------------------------------------------------------------------
// Address classification (pure — the policy's source of truth)
// ---------------------------------------------------------------------------

test("network policy: the default is public-internet-only", () => {
  assert.deepEqual(DEFAULT_NETWORK_POLICY, { allowPrivateNetwork: false });
});

test("network policy: loopback addresses are classified and blocked", () => {
  for (const ip of ["127.0.0.1", "127.0.0.2", "127.255.255.254"]) {
    assert.equal(classifyAddress(ip), "loopback", ip);
    assert.equal(isAddressAllowed(ip), false, ip);
  }
  assert.equal(classifyAddress("::1"), "loopback");
  assert.equal(isAddressAllowed("::1"), false);
});

test("network policy: RFC 1918 and CGNAT private ranges are blocked", () => {
  const cases: readonly (readonly [ip: string, expected: string])[] = [
    ["10.0.0.1", "private"],
    ["10.255.255.255", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.0.1", "private"],
    ["192.168.255.255", "private"],
    ["100.64.0.1", "reserved"], // RFC 6598 CGNAT
    ["fc00::1", "private"], // IPv6 unique local
    ["fd12:3456::1", "private"],
  ];
  for (const [ip, expected] of cases) {
    assert.equal(classifyAddress(ip), expected, ip);
    assert.equal(isAddressAllowed(ip), false, ip);
  }
});

test("network policy: 172.15.x / 172.32.x are NOT private (no over-blocking)", () => {
  // Guards against an over-broad prefix that would break legitimate
  // public hosts adjacent to RFC 1918 space.
  for (const ip of ["172.15.255.255", "172.32.0.0"]) {
    assert.equal(classifyAddress(ip), "public", ip);
    assert.equal(isAddressAllowed(ip), true, ip);
  }
});

test("network policy: cloud metadata endpoints are blocked", () => {
  // The address class that made this a real vulnerability, plus the
  // documented cloud-provider metadata hosts.
  const metadata = [
    "169.254.169.254", // AWS / GCP / Azure IMDS
    "169.254.170.2", // AWS ECS task credentials
    "169.254.0.1",
    "fd00:ec2::254", // AWS IPv6 IMDS (inside fc00::/7)
  ];
  for (const ip of metadata) {
    assert.equal(isAddressAllowed(ip), false, `${ip} must be blocked`);
  }
  assert.equal(classifyAddress("169.254.169.254"), "link-local");
  assert.equal(isAddressAllowed("fe80::1"), false);
  assert.equal(classifyAddress("fe80::1"), "link-local");
});

test("network policy: IPv4-mapped IPv6 cannot smuggle a blocked address", () => {
  // BlockList matches IPv4 rules against mapped IPv6 forms.
  for (const ip of [
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::ffff:10.0.0.1",
    "::ffff:192.168.1.1",
  ]) {
    assert.equal(isAddressAllowed(ip), false, `${ip} must be blocked`);
  }
  // A mapped PUBLIC address stays allowed.
  assert.equal(isAddressAllowed("::ffff:8.8.8.8"), true);
});

test("network policy: tunnel prefixes that embed IPv4 are blocked", () => {
  for (const ip of [
    "2002:7f00:1::1", // 6to4 → 127.0.0.1
    "64:ff9b::7f00:1", // NAT64 → 127.0.0.1
    "2001:0000:4136:e378:8000:63bf:3fff:fdd2", // Teredo
  ]) {
    assert.equal(isAddressAllowed(ip), false, `${ip} must be blocked`);
  }
});

test("network policy: reserved, multicast, and broadcast ranges are blocked", () => {
  const cases: readonly (readonly [ip: string, expected: string])[] = [
    ["0.0.0.0", "reserved"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "reserved"],
    ["224.0.0.1", "multicast"],
    ["ff02::1", "multicast"],
    ["::", "reserved"],
    ["198.18.0.1", "reserved"],
    ["2001:db8::1", "reserved"],
    ["100::1", "reserved"],
  ];
  for (const [ip, expected] of cases) {
    assert.equal(classifyAddress(ip), expected, ip);
    assert.equal(isAddressAllowed(ip), false, ip);
  }
});

test("network policy: ordinary public addresses remain allowed", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]) {
    assert.equal(classifyAddress(ip), "public", ip);
    assert.equal(isAddressAllowed(ip), true, ip);
  }
});

test("network policy: non-IP strings are not addresses", () => {
  assert.equal(classifyAddress("example.com"), null);
  assert.equal(classifyAddress(""), null);
  assert.equal(classifyAddress("not-an-ip"), null);
  assert.equal(isAddressAllowed("example.com"), false);
});

test("network policy: hostFromUrl strips IPv6 brackets", () => {
  assert.equal(hostFromUrl(new URL("http://[::1]:8080/x")), "::1");
  assert.equal(hostFromUrl(new URL("http://127.0.0.1/x")), "127.0.0.1");
  assert.equal(hostFromUrl(new URL("http://example.com/x")), "example.com");
});

// ---------------------------------------------------------------------------
// checkRequestTarget — hostname resolution (injected, deterministic)
// ---------------------------------------------------------------------------

const resolverOf = (map: Record<string, string[]>): AddressResolver => {
  return async (hostname) => {
    const found = map[hostname];
    if (found === undefined) {
      throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    }
    return found;
  };
};

test("checkRequestTarget: allows everything when the host opts in", async () => {
  const policy = { allowPrivateNetwork: true };
  for (const url of [
    "http://127.0.0.1:8080/x",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost/x",
    "http://10.0.0.5/internal",
  ]) {
    const decision = await checkRequestTarget(new URL(url), policy);
    assert.equal(decision.allowed, true, url);
  }
});

test("checkRequestTarget: blocks IP literals under the default policy", async () => {
  const policy = DEFAULT_NETWORK_POLICY;
  for (const url of [
    "http://127.0.0.1/x",
    "http://[::1]/x",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.1.2.3/x",
    "http://192.168.0.1/admin",
    "http://0.0.0.0/x",
  ]) {
    const decision = await checkRequestTarget(new URL(url), policy);
    assert.equal(decision.allowed, false, url);
    assert.ok(!decision.allowed);
    assert.equal(decision.code, "HTTP_FORBIDDEN_TARGET");
  }
});

test("checkRequestTarget: blocks 'localhost' without a DNS round-trip", async () => {
  let called = 0;
  const resolver: AddressResolver = async () => {
    called += 1;
    return ["93.184.216.34"];
  };
  for (const url of ["http://localhost/x", "http://LOCALHOST/x", "http://sub.localhost/x"]) {
    const decision = await checkRequestTarget(new URL(url), DEFAULT_NETWORK_POLICY, resolver);
    assert.equal(decision.allowed, false, url);
    assert.ok(!decision.allowed);
    assert.equal(decision.code, "HTTP_FORBIDDEN_TARGET");
  }
  assert.equal(called, 0, "localhost must not need DNS");
});

test("checkRequestTarget: blocks a hostname that resolves to a private address", async () => {
  const resolver = resolverOf({
    "internal.example": ["10.0.0.7"],
    "rebind.example": ["192.168.1.1"],
    "meta.example": ["169.254.169.254"],
  });
  for (const host of ["internal.example", "rebind.example", "meta.example"]) {
    const decision = await checkRequestTarget(
      new URL(`http://${host}/`),
      DEFAULT_NETWORK_POLICY,
      resolver,
    );
    assert.equal(decision.allowed, false, host);
    assert.ok(!decision.allowed);
    assert.equal(decision.code, "HTTP_FORBIDDEN_TARGET");
    assert.match(decision.message, /resolves to a (private|link-local) address/);
  }
});

test("checkRequestTarget: blocks a mixed public+private resolution (no partial allow)", async () => {
  const resolver = resolverOf({ "mixed.example": ["93.184.216.34", "127.0.0.1"] });
  const decision = await checkRequestTarget(
    new URL("http://mixed.example/"),
    DEFAULT_NETWORK_POLICY,
    resolver,
  );
  assert.equal(decision.allowed, false);
  assert.ok(!decision.allowed);
  assert.match(decision.message, /127\.0\.0\.1/);
});

test("checkRequestTarget: allows a hostname that resolves only to public addresses", async () => {
  const resolver = resolverOf({ "public.example": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"] });
  const decision = await checkRequestTarget(
    new URL("https://public.example/"),
    DEFAULT_NETWORK_POLICY,
    resolver,
  );
  assert.deepEqual(decision, { allowed: true });
});

test("checkRequestTarget: DNS failure maps to HTTP_NETWORK_ERROR, not a policy rejection", async () => {
  const resolver = resolverOf({});
  const decision = await checkRequestTarget(
    new URL("http://no-such-host.invalid/"),
    DEFAULT_NETWORK_POLICY,
    resolver,
  );
  assert.equal(decision.allowed, false);
  assert.ok(!decision.allowed);
  assert.equal(decision.code, "HTTP_NETWORK_ERROR");

  const empty: AddressResolver = async () => [];
  const decision2 = await checkRequestTarget(
    new URL("http://empty.example/"),
    DEFAULT_NETWORK_POLICY,
    empty,
  );
  assert.equal(decision2.allowed, false);
  assert.ok(!decision2.allowed);
  assert.equal(decision2.code, "HTTP_NETWORK_ERROR");
});

// ---------------------------------------------------------------------------
// HttpClient integration (rejections happen BEFORE any I/O → offline)
// ---------------------------------------------------------------------------

test("HttpClient: the default policy rejects internal targets before any request", async () => {
  const client = new HttpClient();
  assert.deepEqual(client.network, { allowPrivateNetwork: false });

  const blocked = [
    "http://127.0.0.1:1/x",
    "http://localhost:1/x",
    "http://[::1]:1/x",
    "http://10.0.0.1/x",
    "http://172.16.5.5/x",
    "http://192.168.1.1/x",
    "http://169.254.169.254/latest/meta-data/",
    "http://0.0.0.0:1/x",
  ];
  for (const url of blocked) {
    await assert.rejects(
      () => client.request(url, { timeoutMs: 500 }),
      (error: unknown) =>
        error instanceof HttpError && error.code === "HTTP_FORBIDDEN_TARGET",
      url,
    );
  }
});

test("HttpClient: obfuscated IPv4 literals cannot bypass the policy", async () => {
  // The WHATWG URL parser canonicalises these to dotted-quad form, so the
  // policy sees the real address. Each of these is 127.0.0.1.
  const client = new HttpClient();
  const encoded = [
    "http://2130706433/x", // decimal
    "http://0x7f000001/x", // hex
    "http://0x7f.1/x", // mixed hex
    "http://0177.0.0.1/x", // octal
    "http://127.1/x", // short form
    "http://127.0.1/x",
  ];
  for (const url of encoded) {
    assert.equal(new URL(url).hostname, "127.0.0.1", `normalisation of ${url}`);
    await assert.rejects(
      () => client.request(url, { timeoutMs: 500 }),
      (error: unknown) =>
        error instanceof HttpError && error.code === "HTTP_FORBIDDEN_TARGET",
      url,
    );
  }
});

test("HttpClient: scheme rejection still precedes the policy check", async () => {
  const client = new HttpClient();
  for (const url of [
    "file:///etc/passwd",
    "gopher://127.0.0.1:6379/_INFO",
    "data:text/html,<h1>x</h1>",
  ]) {
    await assert.rejects(
      () => client.request(url, { timeoutMs: 500 }),
      (error: unknown) =>
        error instanceof HttpError && error.code === "HTTP_UNSUPPORTED_SCHEME",
      url,
    );
  }
});

test("HttpClient: HTTP_FORBIDDEN_TARGET is part of the public error-code list", async () => {
  const { HTTP_ERROR_CODES } = await import("../src/http.js");
  assert.ok(HTTP_ERROR_CODES.includes("HTTP_FORBIDDEN_TARGET"));
  assert.equal(
    new Set(HTTP_ERROR_CODES).size,
    HTTP_ERROR_CODES.length,
    "error codes must stay unique",
  );
});

test("HttpClient: a redirect hop into an internal address is blocked before the second request", async (t) => {
  // Hop 1 is answered by a mocked fetch (no external host is contacted);
  // it redirects to the cloud metadata endpoint. The policy must reject
  // hop 2 BEFORE issuing it, so fetch must be called exactly once.
  let fetchCalls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async () => {
      fetchCalls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/iam/" },
      });
    },
  );

  const client = new HttpClient({
    // Hop 1 is a "public" hostname resolved by the injected resolver, so
    // the policy allows it and the mocked fetch answers with a 302.
    resolver: async (hostname) =>
      hostname === "public.example" ? ["93.184.216.34"] : [],
  });
  await assert.rejects(
    () => client.request("http://public.example/start", { timeoutMs: 2000 }),
    (error: unknown) => {
      assert.ok(error instanceof HttpError, "must be an HttpError");
      assert.equal(error.code, "HTTP_FORBIDDEN_TARGET");
      assert.match(error.message, /169\.254\.169\.254/);
      return true;
    },
  );
  assert.equal(fetchCalls, 1, "the blocked hop must never be requested");
});

// ---------------------------------------------------------------------------
// Local server: opt-in path still works (development / test fixtures)
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("internal-fixture");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("HttpClient: allowPrivateNetwork:true permits loopback (host opt-in)", async () => {
  const client = new HttpClient({ network: { allowPrivateNetwork: true } });
  assert.deepEqual(client.network, { allowPrivateNetwork: true });
  const res = await client.request(`${baseUrl}/`, { timeoutMs: 5000 });
  assert.equal(res.status, 200);
  assert.equal(res.body, "internal-fixture");
});

test("HttpClient: the same loopback URL is blocked by the default policy", async () => {
  const client = new HttpClient();
  await assert.rejects(
    () => client.request(`${baseUrl}/`, { timeoutMs: 5000 }),
    (error: unknown) =>
      error instanceof HttpError && error.code === "HTTP_FORBIDDEN_TARGET",
  );
});

// ---------------------------------------------------------------------------
// Guest level: a real plugin cannot reach internal targets
// ---------------------------------------------------------------------------

async function temp(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "spe-net-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makePlugin(base: string, name: string, source: string): Promise<Plugin> {
  const dir = path.join(base, name);
  await mkdir(dir, { recursive: true });
  const manifest = { id: `t.${name}`, name, version: "1.0.0", entry: "plugin.js" };
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(dir, "plugin.js"), source);
  return {
    pluginPath: dir,
    manifest,
    entryPath: path.join(dir, "plugin.js"),
    status: "loaded",
  };
}

const PROBE_SOURCE = `
export const plugin = {
  async probe(...rest) {
    const context = rest[rest.length - 1];
    const urls = rest.slice(0, -1);
    const out = [];
    for (const url of urls) {
      try {
        const res = await context.http.get(url, { timeoutMs: 1500 });
        out.push({ url, allowed: true, status: res.status, body: res.body.slice(0, 40) });
      } catch (err) {
        out.push({ url, allowed: false, code: err && err.code, message: err && err.message });
      }
    }
    return out;
  },
};`;

test("sandbox: a plugin cannot reach loopback or metadata under the default policy", async (t) => {
  const p = await makePlugin(await temp(t), "netdefault", PROBE_SOURCE);
  const runtime = new PluginRuntime({ timeoutMs: 15_000, logger: () => {} });
  t.after(() => runtime.shutdown());

  const loaded = await runtime.loadPlugin(p);
  assert.equal(loaded.ok, true, "plugin must load");
  if (!loaded.ok) throw new Error("unreachable");

  const targets = [
    `${baseUrl}/`, // the local fixture server
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]:1/",
    "http://10.255.255.254/",
  ];
  const result = await runtime.execute(loaded.plugin, "probe", targets);
  assert.equal(result.success, true, "execution must not fail");
  assert.ok(result.success);

  const rows = result.value as { url: string; allowed: boolean; code?: string }[];
  assert.equal(rows.length, targets.length);
  for (const row of rows) {
    assert.equal(row.allowed, false, `${row.url} must be blocked for a plugin`);
    assert.equal(row.code, "HTTP_FORBIDDEN_TARGET", row.url);
  }
  // The rejection is structured and must not leak host internals.
  for (const row of rows) {
    const message = (row as { message?: string }).message ?? "";
    assert.ok(!message.includes("/home/"), "no host paths in errors");
    assert.ok(!message.includes("at "), "no stack frames in errors");
  }
});

test("sandbox: the host can grant a plugin loopback access explicitly", async (t) => {
  const p = await makePlugin(await temp(t), "netoptin", PROBE_SOURCE);
  const runtime = new PluginRuntime({
    timeoutMs: 15_000,
    logger: () => {},
    http: { network: { allowPrivateNetwork: true } },
  });
  t.after(() => runtime.shutdown());

  const loaded = await runtime.loadPlugin(p);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) throw new Error("unreachable");

  const result = await runtime.execute(loaded.plugin, "probe", [`${baseUrl}/`]);
  assert.equal(result.success, true);
  assert.ok(result.success);
  const rows = result.value as { allowed: boolean; body?: string }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.allowed, true, "opt-in host policy permits the local fixture");
  assert.equal(rows[0]?.body, "internal-fixture");
});

test("sandbox: a plugin cannot raise or override the network policy itself", async (t) => {
  // The policy is a host-side construction option and nothing on the
  // guest context exposes it. The guest context objects are not frozen,
  // so a plugin CAN add arbitrary properties to `context.http` — the
  // security property that matters is that doing so has NO effect: the
  // host reads only get/getJson/request and applies its own policy.
  const source = `
export const plugin = {
  async escalate(...rest) {
    const context = rest[rest.length - 1];
    const url = rest[0];
    const httpSurfaceBefore = Object.getOwnPropertyNames(context.http).sort();
    const contextSurface = Object.getOwnPropertyNames(context).sort();

    // Attempt every plausible way to grant itself network permission.
    const attempts = {};
    try { context.http.network = { allowPrivateNetwork: true }; attempts.propSet = "assigned"; }
    catch (e) { attempts.propSet = "threw: " + e.message; }
    try { context.network = { allowPrivateNetwork: true }; attempts.contextSet = "assigned"; }
    catch (e) { attempts.contextSet = "threw: " + e.message; }
    try { context.http.get.policy = { allowPrivateNetwork: true }; attempts.fnProp = "assigned"; }
    catch (e) { attempts.fnProp = "threw: " + e.message; }
    try { globalThis.allowPrivateNetwork = true; attempts.global = "assigned"; }
    catch (e) { attempts.global = "threw: " + e.message; }

    // Now actually try the request the tampering was meant to unlock.
    let outcome;
    try {
      const res = await context.http.get(url, { timeoutMs: 1500 });
      outcome = { allowed: true, status: res.status };
    } catch (err) {
      outcome = { allowed: false, code: err && err.code };
    }
    return { contextSurface, httpSurfaceBefore, attempts, outcome };
  },
};`;
  const p = await makePlugin(await temp(t), "netinspect", source);
  const runtime = new PluginRuntime({ timeoutMs: 15_000, logger: () => {} });
  t.after(() => runtime.shutdown());

  const loaded = await runtime.loadPlugin(p);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) throw new Error("unreachable");

  const result = await runtime.execute(loaded.plugin, "escalate", [
    "http://169.254.169.254/latest/meta-data/",
  ]);
  assert.equal(result.success, true);
  assert.ok(result.success);

  const value = result.value as {
    contextSurface: string[];
    httpSurfaceBefore: string[];
    attempts: Record<string, string>;
    outcome: { allowed: boolean; code?: string };
  };

  // The engine-authored surface is exactly as documented — the policy is
  // not part of it.
  assert.deepEqual(value.contextSurface, ["html", "http", "json", "log", "manifest"]);
  assert.deepEqual(value.httpSurfaceBefore, ["get", "getJson", "request"]);

  // The real assertion: every tampering attempt is INEFFECTIVE.
  assert.equal(value.outcome.allowed, false, "escalation must not work");
  assert.equal(value.outcome.code, "HTTP_FORBIDDEN_TARGET");

  // The host policy object is untouched by guest writes.
  const client = new HttpClient();
  assert.deepEqual(client.network, { allowPrivateNetwork: false });
});
