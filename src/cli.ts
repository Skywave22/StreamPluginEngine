/**
 * CLI for StreamPluginEngine.
 *
 * Commands:
 *   node dist/src/cli.js [list] [pluginsDir]        (default) — list plugins
 *   node dist/src/cli.js run <pluginId> [op] [jsonArgs]
 *                                                   — run a capability
 *
 * `list` mirrors `npm run plugins:list`.
 * `run` mirrors `npm run plugin:run -- <pluginId> [op] [jsonArgs]`.
 *
 * The run command loads a plugin, executes one capability in the
 * sandboxed runtime, prints the result, and shuts down cleanly.
 */
import path from "node:path";
import process from "node:process";

import { PluginManager } from "./manager.js";
import { PluginRuntime } from "./runtime.js";

const RULE = "─".repeat(24);

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
  if (plugins.length === 0) {
    console.log(`(no plugins found in ${pluginsDir})`);
  }
  for (const plugin of plugins) {
    const manifest = plugin.manifest;
    if (!manifest) {
      continue;
    }
    console.log(manifest.name);
    console.log(`ID: ${manifest.id}`);
    console.log(`Version: ${manifest.version}`);
    console.log(`Status: ${plugin.status}`);
    console.log("");
  }

  const problems = manager.getProblems();
  if (problems.length > 0) {
    console.log("Problems");
    console.log(RULE);
    for (const problem of problems) {
      console.log(problem.pluginPath);
      for (const error of problem.errors ?? []) {
        console.log(`  - ${error}`);
      }
      console.log("");
    }
  }
}

async function runPlugin(
  pluginId: string,
  operation: string,
  argsJson?: string,
): Promise<void> {
  let args: unknown[] = [];
  if (argsJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsJson);
    } catch {
      console.error(
        "Invalid arguments: expected JSON — an array of arguments, e.g. [\"query\"], or a single value, e.g. \"query\"",
      );
      process.exitCode = 1;
      return;
    }
    args = Array.isArray(parsed) ? parsed : [parsed];
  }

  const pluginsDir = path.resolve("plugins");
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

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "run") {
    const [pluginId, operation, argsJson] = rest;
    if (!pluginId || !operation) {
      console.error("Usage: cli run <pluginId> <operation> [jsonArgs]");
      process.exitCode = 1;
      return;
    }
    await runPlugin(pluginId, operation, argsJson);
    return;
  }

  // Default (and explicit "list"): list plugins. "list" may be omitted.
  const listDir = command === "list" ? rest[0] : command;
  await listPlugins(listDir);
}

void main();
