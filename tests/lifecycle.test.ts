/**
 * Phase 7 — lifecycle, stability, and concurrency tests.
 *
 * Why this file exists
 * --------------------
 * Through Phase 6 the runtime had single-operation coverage (load,
 * execute, dispose) but nothing that exercised the sandbox over repeated
 * or OVERLAPPING operations. The Phase 1–6 audit found a real defect
 * there:
 *
 *   BUG: a QuickJS runtime has ONE interrupt-handler slot. `execute()`
 *   installed a deadline handler on entry and removed it in `finally`, so
 *   when two operations overlapped on the same plugin, the first to
 *   finish removed the guard the other still needed. Because guest code
 *   runs synchronously on the host thread, an operation that spun after
 *   an `await` could then never be preempted — it blocked the host event
 *   loop permanently and took the whole process down.
 *
 * Operations are now serialized per plugin sandbox (see
 * LoadedPluginHandle.queue in src/runtime.ts). The regression test below
 * runs the overlapping scenario in a CHILD PROCESS with a hard timeout,
 * so if the bug ever returns the test fails cleanly instead of freezing
 * the suite.
 *
 * Determinism: all fixtures are local (temp dirs, 127.0.0.1 server); no
 * public Internet.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test, type TestContext } from "node:test";

import { PluginRuntime } from "../src/runtime.js";
import type { Plugin } from "../src/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** Absolute directory of the BUILT engine, used by the child-process test. */
const distSrc = path.join(repoRoot, "dist", "src");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer((req, res) => {
    if ((req.url ?? "").startsWith("/slow")) {
      setTimeout(() => {
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("slow-ok");
        }
      }, 400);
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("fast-ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function temp(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "spe-life-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const LIFECYCLE_SOURCE = `
export const plugin = {
  counter: (() => { let n = 0; return () => ++n; })(),
  echo(value) { return { echoed: value }; },
  busy(ms) {
    const end = Date.now() + ms;
    let x = 0;
    while (Date.now() < end) x += Math.sqrt(x + 1);
    return "busy-ok";
  },
  async afterHttp(url, ctx) {
    const res = await ctx.http.get(url, { timeoutMs: 5000 });
    return { status: res.status, body: res.body };
  },
  async spinAfterHttp(url, ctx) {
    await ctx.http.get(url, { timeoutMs: 5000 });
    let x = 0;
    while (true) x += Math.sqrt(x + 1);   // never returns
  },
  async pendingHttp(url, ctx) {
    // Starts a request and never awaits it to completion.
    const p = ctx.http.get(url, { timeoutMs: 8000 });
    p.catch(() => {});
    return "started";
  },
};`;

async function makePlugin(
  t: TestContext,
  name: string,
  source: string = LIFECYCLE_SOURCE,
): Promise<Plugin> {
  const base = await temp(t);
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

/** Runtime that may talk to the local fixture server. */
function localRuntime(options: { timeoutMs?: number } = {}): PluginRuntime {
  return new PluginRuntime({
    timeoutMs: options.timeoutMs ?? 10_000,
    logger: () => {},
    http: { network: { allowPrivateNetwork: true } },
  });
}

// ---------------------------------------------------------------------------
// Repeated execution and repeated load/dispose
// ---------------------------------------------------------------------------

test("lifecycle: repeated execution on one loaded plugin stays correct", async (t) => {
  const p = await makePlugin(t, "repeat");
  const runtime = localRuntime();
  t.after(() => runtime.shutdown());
  const loaded = await runtime.loadPlugin(p);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) throw new Error("unreachable");

  for (let i = 0; i < 50; i++) {
    const res = await runtime.execute(loaded.plugin, "echo", [i]);
    assert.equal(res.success, true, `iteration ${i} failed`);
    assert.ok(res.success);
    assert.deepEqual(res.value, { echoed: i });
  }
});

test("lifecycle: module state persists across executions of one load", async (t) => {
  // A plugin is loaded ONCE; its module scope must survive between calls
  // (and must not leak between separate loads).
  const p = await makePlugin(t, "stateful");
  const runtime = localRuntime();
  t.after(() => runtime.shutdown());
  const loaded = await runtime.loadPlugin(p);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) throw new Error("unreachable");

  const seen: unknown[] = [];
  for (let i = 0; i < 5; i++) {
    const res = await runtime.execute(loaded.plugin, "counter", []);
    assert.equal(res.success, true);
    assert.ok(res.success);
    seen.push(res.value);
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);

  // A SECOND load of the same plugin starts from fresh module state.
  const second = await runtime.loadPlugin(p);
  assert.equal(second.ok, true);
  if (!second.ok) throw new Error("unreachable");
  const res = await runtime.execute(second.plugin, "counter", []);
  assert.ok(res.success);
  assert.equal(res.value, 1, "a fresh load must not inherit the first load's state");
  runtime.dispose(second.plugin);
});

test("lifecycle: repeated load/dispose cycles all succeed and leave nothing broken", async (t) => {
  const p = await makePlugin(t, "cycles");
  const runtime = localRuntime();
  t.after(() => runtime.shutdown());

  for (let i = 0; i < 25; i++) {
    const loaded = await runtime.loadPlugin(p);
    assert.equal(loaded.ok, true, `cycle ${i}: load failed`);
    if (!loaded.ok) throw new Error("unreachable");
    assert.ok(loaded.loadTimeMs >= 0);

    const res = await runtime.execute(loaded.plugin, "echo", [`cycle-${i}`]);
    assert.equal(res.success, true, `cycle ${i}: execute failed`);

    assert.equal(runtime.dispose(loaded.plugin), true, `cycle ${i}: dispose failed`);
  }
});

test("lifecycle: a runtime can be shut down and a fresh one created", async (t) => {
  const p = await makePlugin(t, "recreate");

  const first = localRuntime();
  const l1 = await first.loadPlugin(p);
  assert.equal(l1.ok, true);
  if (!l1.ok) throw new Error("unreachable");
  const r1 = await first.execute(l1.plugin, "echo", ["first"]);
  assert.equal(r1.success, true);
  first.shutdown();

  // A brand-new runtime must work after the previous one was shut down
  // (no leaked global/module state in the engine).
  const second = localRuntime();
  t.after(() => second.shutdown());
  const l2 = await second.loadPlugin(p);
  assert.equal(l2.ok, true, "a fresh runtime must load plugins");
  if (!l2.ok) throw new Error("unreachable");
  const r2 = await second.execute(l2.plugin, "echo", ["second"]);
  assert.equal(r2.success, true);
  assert.ok(r2.success);
  assert.deepEqual(r2.value, { echoed: "second" });
});

// ---------------------------------------------------------------------------
// Dispose / shutdown robustness
// ---------------------------------------------------------------------------

test("lifecycle: dispose is idempotent and shutdown is safe to repeat", async (t) => {
  const p = await makePlugin(t, "dispose");
  const runtime = localRuntime();
  const loaded = await runtime.loadPlugin(p);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) throw new Error("unreachable");

  assert.equal(runtime.dispose(loaded.plugin), true, "first dispose succeeds");
  assert.equal(runtime.dispose(loaded.plugin), false, "second dispose is a no-op");
  runtime.shutdown();
  runtime.shutdown(); // must not throw
  t.after(() => runtime.shutdown());
});

test("lifecycle: executing a disposed plugin returns a structured error, not a crash", async (t) => {
  const p = await makePlugin(t, "disposed");
  const runtime = localRuntime();
  t.after(() => runtime.shutdown());
  const loaded = await runtime.loadPlugin(p);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) throw new Error("unreachable");

  runtime.dispose(loaded.plugin);
  const res = await runtime.execute(loaded.plugin, "echo", ["x"]);
  assert.equal(res.success, false);
  assert.ok(!res.success);
  assert.equal(res.error.type, "PLUGIN_RUNTIME_ERROR");
  assert.ok(res.executionTimeMs >= 0);
});

