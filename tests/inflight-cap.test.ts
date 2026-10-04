/**
 * v0.3.0: per-plugin in-flight HTTP request cap.
 *
 * A media-source plugin naturally wants to fan out with `Promise.all`
 * over mirrors/episodes. Without a cap, one plugin can open an unbounded
 * number of host sockets. The engine bounds it and reports the surplus
 * request structurally, so plugin code using `allSettled` degrades
 * gracefully instead of failing wholesale.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";

import { PluginManager } from "../src/manager.js";
import { PluginRuntime } from "../src/runtime.js";
import type { LoadedPlugin, PluginRuntimeOptions } from "../src/types.js";

/** Plugin that fires N requests at once and reports each outcome. */
const FANOUT_PLUGIN = `
export const plugin = {
  async fanout(count, context) {
    const tasks = [];
    for (let i = 0; i < count; i++) {
      tasks.push(
        context.http
          .get("http://127.0.0.1:PORT/slow?i=" + i, { timeoutMs: 5000 })
          .then((res) => ({ ok: true, status: res.status }))
          .catch((e) => ({ ok: false, code: e.code })),
      );
    }
    const settled = await Promise.all(tasks);
    const ok = settled.filter((s) => s.ok).length;
    const limited = settled.filter((s) => s.code === "HTTP_TOO_MANY_REQUESTS").length;
    const codes = [];
    for (const s of settled) {
      if (!s.ok && s.code !== "HTTP_TOO_MANY_REQUESTS" && codes.indexOf(s.code) === -1) codes.push(s.code);
    }
    return { ok, limited, otherCodes: codes };
  },
};
`;

let server: Server;
let baseUrl = "";
let inFlight = 0;
let peakInFlight = 0;

before(async () => {
  server = createServer((_req, res) => {
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    // Hold the response open so overlap is observable, then answer.
    setTimeout(() => {
      inFlight -= 1;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    }, 40);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function setup(
  t: TestContext,
  runtimeOptions: PluginRuntimeOptions = {},
): Promise<{ runtime: PluginRuntime; plugin: LoadedPlugin }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "spe-inflight-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = path.join(base, "t.fan");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id: "t.fan",
      name: "Fan",
      version: "1.0.0",
      entry: "plugin.js",
      domains: ["127.0.0.1"],
    }),
  );
  await writeFile(
    path.join(dir, "plugin.js"),
    FANOUT_PLUGIN.replaceAll("127.0.0.1:PORT", new URL(baseUrl).host),
  );
  const manager = new PluginManager();
  await manager.discoverPlugins(base);
  const discovered = manager.getPlugin("t.fan");
  assert.ok(discovered);
  const runtime = new PluginRuntime({
    ...runtimeOptions,
    logger: () => {},
    http: {
      // Fixture server is on loopback; the host opts in explicitly. The
      // spread order keeps that opt-in when the caller only sets a cap.
      network: { allowPrivateNetwork: true },
      ...runtimeOptions.http,
    },
  });
  t.after(() => runtime.shutdown());
  const loaded = await runtime.loadPlugin(discovered);
  assert.ok(loaded.ok, loaded.ok ? "" : JSON.stringify(loaded.error));
  return { runtime, plugin: loaded.plugin };
}

test("in-flight cap: the default bounds concurrent requests per plugin", async (t) => {
  peakInFlight = 0;
  const { runtime, plugin } = await setup(t);
  const result = await runtime.execute(plugin, "fanout", [20]);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.error));
  const value = result.value as { ok: number; limited: number; otherCodes: string[] };

  assert.equal(value.ok, 8, "the default cap is 8 concurrent requests");
  assert.equal(value.limited, 12, "the surplus requests are rejected structurally");
  assert.deepEqual(value.otherCodes, [], "no other failure mode is introduced");
  assert.ok(
    peakInFlight <= 8,
    `the server must never see more than 8 at once (saw ${peakInFlight})`,
  );
});

test("in-flight cap: a host can raise it, and 0 disables it", async (t) => {
  peakInFlight = 0;
  const raised = await setup(t, { http: { maxInFlightPerPlugin: 12 } });
  const result12 = await raised.runtime.execute(raised.plugin, "fanout", [12]);
  assert.ok(result12.success);
  assert.equal((result12.value as { ok: number }).ok, 12);
  assert.ok(peakInFlight <= 12);

  peakInFlight = 0;
  const unlimited = await setup(t, { http: { maxInFlightPerPlugin: 0 } });
  const result20 = await unlimited.runtime.execute(unlimited.plugin, "fanout", [20]);
  assert.ok(result20.success);
  assert.equal((result20.value as { ok: number }).ok, 20);
  assert.equal((result20.value as { limited: number }).limited, 0);
  assert.ok(peakInFlight <= 20);
});

test("in-flight cap: the counter returns to zero, so later calls are unaffected", async (t) => {
  const { runtime, plugin } = await setup(t, { http: { maxInFlightPerPlugin: 4 } });
  const first = await runtime.execute(plugin, "fanout", [8]);
  assert.ok(first.success);
  assert.equal((first.value as { ok: number }).ok, 4);
  // If the counter leaked, this second call would see fewer slots.
  const second = await runtime.execute(plugin, "fanout", [4]);
  assert.ok(second.success);
  assert.equal((second.value as { ok: number }).ok, 4);
  assert.equal((second.value as { limited: number }).limited, 0);
});
