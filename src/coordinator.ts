/**
 * PluginCoordinator — run a capability across MANY plugins and merge the
 * results.
 *
 * Why this exists: the runtime executes ONE capability on ONE plugin
 * (operations on a single plugin are serialized on purpose — see
 * `LoadedPluginHandle.queue`). A media application does the opposite of
 * that: for one title it wants every installed source plugin queried at
 * once, then a single merged, ranked, deduplicated list. That fan-out
 * policy is what this module owns.
 *
 * Design rules (mirroring the engine's existing ones):
 *
 * - **Isolation.** One plugin's failure never fails the aggregate. Every
 *   plugin gets its own structured outcome; the caller sees successes,
 *   failures, and timings side by side.
 * - **Bounded concurrency.** Plugins are executed with at most
 *   `concurrency` in flight, because each plugin has its own QuickJS
 *   instance and Wasm heap; unbounded fan-out across 200 installed
 *   plugins would be a self-inflicted DoS.
 * - **Determinism.** Outcomes are returned in the caller's plugin order
 *   regardless of completion order, and merged results are sorted by an
 *   explicit, documented ranking — so tests and UIs are stable.
 * - **Untrusted input.** Every successful plugin value still goes through
 *   `normalizeSourceResults`; the coordinator never trusts raw output.
 * - **Host-side only.** This module performs no I/O and executes no
 *   guest code itself — it delegates to the runtime.
 */
import { normalizeSourceResults } from "./results.js";
import type { SourceResult } from "./results.js";
import type {
  LoadedPlugin,
  PluginExecutionResult,
  PluginRuntimeError,
} from "./types.js";

/**
 * The minimal runtime surface the coordinator needs. `PluginRuntime`
 * satisfies it structurally; tests can substitute a stub to observe
 * scheduling without starting QuickJS.
 */
export interface PluginExecutor {
  execute(
    plugin: LoadedPlugin,
    operation: string,
    args?: readonly unknown[],
  ): Promise<PluginExecutionResult>;
}

/** Outcome of running one capability on one plugin. */
export interface PluginRunOutcome {
  pluginId: string;
  ok: boolean;
  /** Present when `ok` — the guest's raw return value. */
  value?: unknown;
  /** Present when `!ok` — the structured runtime error. */
  error?: PluginRuntimeError;
  /** Measured wall-clock time for this plugin's operation. */
  executionTimeMs: number;
  /**
   * When this plugin's value passed through normalizeSourceResults:
   * how many results it contributed AFTER validation, and the
   * normalization error when it failed validation.
   */
  normalized?: {
    count: number;
    error?: { code: string; message: string };
  };
}

/** Aggregate statistics for one fan-out run. */
export interface FanOutStats {
  pluginsRun: number;
  pluginsSucceeded: number;
  pluginsFailed: number;
  /** Results contributed per plugin, in `outcomes` order. */
  resultsPerPlugin: number[];
  /** Results dropped because an identical canonical URL was already kept. */
  duplicatesRemoved: number;
  /** Number of results in the merged list. */
  totalResults: number;
}

export interface CollectSourcesResult {
  results: SourceResult[];
  outcomes: PluginRunOutcome[];
  stats: FanOutStats;
}

export interface PluginCoordinatorOptions {
  /** Max plugins executing at once. Default 4. */
  concurrency?: number;
  /** Capability name used by `collectSources`. Default "sources". */
  sourcesCapability?: string;
}

/**
 * Ranking weight per quality label. Higher wins. Unknown/absent labels
 * rank lowest but keep their relative order (stable sort).
 */
const QUALITY_RANK: Readonly<Record<string, number>> = {
  "4k": 100,
  "2160p": 98,
  uhd: 96,
  "1440p": 90,
  "1080p": 80,
  fhd: 78,
  "720p": 60,
  hd: 58,
  "576p": 50,
  "480p": 40,
  sd: 38,
  "360p": 30,
  cam: 5,
  ts: 4,
};

/** Score a free-form quality label (0 when unknown). */
export function qualityScore(quality: string | undefined): number {
  if (quality === undefined) return 0;
  const key = quality.trim().toLowerCase();
  if (key.length === 0) return 0;
  const exact = QUALITY_RANK[key];
  if (exact !== undefined) return exact;
  // Numeric forms: "1080", "1080p60", "2160P" → parse the leading number.
  const match = /^(\d{3,4})/.exec(key);
  if (match?.[1] !== undefined) {
    const height = Number(match[1]);
    if (Number.isFinite(height)) return Math.min(99, Math.max(1, height / 24));
  }
  return 0;
}

export class PluginCoordinator {
  private readonly executor: PluginExecutor;
  private readonly concurrency: number;
  private readonly sourcesCapability: string;

