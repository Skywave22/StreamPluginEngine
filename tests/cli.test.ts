/**
 * Phase 7 — CLI end-to-end tests.
 *
 * `src/cli.ts` ships as a supported user-facing entry point
 * (`npm run plugins:list`, `npm run plugin:run`) but had no test
 * coverage at all through Phase 6. These tests run the BUILT CLI as a
 * real child process against fixture plugin directories, so they verify
 * the actual command contract: argument parsing, output, and exit codes.
 *
 * Determinism: no network, no public Internet, no machine-specific
 * paths. Plugin fixtures are written to a temp directory and the CLI is
 * spawned with that directory as its cwd (the `run` command resolves
 * `plugins/` relative to cwd).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

// dist/tests/cli.test.js → repoRoot is two levels up.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliPath = path.join(repoRoot, "dist", "src", "cli.js");
/** The repository's own example plugin directory. */
const repoPluginsDir = path.join(repoRoot, "plugins");

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run the built CLI in a subprocess and capture its full result. */
function runCli(
  args: string[],
  cwd: string = repoRoot,
): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code)
            : error
              ? 1
              : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      },
    );
  });
}

async function temp(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "spe-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Write a `plugins/<name>/` fixture and return the parent directory. */
async function fixture(
  t: TestContext,
  name: string,
  manifest: Record<string, unknown>,
  source: string,
): Promise<string> {
  const base = await temp(t);
  const dir = path.join(base, "plugins", name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(dir, "plugin.js"), source);
  return base;
}

const ECHO_SOURCE = `
export const plugin = {
  echo(value) { return { echoed: value }; },
  sum(...rest) {
    const context = rest[rest.length - 1];
    const nums = rest.slice(0, -1);
    context.log("summing", nums.length, "numbers");
    return nums.reduce((a, b) => a + b, 0);
  },
  fails() { throw new Error("capability exploded"); },
  // Async without host timers: the sandbox has no setTimeout/setInterval,
  // so yield through microtasks only.
  async slow() {
    let acc = 0;
    for (let i = 0; i < 5; i++) { acc += await Promise.resolve(i); }
    return "done";
  },
};`;

const ECHO_MANIFEST = {
  id: "t.echo",
  name: "Echo Fixture",
  version: "1.0.0",
  entry: "plugin.js",
};

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test("cli: the built CLI exists and lists the repository's example plugin", async () => {
  const res = await runCli(["list", repoPluginsDir]);
  assert.equal(res.code, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /^Plugins/m);
  assert.match(res.stdout, /Example Source/);
  assert.match(res.stdout, /ID: example\.source/);
  assert.match(res.stdout, /Version: 1\.0\.0/);
  assert.match(res.stdout, /Status: loaded/);
});

test("cli: no arguments defaults to listing ./plugins from cwd", async () => {
  const res = await runCli([]);
  assert.equal(res.code, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /Example Source/);
});

test("cli: 'list' with no explicit directory behaves like no arguments", async () => {
  const res = await runCli(["list"]);
  assert.equal(res.code, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /Example Source/);
});

test("cli: lists a fixture plugin from a temp directory", async (t) => {
  const base = await fixture(t, "echo", ECHO_MANIFEST, ECHO_SOURCE);
  const res = await runCli(["list", path.join(base, "plugins")]);
  assert.equal(res.code, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /Echo Fixture/);
  assert.match(res.stdout, /ID: t\.echo/);
});

test("cli: an empty plugin directory reports no plugins (exit 0)", async (t) => {
  const base = await temp(t);
  const empty = path.join(base, "plugins");
  await mkdir(empty, { recursive: true });
  const res = await runCli(["list", empty]);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /\(no plugins found in /);
});

test("cli: a missing plugin directory fails with exit code 1", async (t) => {
  const base = await temp(t);
  const res = await runCli(["list", path.join(base, "does-not-exist")]);
  assert.equal(res.code, 1);
  assert.ok(res.stderr.length > 0, "an error must be reported on stderr");
});

test("cli: invalid plugins are reported under Problems without failing the run", async (t) => {
  const base = await temp(t);
  const good = path.join(base, "plugins", "good");
  const bad = path.join(base, "plugins", "bad");
  await mkdir(good, { recursive: true });
  await mkdir(bad, { recursive: true });
  await writeFile(path.join(good, "manifest.json"), JSON.stringify(ECHO_MANIFEST));
  await writeFile(path.join(good, "plugin.js"), ECHO_SOURCE);
  // Malformed JSON manifest.
  await writeFile(path.join(bad, "manifest.json"), "{ not valid json ");
  await writeFile(path.join(bad, "plugin.js"), "export const plugin = {};");

  const res = await runCli(["list", path.join(base, "plugins")]);
  assert.equal(res.code, 0, "one bad plugin must not fail discovery");
  assert.match(res.stdout, /Echo Fixture/);
  assert.match(res.stdout, /Problems/);
  assert.match(res.stdout, /bad/);
});

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

test("cli: run executes a capability and prints a structured result", async (t) => {
  const base = await fixture(t, "echo", ECHO_MANIFEST, ECHO_SOURCE);
  const res = await runCli(["run", "t.echo", "echo", '["hello"]'], base);
  assert.equal(res.code, 0, `stderr: ${res.stderr}\nstdout: ${res.stdout}`);
  assert.match(res.stdout, /Plugin: Echo Fixture/);
  assert.match(res.stdout, /Operation: echo/);
  assert.match(res.stdout, /Status: SUCCESS/);
  assert.match(res.stdout, /Result: \{"echoed":"hello"\}/);
  assert.match(res.stdout, /Execution time: [\d.]+ ms/);
});

test("cli: run passes multiple JSON arguments positionally", async (t) => {
  const base = await fixture(t, "echo", ECHO_MANIFEST, ECHO_SOURCE);
  const res = await runCli(["run", "t.echo", "sum", "[1,2,3,4]"], base);
  assert.equal(res.code, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /Status: SUCCESS/);
  assert.match(res.stdout, /Result: 10/);
});

test("cli: run accepts a bare (non-array) JSON argument", async (t) => {
  const base = await fixture(t, "echo", ECHO_MANIFEST, ECHO_SOURCE);
  const res = await runCli(["run", "t.echo", "echo", '"scalar"'], base);
  assert.equal(res.code, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /Result: \{"echoed":"scalar"\}/);
});

test("cli: run with no arguments executes with an empty argument list", async (t) => {
  const base = await fixture(t, "echo", ECHO_MANIFEST, ECHO_SOURCE);
  const res = await runCli(["run", "t.echo", "sum"], base);
  assert.equal(res.code, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /Result: 0/);
});

test("cli: plugin log output is routed to stdout with the plugin id", async (t) => {
  const base = await fixture(t, "echo", ECHO_MANIFEST, ECHO_SOURCE);
  const res = await runCli(["run", "t.echo", "sum", "[5,5]"], base);
  assert.equal(res.code, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /\[t\.echo\] summing 2 numbers/);
});

test("cli: an unknown plugin id fails with exit code 1", async (t) => {
  const base = await fixture(t, "echo", ECHO_MANIFEST, ECHO_SOURCE);
  const res = await runCli(["run", "t.nope", "echo"], base);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Plugin not found: t\.nope/);
});