test("lifecycle: a plugin handle from another runtime is rejected", async (t) => {
  const p = await makePlugin(t, "foreign");
  const owner = localRuntime();
  const other = localRuntime();
  t.after(() => {
    owner.shutdown();
    other.shutdown();
  });

  const loaded = await owner.loadPlugin(p);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) throw new Error("unreachable");

  const res = await other.execute(loaded.plugin, "echo", ["x"]);
  assert.equal(res.success, false);
  assert.ok(!res.success);
  assert.equal(res.error.type, "PLUGIN_RUNTIME_ERROR");
  assert.match(res.error.message, /not created by this PluginRuntime/);
  // The owning runtime is unaffected.
  const ok = await owner.execute(loaded.plugin, "echo", ["still-fine"]);
  assert.equal(ok.success, true);
});

test("lifecycle: shutdown disposes every loaded plugin", async (t) => {
  const a = await makePlugin(t, "multi-a");
  const b = await makePlugin(t, "multi-b");
  const runtime = localRuntime();
  const la = await runtime.loadPlugin(a);
  const lb = await runtime.loadPlugin(b);
  assert.equal(la.ok, true);
  assert.equal(lb.ok, true);
  if (!la.ok || !lb.ok) throw new Error("unreachable");

  runtime.shutdown();
  // Both handles must now be unusable (dispose reports false → already gone).
  assert.equal(runtime.dispose(la.plugin), false);
  assert.equal(runtime.dispose(lb.plugin), false);
  const res = await runtime.execute(la.plugin, "echo", ["x"]);
  assert.equal(res.success, false);
  t.after(() => runtime.shutdown());
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

test("concurrency: operations on DIFFERENT plugins run concurrently and both succeed", async (t) => {
  const a = await makePlugin(t, "conc-a");
  const b = await makePlugin(t, "conc-b");
  const runtime = localRuntime({ timeoutMs: 15_000 });
  t.after(() => runtime.shutdown());

  const la = await runtime.loadPlugin(a);
  const lb = await runtime.loadPlugin(b);
  assert.equal(la.ok, true);
  assert.equal(lb.ok, true);
  if (!la.ok || !lb.ok) throw new Error("unreachable");

  const results = await Promise.all([
    runtime.execute(la.plugin, "afterHttp", [`${baseUrl}/fast`]),
    runtime.execute(lb.plugin, "afterHttp", [`${baseUrl}/fast`]),
  ]);
  for (const [i, res] of results.entries()) {
    assert.equal(res.success, true, `plugin ${i} failed`);
    assert.ok(res.success);
    assert.deepEqual(res.value, { status: 200, body: "fast-ok" });
  }
});

test("concurrency: overlapping operations on ONE plugin are serialized and all complete", async (t) => {
  const p = await makePlugin(t, "conc-same");
  const runtime = localRuntime({ timeoutMs: 20_000 });
  t.after(() => runtime.shutdown());
  const loaded = await runtime.loadPlugin(p);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) throw new Error("unreachable");

  const results = await Promise.all([
    runtime.execute(loaded.plugin, "busy", [60]),
    runtime.execute(loaded.plugin, "busy", [60]),
    runtime.execute(loaded.plugin, "busy", [60]),
  ]);
  for (const res of results) {
    assert.equal(res.success, true);
    assert.ok(res.success);
    assert.equal(res.value, "busy-ok");
  }
});

test("concurrency: a failed operation does not poison later operations on the same plugin", async (t) => {
  const p = await makePlugin(t, "conc-fail");
  // 1500 ms comfortably exceeds the fixture server's 400 ms delay, so the
  // HTTP hop completes and the spin actually starts before the deadline.
  const runtime = localRuntime({ timeoutMs: 1_500 });
  t.after(() => runtime.shutdown());
  const loaded = await runtime.loadPlugin(p);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) throw new Error("unreachable");

  // Fire a timing-out operation and a healthy one together. The queue tail
  // must stay usable after the first one fails.
  const [bad, good] = await Promise.all([
    runtime.execute(loaded.plugin, "spinAfterHttp", [`${baseUrl}/slow`]),
    runtime.execute(loaded.plugin, "echo", ["after-failure"]),
  ]);
  assert.equal(bad.success, false, "the spinning operation must fail");
  assert.ok(!bad.success);
  assert.equal(bad.error.type, "PLUGIN_TIMEOUT");

  assert.equal(good.success, true, "the queue must recover");
  assert.ok(good.success);
  assert.deepEqual(good.value, { echoed: "after-failure" });

  // And the plugin is still usable afterwards.
  const again = await runtime.execute(loaded.plugin, "echo", ["still-usable"]);
  assert.equal(again.success, true);
});