  constructor(executor: PluginExecutor, options: PluginCoordinatorOptions = {}) {
    this.executor = executor;
    this.concurrency = Math.max(
      1,
      Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY),
    );
    this.sourcesCapability = options.sourcesCapability ?? "sources";
  }

  /**
   * Run `capability` on every plugin, at most `concurrency` at a time.
   *
   * Outcomes are returned in the SAME ORDER as `plugins`, so callers can
   * zip them with their own metadata. Plugins whose execution throws
   * (should not happen — the runtime returns structured results) are
   * converted into a structured `PLUGIN_RUNTIME_ERROR` outcome rather
   * than propagating.
   *
   * @param signal Optional cancellation. Aborting stops NEW plugins from
   *   starting; in-flight operations are bounded by the runtime's own
   *   deadline and are not force-aborted here.
   */
  async runAll(
    plugins: readonly LoadedPlugin[],
    capability: string,
    args: readonly unknown[] = [],
    signal?: AbortSignal,
  ): Promise<PluginRunOutcome[]> {
    const outcomes: PluginRunOutcome[] = new Array<PluginRunOutcome>(
      plugins.length,
    );
    let next = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= plugins.length) return;
        if (signal?.aborted === true) {
          const plugin = plugins[index];
          outcomes[index] = {
            pluginId: plugin?.pluginId ?? "(unknown)",
            ok: false,
            error: {
              type: "PLUGIN_RUNTIME_ERROR",
              message: "Cancelled before this plugin started",
            },
            executionTimeMs: 0,
          };
          continue;
        }
        const plugin = plugins[index];
        if (plugin === undefined) continue;
        outcomes[index] = await this.runOne(plugin, capability, args);
      }
    };

    const workers: Promise<void>[] = [];
    const width = Math.min(this.concurrency, Math.max(1, plugins.length));
    for (let i = 0; i < width; i += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return outcomes;
  }

  /** Run one capability on one plugin, never throwing. */
  private async runOne(
    plugin: LoadedPlugin,
    capability: string,
    args: readonly unknown[],
  ): Promise<PluginRunOutcome> {
    try {
      const result = await this.executor.execute(plugin, capability, args);
      if (result.success) {
        return {
          pluginId: plugin.pluginId,
          ok: true,
          value: result.value,
          executionTimeMs: result.executionTimeMs,
        };
      }
      return {
        pluginId: plugin.pluginId,
        ok: false,
        error: result.error,
        executionTimeMs: result.executionTimeMs,
      };
    } catch {
      // The runtime returns structured results and does not throw for
      // expected failure modes; anything reaching here is a host-level
      // fault, so the message stays engine-authored.
      return {
        pluginId: plugin.pluginId,
        ok: false,
        error: {
          type: "PLUGIN_RUNTIME_ERROR",
          message: "Plugin execution failed",
        },
        executionTimeMs: 0,
      };
    }
  }

  /**
   * Query every plugin's source capability, normalize each contribution,
   * then merge, deduplicate (by canonical URL, first kept) and rank by
   * quality (highest first, then title, then URL — fully deterministic).
   */
  async collectSources(
    plugins: readonly LoadedPlugin[],
    args: readonly unknown[] = [],
    signal?: AbortSignal,
  ): Promise<CollectSourcesResult> {
    const outcomes = await this.runAll(
      plugins,
      this.sourcesCapability,
      args,
      signal,
    );

    const merged: SourceResult[] = [];
    const seenUrls = new Set<string>();
    const resultsPerPlugin: number[] = [];
    let duplicatesRemoved = 0;

    for (const outcome of outcomes) {
      if (!outcome.ok) {
        resultsPerPlugin.push(0);
        continue;
      }
      const normalized = normalizeSourceResults(outcome.value);
      if (!normalized.ok) {
        outcome.normalized = {
          count: 0,
          error: {
            code: normalized.error.code,
            message: normalized.error.message,
          },
        };
        resultsPerPlugin.push(0);
        continue;
      }
      let kept = 0;
      for (const result of normalized.results) {
        if (seenUrls.has(result.url)) {
          duplicatesRemoved += 1;
          continue;
        }
        seenUrls.add(result.url);
        merged.push(result);
        kept += 1;
      }
      outcome.normalized = { count: kept };
      resultsPerPlugin.push(kept);
    }

    merged.sort((a, b) => {
      const byQuality = qualityScore(b.quality) - qualityScore(a.quality);
      if (byQuality !== 0) return byQuality;
      const byTitle = a.title.localeCompare(b.title);
      if (byTitle !== 0) return byTitle;
      return a.url.localeCompare(b.url);
    });

    const pluginsSucceeded = outcomes.filter((outcome) => outcome.ok).length;
    return {
      results: merged,
      outcomes,
      stats: {
        pluginsRun: outcomes.length,
        pluginsSucceeded,
        pluginsFailed: outcomes.length - pluginsSucceeded,
        resultsPerPlugin,
        duplicatesRemoved,
        totalResults: merged.length,
      },
    };
  }
}

const DEFAULT_CONCURRENCY = 4;