test("cli: an unknown capability fails with PLUGIN_CAPABILITY_NOT_FOUND", async (t) => {
  const base = await fixture(t, "echo", ECHO_MANIFEST, ECHO_SOURCE);
  const res = await runCli(["run", "t.echo", "nope"], base);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /Status: FAILURE/);
  assert.match(res.stdout, /PLUGIN_CAPABILITY_NOT_FOUND/);
  // The error must list what the plugin DOES expose — actionable output.
  assert.match(res.stdout, /echo/);
  assert.match(res.stdout, /sum/);
});

test("cli: a throwing capability is reported as FAILURE with exit code 1", async (t) => {
  const base = await fixture(t, "echo", ECHO_MANIFEST, ECHO_SOURCE);
  const res = await runCli(["run", "t.echo", "fails"], base);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /Status: FAILURE/);
  assert.match(res.stdout, /PLUGIN_RUNTIME_ERROR/);
});

test("cli: malformed JSON arguments are rejected before any plugin runs", async (t) => {
  const base = await fixture(t, "echo", ECHO_MANIFEST, ECHO_SOURCE);
  const res = await runCli(["run", "t.echo", "echo", "{not json"], base);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Invalid arguments: expected JSON/);
  assert.ok(!/Status:/.test(res.stdout), "the plugin must not be invoked");
});

test("cli: run without a plugin id or operation prints usage", async () => {
  const missingBoth = await runCli(["run"]);
  assert.equal(missingBoth.code, 1);
  assert.match(missingBoth.stderr, /Usage: cli run <pluginId> <operation>/);

  const missingOp = await runCli(["run", "t.echo"]);
  assert.equal(missingOp.code, 1);
  assert.match(missingOp.stderr, /Usage: cli run <pluginId> <operation>/);
});

test("cli: a plugin whose entry fails to load is reported, not thrown", async (t) => {
  const base = await fixture(
    t,
    "broken",
    { id: "t.broken", name: "Broken", version: "1.0.0", entry: "plugin.js" },
    "this is not valid javascript ***",
  );
  const res = await runCli(["run", "t.broken", "anything"], base);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /Status: FAILURE/);
  assert.match(res.stdout, /Error: PLUGIN_/);
});

test("cli: run resolves plugins/ relative to cwd, not to the install path", async (t) => {
  // Regression: the CLI must not depend on where the repository happens
  // to live (no machine-specific paths).
  const base = await fixture(t, "echo", ECHO_MANIFEST, ECHO_SOURCE);
  const elsewhere = await temp(t);
  const res = await runCli(["run", "t.echo", "echo", '["cwd-ok"]'], elsewhere);
  assert.equal(res.code, 1, "an unrelated cwd has no plugins/ directory");
  assert.match(res.stderr, /Plugins directory not found:/);
  assert.ok(
    !res.stderr.includes(repoRoot),
    "the error must reference the cwd's plugins dir, not the install path",
  );

  const ok = await runCli(["run", "t.echo", "echo", '["cwd-ok"]'], base);
  assert.equal(ok.code, 0, `stderr: ${ok.stderr}`);
  assert.match(ok.stdout, /Result: \{"echoed":"cwd-ok"\}/);
});

test("cli: async capabilities complete and the process exits cleanly", async (t) => {
  const base = await fixture(t, "echo", ECHO_MANIFEST, ECHO_SOURCE);
  const res = await runCli(["run", "t.echo", "slow"], base);
  assert.equal(res.code, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /Result: "done"/);
  // No leaked handles should keep the process alive or emit warnings.
  assert.ok(!/MaxListeners|Warning|unhandled/i.test(res.stderr), res.stderr);
});