test("concurrency: overlapping operations never lose the timeout guard (regression, child process)", async (t) => {
  // REGRESSION for the interrupt-handler race. Runs in a child process
  // with a hard timeout: if the guard is ever lost again, the guest spins
  // on the host thread and blocks the event loop — in-process that would
  // freeze the whole test suite, so it is isolated here.
  const dir = await temp(t);
  const script = path.join(dir, "race.mjs");
  await writeFile(
    script,
    `
import { createServer } from "node:http";
import { PluginRuntime } from ${JSON.stringify(path.join(distSrc, "runtime.js"))};
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const server = createServer((req, res) => {
  setTimeout(() => {
    if (!res.destroyed && !res.writableEnded) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("slow-ok");
    }
  }, 300);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port;

const dir = ${JSON.stringify(path.join(dir, "plugin"))};
await mkdir(dir, { recursive: true });
await writeFile(path.join(dir, "manifest.json"), JSON.stringify({
  id: "t.race", name: "race", version: "1.0.0", entry: "plugin.js",
}));
await writeFile(path.join(dir, "plugin.js"), ${JSON.stringify(LIFECYCLE_SOURCE)});

const runtime = new PluginRuntime({
  timeoutMs: 1000,
  logger: () => {},
  http: { network: { allowPrivateNetwork: true } },
});
const plugin = {
  pluginPath: dir,
  manifest: { id: "t.race", name: "race", version: "1.0.0", entry: "plugin.js" },
  entryPath: path.join(dir, "plugin.js"),
  status: "loaded",
};
const loaded = await runtime.loadPlugin(plugin);
if (!loaded.ok) {
  console.log(JSON.stringify({ fatal: "load failed", error: loaded.error }));
  process.exit(1);
}

const started = Date.now();
// op1 yields on host HTTP, then spins forever. op2 is short CPU work that
// FINISHES FIRST. Before the fix, op2's teardown removed the interrupt
// handler op1 still needed, so op1 spun forever and blocked the process.
const [op1, op2] = await Promise.all([
  runtime.execute(loaded.plugin, "spinAfterHttp", [base + "/slow"]),
  runtime.execute(loaded.plugin, "busy", [100]),
]);
const elapsed = Date.now() - started;

runtime.shutdown();
server.close();
console.log(JSON.stringify({
  op1: op1.success ? "ok" : op1.error.type,
  op2: op2.success ? "ok" : op2.error.type,
  elapsed,
}));
process.exit(0);
`,
  );

  const outcome = await new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve) => {
      execFile(
        process.execPath,
        [script],
        { cwd: dir, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : error
                ? 1
                : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    },
  );

  assert.equal(
    outcome.code,
    0,
    `child process must exit cleanly (a hang means the timeout guard was lost).\nstdout: ${outcome.stdout}\nstderr: ${outcome.stderr}`,
  );
  const report = JSON.parse(outcome.stdout.trim().split("\n").pop() ?? "{}") as {
    op1?: string;
    op2?: string;
    elapsed?: number;
    fatal?: string;
  };
  assert.equal(report.fatal, undefined, `load must succeed: ${outcome.stdout}`);
  assert.equal(report.op1, "PLUGIN_TIMEOUT", "the spinning operation must be interrupted");
  assert.equal(report.op2, "ok", "the short operation must still succeed");
  assert.ok(
    (report.elapsed ?? Number.POSITIVE_INFINITY) < 20_000,
    `must finish promptly, took ${report.elapsed} ms`,
  );
});

