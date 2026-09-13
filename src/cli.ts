/**
 * Minimal CLI for inspecting installed plugins.
 *
 * Usage: node dist/src/cli.js [pluginsDir]   (npm run plugins:list)
 *
 * Lists plugins loaded from the plugins directory. Plugins that fail
 * discovery or validation are listed under "Problems" instead of aborting
 * the output.
 */
import path from "node:path";
import process from "node:process";

import { PluginManager } from "./manager.js";

const RULE = "─".repeat(24);

async function main(): Promise<void> {
  const pluginsDir = path.resolve(process.argv[2] ?? "plugins");
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

void main();
