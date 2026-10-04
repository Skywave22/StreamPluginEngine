/**
 * CLI for StreamPluginEngine.
 *
 * Commands:
 *   node dist/src/cli.js [list] [pluginsDir] [--plugins-dir <dir>]
 *   node dist/src/cli.js run <pluginId> <operation> [jsonArgs] [--plugins-dir <dir>]
 *   node dist/src/cli.js validate <pluginDir | manifest.json>
 *
 * `validate` is developer tooling for plugin authors: it checks a plugin
 * directory (or a standalone manifest file) with the engine's own
 * validator and prints the result, so a plugin can be checked before it
 * is dropped into a plugins directory.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { ENGINE_API_VERSION, validateManifest } from "./manifest.js";
import { PluginLoader } from "./loader.js";
import { PluginManager } from "./manager.js";
import { PluginRuntime } from "./runtime.js";

const RULE = "─".repeat(24);

/**
 * Extract `--plugins-dir <dir>` / `--plugins-dir=<dir>` from the
 * argument list. Unknown flags are left untouched as positionals, so
 * existing invocations keep working.
 */
function extractFlags(args: string[]): {
  positional: string[];
  pluginsDir?: string;
} {
  const positional: string[] = [];
  let pluginsDir: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--plugins-dir") {
      const value = args[i + 1];
      if (value !== undefined) {
        pluginsDir = value;
        i += 1;
      }
    } else if (arg.startsWith("--plugins-dir=")) {
      pluginsDir = arg.slice("--plugins-dir=".length);
    } else {
      positional.push(arg);
    }
  }
  return pluginsDir === undefined ? { positional } : { positional, pluginsDir };
}