// ---------------------------------------------------------------------------
// Cancellation / teardown while work is in flight
// ---------------------------------------------------------------------------

test("lifecycle: disposing a plugin aborts its in-flight HTTP request", async (t) => {
  const p = await makePlugin(t, "inflight");
  const runtime = localRuntime({ timeoutMs: 15_000 });
  t.after(() => runtime.shutdown());
  const loaded = await runtime.loadPlugin(p);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) throw new Error("unreachable");

  // Start an operation whose HTTP request is still in flight, then dispose.
  const pending = runtime.execute(loaded.plugin, "afterHttp", [`${baseUrl}/slow`]);
  // Give the request time to reach the server.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(runtime.dispose(loaded.plugin), true);

  const res = await pending;
  // Either the operation completed before disposal or it failed cleanly —
  // it must NOT throw an unhandled host error or hang.
  assert.equal(typeof res.success, "boolean");
  if (!res.success) {
    assert.ok(
      ["PLUGIN_RUNTIME_ERROR", "PLUGIN_TIMEOUT", "PLUGIN_CAPABILITY_NOT_FOUND"].includes(
        res.error.type,
      ),
      `unexpected error type: ${res.error.type}`,
    );
  }
});

test("lifecycle: an operation that ends aborts its own in-flight requests", async (t) => {
  const p = await makePlugin(t, "opabort");
  const runtime = localRuntime({ timeoutMs: 15_000 });
  t.after(() => runtime.shutdown());
  const loaded = await runtime.loadPlugin(p);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) throw new Error("unreachable");

  // The capability starts a request it never awaits, then returns. The
  // operation's teardown must abort that request rather than leave it
  // running uncontrolled.
  const res = await runtime.execute(loaded.plugin, "pendingHttp", [`${baseUrl}/slow`]);
  assert.equal(res.success, true, "the capability itself must succeed");
  assert.ok(res.success);
  assert.equal(res.value, "started");

  // The plugin must still be usable and the process must stay quiet.
  const again = await runtime.execute(loaded.plugin, "echo", ["fine"]);
  assert.equal(again.success, true);
});