async function listPlugins(pluginsDirArg?: string): Promise<void> {
  const pluginsDir = path.resolve(pluginsDirArg ?? "plugins");
  const manager = new PluginManager();

  try {
    await manager.discoverPlugins(pluginsDir);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const plugins = manager.listPlugins();
  console.log("Plugins");
  console.log(RULE);
  if (plugins.length === 0) console.log(`(no plugins found in ${pluginsDir})`);

  for (const plugin of plugins) {
    const manifest = plugin.manifest;
    if (!manifest) continue;
    console.log(manifest.name);
    console.log(`ID: ${manifest.id}`);
    console.log(`Version: ${manifest.version}`);
    console.log(`Status: ${plugin.status}`);
    console.log(`Enabled: ${plugin.enabled === false ? "no" : "yes"}`);
    if (manifest.domains && manifest.domains.length > 0) {
      // Declared domains are ENFORCED for context.http (v0.2.0).
      console.log(`Domains (enforced): ${manifest.domains.join(", ")}`);
    }
    console.log("");
  }

  const problems = manager.getProblems();
  if (problems.length > 0) {
    console.log("Problems");
    console.log(RULE);
    for (const problem of problems) {
      console.log(problem.pluginPath);
      for (const error of problem.errors ?? []) console.log(`  - ${error}`);
      console.log("");
    }
  }
}

async function runPlugin(
  pluginId: string,
  operation: string,
  argsJson?: string,
  pluginsDirArg?: string,
): Promise<void> {
  let args: unknown[] = [];
  if (argsJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsJson);
    } catch {
      console.error(
        'Invalid arguments: expected JSON — an array of arguments, e.g. ["query"], or a single value, e.g. "query"',
      );
      process.exitCode = 1;
      return;
    }
    args = Array.isArray(parsed) ? parsed : [parsed];
  }

  const pluginsDir = path.resolve(pluginsDirArg ?? "plugins");
  const manager = new PluginManager();
  try {
    await manager.discoverPlugins(pluginsDir);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const found = manager.getPlugin(pluginId);
  if (!found || !found.manifest) {
    console.error(`Plugin not found: ${pluginId}`);
    process.exitCode = 1;
    return;
  }

  const runtime = new PluginRuntime({
    logger: (id, message) => console.log(`  [${id}] ${message}`),
  });

  const manifest = found.manifest;
  const loadResult = await runtime.loadPlugin(found);
  if (!loadResult.ok) {
    console.log(`Plugin: ${manifest.name}`);
    console.log(`Operation: ${operation}`);
    console.log("Status: FAILURE");
    console.log(`Error: ${loadResult.error.type}: ${loadResult.error.message}`);
    process.exitCode = 1;
    return;
  }

  const loaded = loadResult.plugin;
  if (!loaded.capabilities.includes(operation)) {
    console.log(`Plugin: ${manifest.name}`);
    console.log(`Operation: ${operation}`);
    console.log("Status: FAILURE");
    console.log(
      `Error: PLUGIN_CAPABILITY_NOT_FOUND: plugin exposes ${loaded.capabilities.join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }

  const result = await runtime.execute(loaded, operation, args);
  console.log(`Plugin: ${manifest.name}`);
  console.log(`Operation: ${operation}`);
  if (result.success) {
    console.log("Status: SUCCESS");
    console.log(`Result: ${JSON.stringify(result.value)}`);
    console.log(`Execution time: ${result.executionTimeMs.toFixed(2)} ms`);
  } else {
    console.log("Status: FAILURE");
    console.log(`Error: ${result.error.type}: ${result.error.message}`);
    console.log(`Execution time: ${result.executionTimeMs.toFixed(2)} ms`);
    process.exitCode = 1;
  }

  runtime.dispose(loaded);
  runtime.shutdown();
}

/**
 * `validate <pluginDir | manifest.json>` — plugin-author tooling.
 *
 * Runs the engine's own validator against a plugin directory or a
 * standalone manifest file and prints a report. Exit code 0 = the plugin
 * would load; 1 = it would not, with every problem listed.
 */
async function validatePlugin(target: string): Promise<void> {
  const resolved = path.resolve(target);
  const targetStat = await stat(resolved).catch(() => null);

  console.log("Validate");
  console.log(RULE);
  console.log(`Target: ${resolved}`);

  if (!targetStat) {
    console.error(`Not found: ${resolved}`);
    process.exitCode = 1;
    return;
  }

  // Directory: full plugin check (manifest + entry file), via the same
  // loader discovery uses.
  if (targetStat.isDirectory()) {
    const plugin = await new PluginLoader().loadPlugin(resolved);
    const manifest = plugin.manifest;
    if (manifest) {
      console.log(`ID: ${manifest.id}`);
      console.log(`Name: ${manifest.name}`);
      console.log(`Version: ${manifest.version}`);
      console.log(`Entry: ${manifest.entry}`);
      console.log(`API version: ${manifest.apiVersion ?? 1}`);
      console.log(
        `Domains (enforced): ${
          manifest.domains && manifest.domains.length > 0
            ? manifest.domains.join(", ")
            : "(none — unrestricted by the domain gate)"
        }`,
      );
    }
    if (plugin.status === "loaded") {
      console.log(`Status: OK (the engine can load this plugin)`);
      return;
    }
    console.log(`Status: FAILED`);
    console.log("Problems");
    console.log(RULE);
    for (const error of plugin.errors ?? []) console.log(`  - ${error}`);
    process.exitCode = 1;
    return;
  }

  // File: standalone manifest validation.
  const raw = await readFile(resolved, "utf8").catch(() => null);
  if (raw === null) {
    console.error(`Not readable: ${resolved}`);
    process.exitCode = 1;
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("Status: FAILED");
    console.error(`  - Not valid JSON`);
    process.exitCode = 1;
    return;
  }
  const result = validateManifest(parsed);
  if (result.ok) {
    console.log(`Status: OK (valid manifest, engine API version ${ENGINE_API_VERSION})`);
    return;
  }
  console.log("Status: FAILED");
  console.log("Problems");
  console.log(RULE);
  for (const error of result.errors) console.log(`  - ${error}`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const { positional, pluginsDir } = extractFlags(process.argv.slice(2));
  const [command, ...rest] = positional;

  if (command === "run") {
    const [pluginId, operation, argsJson] = rest;
    if (!pluginId || !operation) {
      console.error(
        "Usage: cli run <pluginId> <operation> [jsonArgs] [--plugins-dir <dir>]",
      );
      process.exitCode = 1;
      return;
    }
    await runPlugin(pluginId, operation, argsJson, pluginsDir);
    return;
  }

  if (command === "validate") {
    const target = rest[0];
    if (!target) {
      console.error("Usage: cli validate <pluginDir | manifest.json>");
      process.exitCode = 1;
      return;
    }
    await validatePlugin(target);
    return;
  }

  const listDir = pluginsDir ?? (command === "list" ? rest[0] : command);
  await listPlugins(listDir);
}

void main();
