/**
 * PluginRuntime — sandboxed execution of plugin JavaScript.
 *
 * Plugins run inside QuickJS, a full JavaScript engine compiled to
 * WebAssembly (via the quickjs-emscripten package). It is a SEPARATE
 * engine from the host Node.js process: the plugin realm contains no
 * Node.js globals, no host objects, and no built-in modules. Plugins
 * communicate with the host exclusively through the controlled
 * PluginContext (manifest + log + http + json + html) and by returning
 * JSON-serializable values.
 *
 * Phase 4 adds the controlled HTTP capability: `context.http.get` /
 * `context.http.getJson` / `context.http.request`. The host functions
 * return guest promises (deferred promises); the actual network I/O
 * happens host-side in HttpClient (src/http.ts) and the settled,
 * validated result is bridged back into the guest. Plugins never touch
 * Node networking directly.
 *
 * Phase 5 adds the JSON and HTML parsing capabilities: `context.json`
 * is a static guest-side source wrapping the guest's native JSON (no
 * host round-trip, parse never evaluates code); `context.html` is
 * host-side on top of htmlparser2 + css-select + dom-serializer
 * (src/phase5.ts), data-only: no script execution, no resource
 * loading, bounded input/node/result limits, structured errors.
 *
 * Isolation model and its limits:
 * - Each loaded plugin gets its own QuickJS runtime (separate heap).
 * - The guest heap is capped (memoryLimitBytes); runaway loops are
 *   interrupted by a deadline (timeoutMs) via QuickJS interrupt hooks.
 * - Module imports are resolved ONLY inside the plugin's own directory;
 *   host/built-in/absolute imports are rejected.
 * - Networking is only possible through context.http, which the engine
 *   validates and bounds (scheme, timeout, size, redirects, headers).
 * - This is in-process, engine-level isolation — NOT an OS-level
 *   security boundary. A plugin is untrusted code constrained by the
 *   engine, not by the operating system. See ARCHITECTURE.md.
 *
 * The runtime never executes plugin code on the host: no eval(), no
 * new Function(), no node:vm.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";
import { createPluginStore, findSetting } from "./store.js";
import type { PluginStore, StoreBackend } from "./store.js";
import { MemoryStoreBackend } from "./store.js";
import type {
  QuickJSContext,
  QuickJSDeferredPromise,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSWASMModule,
} from "quickjs-emscripten";

import { HttpClient, HttpError } from "./http.js";
import type { HttpRequestOptions, HttpErrorObject } from "./http.js";
import {
  PHASE5_JSON_GUEST_SOURCE,
  PHASE5_LIMITS,
  Phase5Error,
  extractHtml,
  parseHtml,
  selectHtml,
} from "./phase5.js";
import type {
  HtmlDocument,
  HtmlElement,
  Phase5ErrorCode,
} from "./phase5.js";
import type {
  LoadedPlugin,
  Plugin,
  PluginLoadResult,
  PluginPermissions,
  PluginRuntimeError,
  PluginRuntimeErrorType,
  PluginRuntimeOptions,
  ResolvedPluginPermissions,
} from "./types.js";
import type { PluginExecutionResult, PluginManifest } from "./types.js";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
/**
 * Concurrent host HTTP requests allowed per plugin. A media-source
 * plugin often wants to fetch several mirrors at once; 8 covers that
 * without letting one plugin open an unbounded number of sockets.
 */
const DEFAULT_MAX_INFLIGHT_PER_PLUGIN = 8;

/** Every capability is enabled unless the host application says otherwise. */
/**
 * Default storage behind `context.store` when the host does not supply a
 * backend: values live for the lifetime of this runtime. A host that
 * wants plugin settings to survive a restart passes its own
 * `StoreBackend` (see src/store.ts).
 */
const DEFAULT_STORE_BACKEND: StoreBackend = new MemoryStoreBackend();

const DEFAULT_PERMISSIONS: ResolvedPluginPermissions = {
  http: true,
  json: true,
  html: true,
  store: true,
};

/** Resolve a (partial) permission set against the safe default. */
function resolvePermissions(
  permissions: PluginPermissions | undefined,
  base: ResolvedPluginPermissions,
): ResolvedPluginPermissions {
  return {
    http: permissions?.http ?? base.http,
    json: permissions?.json ?? base.json,
    html: permissions?.html ?? base.html,
    store: permissions?.store ?? base.store,
  };
}

interface Disposable {
  alive: boolean;
  dispose(): void;
}

/**
 * Track a disposable so it is disposed in the operation's finally block.
 * Returns the item unchanged (typed) for chaining/assignment.
 * unwrapResult() CONSUMES its result (success and error paths), so results
 * passed to it are tracked here but must never be disposed manually after
 * unwrapping — the alive-guarded drain skips already-consumed items.
 */
function track<T extends Disposable>(item: T, list: Disposable[]): T {
  list.push(item);
  return item;
}

/** Thrown internally when the host-side deadline for an awaited promise passes. */
class PluginTimeoutError extends Error {
  constructor() {
    super("Plugin execution exceeded the time limit");
    this.name = "PluginTimeoutError";
  }
}

/**
 * Thrown internally when an operation's abort scope fires while it is
 * awaiting the guest — i.e. the plugin was disposed mid-operation. Without
 * this the awaiting caller would hang until the full execution deadline.
 */
class PluginAbortedError extends Error {
  constructor() {
    super("Plugin operation was aborted");
    this.name = "PluginAbortedError";
  }
}

/** Thrown internally to carry a specific runtime error type + message. */
class RuntimeFailure extends Error {
  constructor(
    readonly type: PluginRuntimeErrorType,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeFailure";
  }
}

/**
 * Host-side handle table backing the apiVersion-2 HTML capability.
 *
 * Documents and elements are stored as ordinary JSON data and addressed
 * by integer handles. Nothing here is guest-visible except the numbers,
 * so the guest can neither inspect host structures nor smuggle a forged
 * document object into the selector engine.
 */
interface HtmlHandleTable {
  next: number;
  documents: Map<number, HtmlDocument>;
  elements: Map<number, HtmlElement>;
  /** Live handle count (documents + elements). */
  size(): number;
}

function createHtmlHandleTable(): HtmlHandleTable {
  const documents = new Map<number, HtmlDocument>();
  const elements = new Map<number, HtmlElement>();
  return {
    next: 1,
    documents,
    elements,
    size: () => documents.size + elements.size,
  };
}

/**
 * One capability call currently in flight on a plugin.
 *
 * `dispose()` needs this: guest handles owned by an unfinished operation
 * must be released BEFORE the context and runtime are freed.
 */
interface ActiveOperation {
  /** Handles created for this operation, disposed in reverse order. */
  tracked: Disposable[];
  /** Aborts the operation's host-side HTTP requests. */
  abort: AbortController;
}

/**
 * Internal handle: the public LoadedPlugin plus the QuickJS resources
 * backing it. Disposing it frees the guest heap.
 */
class LoadedPluginHandle implements LoadedPlugin {
  readonly pluginId: string;
  readonly manifest: PluginManifest;
  readonly capabilities: string[];
  /**
   * Capabilities this host actually granted the plugin (see
   * PluginPermissions). Disabled capabilities are never installed on the
   * context object, so guest code cannot detect or re-enable them.
   */
  readonly permissions: ResolvedPluginPermissions;
  /**
   * The enforced declared-domain allowlist (empty = unrestricted by the
   * gate). Derived from the validated manifest at load time; a plugin
   * cannot influence it afterwards.
   */
  readonly allowedDomains: readonly string[];
  readonly runtime: QuickJSRuntime;
  readonly context: QuickJSContext;
  readonly capabilityFns: Map<string, QuickJSHandle>;
  /**
   * In-flight host HTTP requests owned by this plugin's operations.
   * Aborted when an operation ends or the plugin is disposed, so a
   * cancelled/finished execution never leaves an uncontrolled request
   * running.
   */
  readonly inFlightHttp = new Set<AbortController>();
  /**
   * Number of host HTTP requests this plugin currently has in flight
   * (across all of its operations). Bounded by
   * `maxInFlightPerPlugin`, so a plugin cannot open an unbounded number
   * of sockets by fanning out with `Promise.all`.
   */
  inFlightRequests = 0;
  /**
   * Tail of this plugin's operation queue.
   *
   * Guest operations on ONE plugin sandbox are serialized, and this is a
   * correctness requirement, not a throughput choice:
   *
   * - A QuickJS runtime is single-threaded and has exactly ONE interrupt
   *   handler slot. `execute()` installs a deadline handler on entry and
   *   removes it in `finally`. If two operations overlapped, the first to
   *   finish would remove the handler the other still depended on, and
   *   that operation would then run with NO timeout at all.
   * - Worse, guest code executes synchronously on the host thread, so an
   *   unbounded spin cannot be preempted by anything except that handler.
   *   A plugin that spun after an `await` would block the host event loop
   *   permanently — taking the whole application down, not just itself.
   * - The guest job queue is also shared, so overlapping operations would
   *   run each other's continuations under the wrong deadline.
   *
   * Serializing removes all three races. Different plugins have different
   * runtimes and still execute concurrently.
   */
  queue: Promise<unknown> = Promise.resolve();
  /**
   * Operations currently in flight on this plugin.
   *
   * Disposal must release their guest handles first. `JS_FreeRuntime`
   * asserts that the runtime's GC object list is empty and calls
   * `abort()` if it is not — which tears down the QuickJS Wasm instance
   * from under the host process. Disposing a plugin while one of its
   * capabilities was awaiting an HTTP response used to hit exactly that.
   */
  readonly activeOperations = new Set<ActiveOperation>();
  /** Set when the guest environment has been (or is being) disposed. */
  disposed = false;
  /**
   * Handle table for the apiVersion-2 HTML capability: parsed documents
   * and selected elements live HERE, host-side, and the guest only ever
   * sees numeric handles. Plain JSON data — no QuickJS handles — so
   * disposal needs no ordering guarantees; it is simply cleared when the
   * capability call ends.
   */
  readonly htmlHandles: HtmlHandleTable = createHtmlHandleTable();
  /**
   * This plugin's persistent key-value store (engine 0.4.0+). Values are
   * loaded ONCE at plugin load and held host-side, so `context.store`
   * reads are synchronous and free — no Wasm round trip, no promise tick
   * per read, which is what an async bridge-per-get design costs. Writes
   * are validated in place and persisted once, when the capability call
   * that made them ends.
   */
  readonly store: PluginStore;

  /** The plugin contract revision this plugin declared (1 when absent). */
  get apiVersion(): number {
    return this.manifest.apiVersion ?? 1;
  }

  constructor(
    manifest: PluginManifest,
    capabilities: string[],
    runtime: QuickJSRuntime,
    context: QuickJSContext,
    capabilityFns: Map<string, QuickJSHandle>,
    permissions: ResolvedPluginPermissions,
    allowedDomains: readonly string[],
    storeBackend: StoreBackend,
  ) {
    this.pluginId = manifest.id;
    this.manifest = manifest;
    this.capabilities = capabilities;
    this.runtime = runtime;
    this.context = context;
    this.capabilityFns = capabilityFns;
    this.permissions = permissions;
    this.allowedDomains = allowedDomains;
    this.store = createPluginStore(manifest.id, storeBackend, manifest);
  }

  dispose(): void {
    this.disposed = true;
    // Best-effort final flush: `dispose` is synchronous by contract, so
    // the save is started and its failure logged rather than awaited.
    if (this.store.isDirty) {
      void Promise.resolve()
        .then(() => this.store.persist())
        .catch(() => {
          // A host backend that fails on shutdown is a host problem;
          // there is no operation left to report it to.
        });
    }
    for (const controller of this.inFlightHttp) {
      controller.abort(new Error("plugin disposed"));
    }
    this.inFlightHttp.clear();

    // Release guest handles owned by in-flight operations BEFORE the
    // context/runtime are freed. QuickJS aborts the whole Wasm instance
    // if any guest object is still alive at JS_FreeRuntime time, so this
    // ordering is what makes "dispose a plugin mid-request" safe.
    for (const operation of this.activeOperations) {
      operation.abort.abort(new Error("plugin disposed"));
      // Reverse order: later handles may reference earlier ones.
      for (let i = operation.tracked.length - 1; i >= 0; i--) {
        const item = operation.tracked[i];
        if (item && item.alive) {
          try {
            item.dispose();
          } catch {
            // The guest is already gone; nothing left to release.
          }
        }
      }
      operation.tracked.length = 0;
    }
    this.activeOperations.clear();

    for (const fn of this.capabilityFns.values()) {
      fn.dispose();
    }
    this.capabilityFns.clear();
    // Dispose the context before its runtime.
    this.context.dispose();
    this.runtime.dispose();
  }
}

export class PluginRuntime {
  private module: QuickJSWASMModule | null = null;
  private readonly timeoutMs: number;
  private readonly memoryLimitBytes: number;
  private readonly logger: (pluginId: string, message: string) => void;
  private readonly httpClient: HttpClient;
  private readonly loaded = new Set<LoadedPluginHandle>();
  /** Default capability permissions for plugins without an override. */
  private readonly permissions: ResolvedPluginPermissions;
  private readonly perPluginPermissions: Readonly<Record<string, PluginPermissions>>;
  /**
   * When true (default) a plugin's manifest `domains` are enforced as an
   * HTTP allowlist for that plugin. Host-level switch only.
   */
  private readonly enforceManifestDomains: boolean;
  /** Host-supplied extra domains every plugin may reach. */
  private readonly extraAllowedDomains: readonly string[];
  /** Max concurrent host HTTP requests per plugin (0 = unlimited). */
  private readonly maxInFlightPerPlugin: number;
  /** Storage behind `context.store` for every plugin this runtime loads. */
  private readonly storeBackend: StoreBackend;

  constructor(options: PluginRuntimeOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.memoryLimitBytes = options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES;
    this.logger =
      options.logger ??
      ((pluginId, message) => console.log(`[plugin:${pluginId}] ${message}`));
    this.httpClient = new HttpClient({
      limits: options.http?.limits,
      network: options.http?.network,
      resolver: options.http?.resolver,
    });
    this.permissions = resolvePermissions(options.permissions, DEFAULT_PERMISSIONS);
    this.perPluginPermissions = options.perPluginPermissions ?? {};
    this.enforceManifestDomains = options.http?.enforceManifestDomains ?? true;
    this.extraAllowedDomains = options.http?.extraAllowedDomains ?? [];
    this.maxInFlightPerPlugin =
      options.http?.maxInFlightPerPlugin ?? DEFAULT_MAX_INFLIGHT_PER_PLUGIN;
    this.storeBackend = options.storeBackend ?? DEFAULT_STORE_BACKEND;
  }

  /**
   * Resolve the capability permissions for one plugin: the per-plugin
   * override wins over the runtime default, which wins over "enabled".
   * Host decision only — nothing here is reachable from guest code.
   */
  private permissionsFor(pluginId: string): ResolvedPluginPermissions {
    const override = this.perPluginPermissions[pluginId];
    if (override === undefined) {
      return this.permissions;
    }
    return resolvePermissions(override, this.permissions);
  }

  /**
   * Resolve the enforced declared-domain allowlist for one plugin.
   *
   * Empty means "this gate does not restrict the plugin". The list is
   * the plugin's manifest `domains` plus the host's
   * `extraAllowedDomains`; enforcement can be switched off entirely by
   * the host. Malformed patterns are kept as-is (they simply never
   * match), so a typo fails closed instead of widening access.
   */
  private allowedDomainsFor(manifest: PluginManifest): readonly string[] {
    const hostExtras = this.extraAllowedDomains.filter(
      (domain) => domain.trim().length > 0,
    );
    if (!this.enforceManifestDomains) {
      return [];
    }
    // `mirrors` are alternate hosts for the SAME plugin, so they join
    // the allowlist. They can never widen a plugin's reach beyond hosts
    // it declared in its own manifest, and the host's enforcement switch
    // covers both lists equally.
    const declared = [
      ...(manifest.domains ?? []),
      ...(manifest.mirrors ?? []),
    ].filter((domain) => domain.trim().length > 0);
    return [...new Set([...declared, ...hostExtras])];
  }

  /**
   * Evaluate a plugin's entry module inside a fresh, isolated QuickJS
   * runtime and detect its capabilities.
   *
   * The module's top-level code runs; capability functions do not.
   * Never throws for expected failure modes — returns a structured
   * PluginLoadResult instead.
   */
  async loadPlugin(plugin: Plugin): Promise<PluginLoadResult> {
    const started = performance.now();
    const loadTimeMs = () => performance.now() - started;
    const fail = (error: PluginRuntimeError): PluginLoadResult => ({
      ok: false,
      error,
      loadTimeMs: loadTimeMs(),
    });

    if (!plugin.manifest || !plugin.entryPath) {
      return fail({
        type: "PLUGIN_LOAD_ERROR",
        message: "Plugin is not loaded: missing manifest or entry path",
      });
    }
    // Disabled plugins are never evaluated: the engine refuses at the
    // load boundary so no guest code from a disabled plugin runs at all.
    if (plugin.enabled === false) {
      return fail({
        type: "PLUGIN_DISABLED",
        message: `Plugin '${plugin.manifest.id}' is disabled and will not be loaded`,
      });
    }
    const { manifest, entryPath } = plugin;

    let source: string;
    try {
      source = await readFile(entryPath, "utf8");
    } catch (error) {
      return fail({
        type: "PLUGIN_LOAD_ERROR",
        message: `Cannot read entry file: ${errorMessage(error)}`,
      });
    }

    let runtime: QuickJSRuntime | null = null;
    let context: QuickJSContext | null = null;
    let handle: LoadedPluginHandle | null = null;
    const tracked: Disposable[] = [];
    try {
      const qjs = await this.getModule();
      runtime = qjs.newRuntime({
        memoryLimitBytes: this.memoryLimitBytes,
        moduleLoader: (name: string) =>
          this.loadPluginModule(name, path.dirname(entryPath)),
      });
      context = runtime.newContext();

      // Host-side limit (monotonic clock) and guest-side interrupt
      // deadline (wall-clock: shouldInterruptAfterDeadline compares Date.now()).
      const deadline = performance.now() + this.timeoutMs;
      runtime.setInterruptHandler(
        shouldInterruptAfterDeadline(Date.now() + this.timeoutMs),
      );

      // Evaluate the entry file as an ES module.
      const evalResult = track(
        context.evalCode(source, path.basename(entryPath), { type: "module" }),
        tracked,
      );
      let exportsHandle: QuickJSHandle;
      try {
        exportsHandle = context.unwrapResult(evalResult);
      } catch (error) {
        throw this.classify(error, "PLUGIN_LOAD_ERROR");
      }
      track(exportsHandle, tracked);

      // Top-level await: the module namespace can arrive as a promise.
      const settledExports = await this.settleValue(
        context,
        runtime,
        exportsHandle,
        tracked,
        deadline,
      );
      if (settledExports !== exportsHandle) {
        track(settledExports, tracked);
      }
      exportsHandle = settledExports;

      if (
        context.typeof(exportsHandle) !== "object" ||
        context.dump(exportsHandle) === null
      ) {
        throw new RuntimeFailure(
          "PLUGIN_EXPORT_ERROR",
          "Plugin module must export an object named 'plugin'",
        );
      }

      const pluginExport = track(
        context.getProp(exportsHandle, "plugin"),
        tracked,
      );
      if (context.typeof(pluginExport) === "undefined") {
        throw new RuntimeFailure(
          "PLUGIN_EXPORT_ERROR",
          "Plugin must export an object named 'plugin'",
        );
      }
      if (
        context.typeof(pluginExport) !== "object" ||
        context.dump(pluginExport) === null
      ) {
        throw new RuntimeFailure(
          "PLUGIN_EXPORT_ERROR",
          "The 'plugin' export must be a plain object of capabilities",
        );
      }

      // Detect capabilities: own enumerable function properties.
      const namesResult = track(
        context.getOwnPropertyNames(pluginExport, {
          strings: true,
          onlyEnumerable: true,
        }),
        tracked,
      );
      let names: QuickJSHandle[] & Disposable;
      try {
        names = context.unwrapResult(namesResult);
      } catch (error) {
        throw this.classify(error, "PLUGIN_LOAD_ERROR");
      }
      track(names, tracked);

      const capabilities: string[] = [];
      const capabilityFns = new Map<string, QuickJSHandle>();
      for (const nameHandle of names) {
        const name = context.getString(nameHandle);
        const fn = context.getProp(pluginExport, name);
        if (context.typeof(fn) === "function") {
          capabilities.push(name);
          capabilityFns.set(name, fn); // ownership transferred
        } else {
          fn.dispose();
        }
      }
      capabilities.sort();
      if (capabilities.length === 0) {
        throw new RuntimeFailure(
          "PLUGIN_EXPORT_ERROR",
          "The 'plugin' object must export at least one function capability",
        );
      }

      handle = new LoadedPluginHandle(
        manifest,
        capabilities,
        runtime,
        context,
        capabilityFns,
        this.permissionsFor(manifest.id),
        this.allowedDomainsFor(manifest),
        this.storeBackend,
      );
      // Seed context.store from the host backend before the plugin is
      // reachable. A backend failure is NOT a load failure: the plugin
      // still works, it just starts from its declared defaults rather
      // than from stored values.
      await handle.store.load();
      this.reportStoreError(handle);
      this.loaded.add(handle);
      return { ok: true, plugin: handle, loadTimeMs: loadTimeMs() };
    } catch (error) {
      // Errors classified inside are already structured {type, message}.
      if (isRuntimeErrorShape(error)) {
        return fail(error);
      }
      return fail(this.toRuntimeError(error, "PLUGIN_LOAD_ERROR"));
    } finally {
      runtime?.removeInterruptHandler();
      for (const d of tracked) {
        if (d.alive) d.dispose();
      }
      if (!handle && runtime) {
        // Load failed: free the guest environment (context before runtime).
        context?.dispose();
        runtime.dispose();
      }
    }
  }

  /**
   * Execute a detected capability of a loaded plugin.
   *
   * Capability arguments must be JSON-serializable. The capability
   * receives the arguments first and the controlled PluginContext last.
   * Never throws for expected failure modes.
   */
  async execute(
    plugin: LoadedPlugin,
    operation: string,
    args: readonly unknown[] = [],
  ): Promise<PluginExecutionResult> {
    const started = performance.now();
    const executionTimeMs = () => performance.now() - started;
    const fail = (error: PluginRuntimeError): PluginExecutionResult => ({
      success: false,
      error,
      executionTimeMs: executionTimeMs(),
    });

    const handle = this.loaded.has(plugin as LoadedPluginHandle)
      ? (plugin as LoadedPluginHandle)
      : null;
    if (!handle) {
      return fail({
        type: "PLUGIN_RUNTIME_ERROR",
        message: "LoadedPlugin was not created by this PluginRuntime",
      });
    }

    const fn = handle.capabilityFns.get(operation);
    if (!fn) {
      return fail({
        type: "PLUGIN_CAPABILITY_NOT_FOUND",
        message: `Plugin '${handle.pluginId}' does not expose a capability named '${operation}' (exposes: ${
          handle.capabilities.join(", ") || "none"
        })`,
      });
    }

    // Serialize guest work on this plugin's sandbox — see the
    // LoadedPluginHandle.queue doc comment for why this is a correctness
    // requirement. `executionTimeMs` is measured from BEFORE queueing, so
    // it reports the latency the caller actually experienced.
    const previous = handle.queue;
    const current = previous.then(
      () => this.runOperation(handle, fn, args, executionTimeMs),
      () => this.runOperation(handle, fn, args, executionTimeMs),
    );
    // The queue tail must never reject, otherwise every later operation
    // would inherit a rejected predecessor.
    handle.queue = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  /**
   * Execute one capability call on a plugin whose sandbox is not
   * otherwise busy. Owns the interrupt handler and the operation's HTTP
   * abort scope for the duration of the call.
   */
  private async runOperation(
    handle: LoadedPluginHandle,
    fn: QuickJSHandle,
    args: readonly unknown[],
    executionTimeMs: () => number,
  ): Promise<PluginExecutionResult> {
    const fail = (error: PluginRuntimeError): PluginExecutionResult => ({
      success: false,
      error,
      executionTimeMs: executionTimeMs(),
    });

    if (handle.disposed) {
      return fail({
        type: "PLUGIN_RUNTIME_ERROR",
        message: `Plugin '${handle.pluginId}' was disposed before this operation ran`,
      });
    }

    const context = handle.context;
    const runtime = handle.runtime;
    const tracked: Disposable[] = [];
    // Host-side limit (monotonic clock) and guest-side interrupt
    // deadline (wall-clock: shouldInterruptAfterDeadline compares Date.now()).
    const deadline = performance.now() + this.timeoutMs;
    runtime.setInterruptHandler(
      shouldInterruptAfterDeadline(Date.now() + this.timeoutMs),
    );
    // Cancels this operation's host HTTP requests when the operation
    // ends (success, error, or deadline) so nothing runs uncontrolled.
    const opAbort = new AbortController();
    handle.inFlightHttp.add(opAbort);
    // Registering the operation lets dispose() release these handles
    // before freeing the context/runtime (see LoadedPluginHandle.dispose).
    const operation: ActiveOperation = { tracked, abort: opAbort };
    handle.activeOperations.add(operation);
    try {
      const callArgs: QuickJSHandle[] = [];
      for (const arg of args) {
        callArgs.push(this.jsonToHandle(context, arg, tracked));
      }
      const contextObject = this.buildPluginContext(context, handle, tracked, opAbort);
      callArgs.push(contextObject);

      const callResult = track(
        context.callFunction(fn, context.undefined, ...callArgs),
        tracked,
      );
      let valueHandle: QuickJSHandle;
      try {
        valueHandle = context.unwrapResult(callResult);
      } catch (error) {
        throw this.classify(error, "PLUGIN_RUNTIME_ERROR");
      }
      track(valueHandle, tracked);

      const settled = await this.settleValue(
        context,
        runtime,
        valueHandle,
        tracked,
        deadline,
        opAbort.signal,
      );
      if (settled !== valueHandle) {
        track(settled, tracked);
      }
      // The plugin may have been disposed while this operation was
      // awaiting: dispose() already released `tracked`, so touching the
      // guest now would be a use-after-free. Report it structurally.
      if (handle.disposed || !context.alive) {
        return fail({
          type: "PLUGIN_RUNTIME_ERROR",
          message: `Plugin '${handle.pluginId}' was disposed during this operation`,
        });
      }
      return {
        success: true,
        value: context.dump(settled),
        executionTimeMs: executionTimeMs(),
      };
    } catch (error) {
      // The guest environment went away underneath this operation. That is
      // a normal outcome of a concurrent dispose(), not a host failure.
      if (handle.disposed || !runtime.alive) {
        return fail({
          type: "PLUGIN_RUNTIME_ERROR",
          message: `Plugin '${handle.pluginId}' was disposed during this operation`,
        });
      }
      // Errors classified inside are already structured {type, message}.
      if (isRuntimeErrorShape(error)) {
        return fail(error);
      }
      return fail(this.toRuntimeError(error, "PLUGIN_RUNTIME_ERROR"));
    } finally {
      handle.activeOperations.delete(operation);
      // Persist context.store ONCE per capability call, and only if the
      // plugin actually wrote something. A backend failure never fails
      // the operation (the plugin's work already succeeded); it is
      // reported through the logger instead, and the store stays dirty
      // so the next call tries again.
      if (runtime.alive && handle.store.isDirty) {
        try {
          await handle.store.persist();
        } catch {
          // Already captured on the store; reported just below.
        }
        this.reportStoreError(handle);
      }
      // Handles are scoped to ONE capability call: dropping them here is
      // what makes "stale handle" a structured error instead of a
      // cross-call surprise, and it bounds the table's lifetime.
      handle.htmlHandles.documents.clear();
      handle.htmlHandles.elements.clear();
      if (runtime.alive) {
        runtime.removeInterruptHandler();
      }
      // Abort any HTTP request still in flight for this operation.
      opAbort.abort(new Error("operation ended"));
      handle.inFlightHttp.delete(opAbort);
      // dispose() may already have released these (it clears the array),
      // and `alive` guards against a double free.
      for (const d of tracked) {
        if (d.alive) {
          try {
            d.dispose();
          } catch {
            // Guest already torn down by a concurrent dispose().
          }
        }
      }
    }
  }

  /** Dispose one loaded plugin's guest environment. */
  dispose(plugin: LoadedPlugin): boolean {
    const handle = plugin as LoadedPluginHandle;
    if (!this.loaded.has(handle)) {
      return false;
    }
    this.loaded.delete(handle);
    handle.dispose();
    return true;
  }

  /** Dispose every loaded plugin. Safe to call multiple times. */
  shutdown(): void {
    for (const handle of [...this.loaded]) {
      this.dispose(handle);
    }
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private async getModule(): Promise<QuickJSWASMModule> {
    if (!this.module) {
      this.module = await getQuickJS();
    }
    return this.module;
  }

  /**
   * Await a guest value that may be a promise. Pump the guest microtask
   * queue under the deadline and bridge the promise to a host promise.
   * Returns the original handle for non-promises, or a new handle for
   * the settled value.
   */
  private async settleValue(
    context: QuickJSContext,
    runtime: QuickJSRuntime,
    valueHandle: QuickJSHandle,
    tracked: Disposable[],
    deadline: number,
    signal?: AbortSignal,
  ): Promise<QuickJSHandle> {
    const state = context.getPromiseState(valueHandle);
    if (state.type !== "pending") {
      let result: QuickJSHandle;
      try {
        result = context.unwrapResult(state);
      } catch (error) {
        throw this.classify(error, "PLUGIN_RUNTIME_ERROR");
      }
      track(result, tracked);
      return result;
    }

    const hostPromise = context.resolvePromise(valueHandle);
    this.pumpJobs(runtime, tracked, deadline);
    let settled;
    try {
      settled = await this.withDeadline(hostPromise, deadline, signal);
    } catch (error) {
      throw this.classify(error, "PLUGIN_TIMEOUT");
    }
    this.pumpJobs(runtime, tracked, deadline);

    // The await above is the point where a concurrent dispose() can land.
    // Check BEFORE touching the guest: unwrapping on a freed context
    // aborts the Wasm instance rather than throwing a catchable error.
    if (!context.alive || !runtime.alive) {
      throw new RuntimeFailure(
        "PLUGIN_RUNTIME_ERROR",
        "Plugin environment was disposed during this operation",
      );
    }

    let result: QuickJSHandle;
    try {
      result = context.unwrapResult(settled);
    } catch (error) {
      throw this.classify(error, "PLUGIN_RUNTIME_ERROR");
    }
    track(result, tracked);
    return result;
  }

  /** Run guest microtasks/jobs until the queue is empty or the deadline passes. */
  private pumpJobs(
    runtime: QuickJSRuntime,
    tracked: Disposable[],
    deadline: number,
  ): void {
    // `runtime.alive` guard: a concurrent dispose() may have freed the
    // runtime while this operation was awaiting, and touching a freed
    // QuickJS runtime aborts the Wasm instance.
    while (runtime.alive && runtime.hasPendingJob() && performance.now() < deadline) {
      const jobs = track(runtime.executePendingJobs(), tracked);
      if (jobs.error !== undefined) {
        // Surface the job's exception (throws a native error).
        jobs.error.context.unwrapResult(jobs);
      }
    }
  }

  /**
   * Race a host promise against the operation deadline.
   *
   * The timer is intentionally NOT unref'd: while awaiting a guest
   * promise that never settles, the timer is the only thing keeping
   * the process event loop alive (an abandoned host promise and
   * unref'd timers would let the process exit mid-operation). It is
   * cleared as soon as the race settles so completed operations never
   * delay process shutdown.
   */
  private withDeadline<T>(
    promise: Promise<T>,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const remaining = Math.max(0, deadline - performance.now());
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new PluginTimeoutError());
      }, remaining);
      // An abort (plugin disposed / operation torn down) must settle the
      // race IMMEDIATELY; otherwise the guest promise can never settle
      // again and the caller would wait out the whole deadline.
      const onAbort = () => {
        cleanup();
        reject(new PluginAbortedError());
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  /** Convert a host JSON value into a guest value (JSON literal eval). */
  private jsonToHandle(
    context: QuickJSContext,
    value: unknown,
    tracked: Disposable[],
  ): QuickJSHandle {
    if (value === undefined) {
      return context.undefined;
    }
    let json: string;
    try {
      json = JSON.stringify(value);
    } catch {
      throw new RuntimeFailure(
        "PLUGIN_RUNTIME_ERROR",
        "Plugin arguments must be JSON-serializable",
      );
    }
    if (json === undefined) {
      throw new RuntimeFailure(
        "PLUGIN_RUNTIME_ERROR",
        "Plugin arguments must be JSON-serializable",
      );
    }
    // Parenthesize: an object/array JSON literal is a syntax error as a
    // bare statement (parsed as a block), but not as an expression.
    const result = track(
      context.evalCode(`(${json})`, "argument", { type: "global" }),
      tracked,
    );
    try {
      return context.unwrapResult(result);
    } catch (error) {
      throw this.classify(error, "PLUGIN_RUNTIME_ERROR");
    }
  }

  /** Build the controlled PluginContext object for one capability call. */
  private buildPluginContext(
    context: QuickJSContext,
    handle: LoadedPluginHandle,
    tracked: Disposable[],
    opAbort: AbortController,
  ): QuickJSHandle {
    const contextObject = track(context.newObject(), tracked);
    const manifestHandle = this.jsonToHandle(context, handle.manifest, tracked);
    const logFn = context.newFunction("log", (...logArgs: QuickJSHandle[]) => {
      const parts: string[] = [];
      for (const arg of logArgs) {
        const kind = context.typeof(arg);
        if (kind === "string") {
          parts.push(context.getString(arg));
        } else if (kind === "number") {
          parts.push(String(context.getNumber(arg)));
        } else if (kind === "boolean") {
          parts.push(String(context.dump(arg)));
        } else {
          const dumped = context.dump(arg);
          try {
            parts.push(JSON.stringify(dumped) ?? String(dumped));
          } catch {
            parts.push(String(dumped));
          }
        }
      }
      this.logger(handle.pluginId, parts.join(" "));
    });
    track(logFn, tracked);

    context.setProp(contextObject, "manifest", manifestHandle);
    context.setProp(contextObject, "log", logFn);

    // context.store — engine 0.4.0. Per-plugin persistent key-value
    // storage, bridged SYNCHRONOUSLY: the host-side map is already in
    // memory, so `get`/`keys`/`all` cost a function call rather than a
    // promise round trip, and `set` writes in place. The whole store is
    // persisted once, when this capability call ends. Absent entirely
    // when the host disabled the store capability.
    if (handle.permissions.store) {
      const storeObject = track(context.newObject(), tracked);
      const storeGet = track(
        context.newFunction("get", (...args: QuickJSHandle[]) => {
          const key = this.readString(context, args[0]);
          if (key === null) return context.undefined;
          const fallback = this.readValue(context, args[1]);
          const value = handle.store.get(key, fallback);
          if (value === undefined) return context.undefined;
          return this.jsonToHandle(context, value, tracked);
        }),
        tracked,
      );
      const storeSet = track(
        context.newFunction("set", (...args: QuickJSHandle[]) => {
          const key = this.readString(context, args[0]);
          if (key === null) {
            return this.phase5Rejected(
              handle,
              "STORE_INVALID_KEY",
              "context.store.set requires a string key",
              tracked,
            );
          }
          // Guest functions are refused EXPLICITLY: `dump()` renders a
          // function as its own source text, so without this guard
          // `store.set("f", () => 1)` would quietly store the STRING
          // "() => 1" and read back as text.
          if (args[1] !== undefined && context.typeof(args[1]) === "function") {
            return this.phase5Rejected(
              handle,
              "STORE_INVALID_VALUE",
              "Functions cannot be stored (the value would be kept as source text)",
              tracked,
            );
          }
          const value = this.readValue(context, args[1]);
          // A mirror setting may only hold one of the manifest's declared
          // mirrors; anything else is refused rather than stored, so the
          // engine never hands a plugin a base URL it would then refuse at
          // the HTTP layer.
          const mirrorProblem = this.checkMirrorSetting(handle, key, value);
          if (mirrorProblem) {
            return this.phase5Rejected(
              handle,
              "STORE_INVALID_VALUE",
              mirrorProblem,
              tracked,
            );
          }
          const result = handle.store.set(key, value);
          if (!result.ok) {
            return this.phase5Rejected(
              handle,
              result.error.code,
              result.error.message,
              tracked,
            );
          }
          return context.true;
        }),
        tracked,
      );
      const storeDelete = track(
        context.newFunction("delete", (...args: QuickJSHandle[]) => {
          const key = this.readString(context, args[0]);
          if (key === null) return context.false;
          return handle.store.delete(key) ? context.true : context.false;
        }),
        tracked,
      );
      const storeHas = track(
        context.newFunction("has", (...args: QuickJSHandle[]) => {
          const key = this.readString(context, args[0]);
          if (key === null) return context.false;
          return handle.store.has(key) ? context.true : context.false;
        }),
        tracked,
      );
      const storeKeys = track(
        context.newFunction("keys", () =>
          this.jsonToHandle(context, handle.store.keys(), tracked),
        ),
        tracked,
      );
      const storeAll = track(
        context.newFunction("all", () =>
          this.jsonToHandle(context, handle.store.all(), tracked),
        ),
        tracked,
      );
      context.setProp(storeObject, "get", storeGet);
      context.setProp(storeObject, "set", storeSet);
      context.setProp(storeObject, "delete", storeDelete);
      context.setProp(storeObject, "has", storeHas);
      context.setProp(storeObject, "keys", storeKeys);
      context.setProp(storeObject, "all", storeAll);
      context.setProp(contextObject, "store", storeObject);
    }

    // context.http — the ONLY network surface a plugin has. Absent
    // entirely when the host disabled the http capability: a disabled
    // capability is not "a function that throws", it does not exist.
    if (handle.permissions.http) {
      const httpObject = track(context.newObject(), tracked);
      const getFn = track(
        context.newFunction("get", (...callArgs: QuickJSHandle[]) =>
          this.startHttpCall(handle, "get", callArgs, opAbort, tracked),
        ),
        tracked,
      );
      const getJsonFn = track(
        context.newFunction("getJson", (...callArgs: QuickJSHandle[]) =>
          this.startHttpCall(handle, "getJson", callArgs, opAbort, tracked),
        ),
        tracked,
      );
      const requestFn = track(
        context.newFunction("request", (...callArgs: QuickJSHandle[]) =>
          this.startHttpCall(handle, "request", callArgs, opAbort, tracked),
        ),
        tracked,
      );
      context.setProp(httpObject, "get", getFn);
      context.setProp(httpObject, "getJson", getJsonFn);
      context.setProp(httpObject, "request", requestFn);
      context.setProp(contextObject, "http", httpObject);
    }

    // context.json — Phase 5. The implementation is a STATIC guest-side
    // source (no plugin data, no host identifiers) wrapping the guest's
    // native JSON. It throws structured { code, message } objects on
    // failure. No value crosses the Wasm boundary for JSON work.
    // Not evaluated at all when the capability is disabled.
    if (handle.permissions.json) {
      const jsonEvalResult = track(
        context.evalCode(PHASE5_JSON_GUEST_SOURCE, "phase5-json", {
          type: "global",
        }),
        tracked,
      );
      const jsonObject = context.unwrapResult(jsonEvalResult);
      track(jsonObject, tracked);
      context.setProp(contextObject, "json", jsonObject);
    }

    // context.html — Phase 5. Host-bridged synchronous functions: the
    // work (parse/select/serialize) happens host-side in src/phase5.ts.
    // Two implementations, chosen by the plugin's declared apiVersion:
    //   - v1 (apiVersion 1 / absent): the document TREE crosses the
    //     boundary in both directions (unchanged since Phase 5).
    //   - v2 (apiVersion >= 2): only numeric handles cross; the tree
    //     stays in this process. Same guarantees, much less boundary
    //     traffic, and no ~500-level nesting limit.
    // Failures return a rejected promise carrying a structured
    // { code, message } object in both modes.
    if (handle.permissions.html) {
      const htmlObject = track(context.newObject(), tracked);
      const useHandles = handle.apiVersion >= 2;
      const htmlParseFn = track(
        context.newFunction("parse", (...args: QuickJSHandle[]) =>
          useHandles
            ? this.phase5ParseV2(handle, args[0], tracked)
            : this.phase5Parse(handle, args[0], tracked),
        ),
        tracked,
      );
      const htmlSelectFn = track(
        context.newFunction("select", (...args: QuickJSHandle[]) =>
          useHandles
            ? this.phase5SelectV2(handle, args[0], args[1], tracked)
            : this.phase5Select(handle, args[0], args[1], tracked),
        ),
        tracked,
      );
      const htmlExtractFn = track(
        context.newFunction("extract", (...args: QuickJSHandle[]) =>
          useHandles
            ? this.phase5ExtractV2(handle, args[0], tracked)
            : this.phase5Extract(handle, args[0], tracked),
        ),
        tracked,
      );
      context.setProp(htmlObject, "parse", htmlParseFn);
      context.setProp(htmlObject, "select", htmlSelectFn);
      context.setProp(htmlObject, "extract", htmlExtractFn);
      context.setProp(contextObject, "html", htmlObject);
    }

    return contextObject;
  }

  // ------------------------------------------------------------------
  // apiVersion 2: handle-based HTML capability
  // ------------------------------------------------------------------

  /** Store a document/element and return its handle, or throw Phase5Error. */
  private storeHtmlHandle(
    handle: LoadedPluginHandle,
    value: HtmlDocument | HtmlElement,
  ): number {
    const table = handle.htmlHandles;
    if (table.size() >= PHASE5_LIMITS.maxHtmlHandles) {
      throw new Phase5Error(
        "HTML_HANDLE_LIMIT",
        `html handles per call are limited to ${PHASE5_LIMITS.maxHtmlHandles}`,
      );
    }
    const id = table.next;
    table.next += 1;
    if (value.type === "document") {
      table.documents.set(id, value);
    } else {
      table.elements.set(id, value);
    }
    return id;
  }

  /** Read a numeric handle argument (non-numbers yield null). */
  private readHandleArg(
    context: QuickJSContext,
    arg: QuickJSHandle | undefined,
  ): number | null {
    if (arg === undefined) return null;
    if (context.typeof(arg) !== "number") return null;
    const value = context.getNumber(arg);
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  /**
   * Settle a structured Phase 5 error for the handle API. `handle` is
   * optional so the same helper serves `HTML_STALE_HANDLE`.
   */
  private phase5V2Rejected(
    handle: LoadedPluginHandle,
    code: Phase5ErrorCode,
    message: string,
    tracked: Disposable[],
  ): QuickJSHandle {
    return this.phase5Rejected(handle, code, message, tracked);
  }

  /** v2 `html.parse(html)` → numeric document handle. */
  private phase5ParseV2(
    handle: LoadedPluginHandle,
    arg: QuickJSHandle | undefined,
    tracked: Disposable[],
  ): QuickJSHandle {
    const context = handle.context;
    if (arg === undefined || context.typeof(arg) !== "string") {
      return this.phase5V2Rejected(
        handle,
        "HTML_INVALID_INPUT",
        "html.parse() requires a string",
        tracked,
      );
    }
    const html = context.getString(arg);
    if (Buffer.byteLength(html, "utf8") > PHASE5_LIMITS.maxHtmlBytes) {
      return this.phase5V2Rejected(
        handle,
        "HTML_INPUT_TOO_LARGE",
        "HTML input exceeds 5 MiB",
        tracked,
      );
    }
    try {
      const document = parseHtml(html);
      return this.jsonToHandle(context, this.storeHtmlHandle(handle, document), tracked);
    } catch (error) {
      return this.phase5V2Rejected(
        handle,
        error instanceof Phase5Error ? error.code : "HTML_PARSE_ERROR",
        error instanceof Phase5Error ? error.message : "HTML parsing failed",
        tracked,
      );
    }
  }

  /** v2 `html.select(documentHandle, selector)` → numeric element handles. */
  private phase5SelectV2(
    handle: LoadedPluginHandle,
    documentArg: QuickJSHandle | undefined,
    selectorArg: QuickJSHandle | undefined,
    tracked: Disposable[],
  ): QuickJSHandle {
    const context = handle.context;
    const documentId = this.readHandleArg(context, documentArg);
    if (documentId === null) {
      return this.phase5V2Rejected(
        handle,
        "HTML_SELECT_ERROR",
        "html.select() requires a document handle from html.parse()",
        tracked,
      );
    }
    if (selectorArg === undefined || context.typeof(selectorArg) !== "string") {
      return this.phase5V2Rejected(
        handle,
        "HTML_INVALID_SELECTOR",
        "html.select() requires a non-empty selector string",
        tracked,
      );
    }
    const root =
      handle.htmlHandles.documents.get(documentId) ??
      handle.htmlHandles.elements.get(documentId);
    if (root === undefined) {
      return this.phase5V2Rejected(
        handle,
        "HTML_STALE_HANDLE",
        "html handle is expired or unknown (handles are valid for one capability call)",
        tracked,
      );
    }
    try {
      const matches = selectHtml(root, context.getString(selectorArg));
      const ids = matches.map((element) => this.storeHtmlHandle(handle, element));
      return this.jsonToHandle(context, ids, tracked);
    } catch (error) {
      return this.phase5V2Rejected(
        handle,
        error instanceof Phase5Error ? error.code : "HTML_SELECT_ERROR",
        error instanceof Phase5Error ? error.message : "HTML selection failed",
        tracked,
      );
    }
  }

  /** v2 `html.extract(elementHandle)` → info object. */
  private phase5ExtractV2(
    handle: LoadedPluginHandle,
    arg: QuickJSHandle | undefined,
    tracked: Disposable[],
  ): QuickJSHandle {
    const context = handle.context;
    const elementId = this.readHandleArg(context, arg);
    if (elementId === null) {
      return this.phase5V2Rejected(
        handle,
        "HTML_INVALID_ELEMENT",
        "html.extract() requires an element handle from html.select()",
        tracked,
      );
    }
    const element = handle.htmlHandles.elements.get(elementId);
    if (element === undefined) {
      return this.phase5V2Rejected(
        handle,
        "HTML_STALE_HANDLE",
        "html handle is expired or unknown (handles are valid for one capability call)",
        tracked,
      );
    }
    try {
      return this.jsonToHandle(context, extractHtml(element), tracked);
    } catch (error) {
      return this.phase5V2Rejected(
        handle,
        error instanceof Phase5Error ? error.code : "HTML_EXTRACT_ERROR",
        error instanceof Phase5Error ? error.message : "HTML extraction failed",
        tracked,
      );
    }
  }

  /**
   * Settle a Phase 5 HTML failure: return a handle to a REJECTED PROMISE
   * carrying the structured { code, message } object. The guest awaits
   * it (or the capability's unhandled rejection surfaces to the host as
   * a structured PLUGIN_RUNTIME_ERROR, same path as HTTP errors).
   */
  /**
   * Reads a guest argument as a string, or `null` when it is absent or of
   * another type. Used by `context.store` for keys, where "not a string"
   * must become a structured refusal rather than a node-style coercion.
   */
  /**
   * Reports a store backend failure to the host ONCE (the store hands it
   * over and clears it), so a broken disk does not produce a log line per
   * operation while still never being silent.
   */
  private reportStoreError(handle: LoadedPluginHandle): void {
    const error = handle.store.takeLastError();
    if (error) {
      this.logger(handle.pluginId, `${error.code}: ${error.message}`);
    }
  }

  /** Dumps a guest argument into host data, or undefined when absent. */
  private readValue(
    context: QuickJSContext,
    arg: QuickJSHandle | undefined,
  ): unknown {
    return arg === undefined ? undefined : context.dump(arg);
  }

  private readString(
    context: QuickJSContext,
    arg: QuickJSHandle | undefined,
  ): string | null {
    if (arg === undefined) return null;
    try {
      if (context.typeof(arg) !== "string") return null;
      return context.getString(arg);
    } catch {
      return null;
    }
  }

  /**
   * Applies the type rules of a DECLARED setting to a write.
   *
   * Only `mirror` needs one at write time: its value must be one of the
   * manifest's declared mirrors. Refusing it here means a plugin can
   * never read back a base URL that the HTTP layer would then reject, and
   * a user's stored choice cannot point the plugin somewhere its own
   * manifest did not declare. Returns a message when the write must be
   * refused.
   */
  private checkMirrorSetting(
    handle: LoadedPluginHandle,
    key: string,
    value: unknown,
  ): string | null {
    const setting = findSetting(handle.manifest.settings, key);
    if (!setting) return null;
    if (setting.type !== "mirror") return null;
    const mirrors = handle.manifest.mirrors ?? [];
    if (typeof value !== "string" || !mirrors.includes(value)) {
      return `Setting '${key}' must be one of this plugin's declared mirrors: ${mirrors.join(", ")}`;
    }
    return null;
  }

  /**
   * Builds a REJECTED promise carrying a structured `{ code, message }`
   * object — the error contract shared by every capability that reports
   * failures asynchronously rather than by throwing.
   *
   * The code is a plain string here (not one of the HTML unions) because
   * more than one capability answers with this shape; each caller passes
   * a code from its own documented set.
   */
  private phase5Rejected(
    handle: LoadedPluginHandle,
    code: string,
    message: string,
    tracked: Disposable[],
  ): QuickJSHandle {
    const context = handle.context;
    const deferred = track(context.newPromise(), tracked);
    const errorHandle = this.jsonToHandle(
      context,
      { code, message },
      tracked,
    );
    deferred.reject(errorHandle);
    errorHandle.dispose();
    // The deferred (and its resolvers) is released by the tracked drain;
    // the framework owns the promise handle.
    return deferred.handle;
  }

  private phase5Parse(
    handle: LoadedPluginHandle,
    arg: QuickJSHandle | undefined,
    tracked: Disposable[],
  ): QuickJSHandle {
    const context = handle.context;
    if (arg === undefined || context.typeof(arg) !== "string") {
      return this.phase5Rejected(
        handle,
        "HTML_INVALID_INPUT",
        "html.parse() requires a string",
        tracked,
      );
    }
    const html = context.getString(arg);
    if (Buffer.byteLength(html, "utf8") > PHASE5_LIMITS.maxHtmlBytes) {
      return this.phase5Rejected(
        handle,
        "HTML_INPUT_TOO_LARGE",
        "HTML input exceeds 5 MiB",
        tracked,
      );
    }
    try {
      return this.jsonToHandle(context, parseHtml(html), tracked);
    } catch (error) {
      // Only engine-controlled text crosses the boundary: Phase5Error
      // messages are engine-authored, and anything unexpected is mapped
      // to a fixed safe message (host details never reach the guest).
      // A RangeError here means the document is deeper than the sandbox
      // value-delivery boundary (~500 levels, a QuickJS evaluator limit).
      return this.phase5Rejected(
        handle,
        error instanceof Phase5Error ? error.code : "HTML_PARSE_ERROR",
        error instanceof Phase5Error
          ? error.message
          : error instanceof RangeError
            ? "HTML structure is too deep for the sandbox (depth limit is about 500 nesting levels)"
            : "HTML parsing failed",
        tracked,
      );
    }
  }

  private phase5Select(
    handle: LoadedPluginHandle,
    docArg: QuickJSHandle | undefined,
    selArg: QuickJSHandle | undefined,
    tracked: Disposable[],
  ): QuickJSHandle {
    const context = handle.context;
    if (
      docArg === undefined ||
      selArg === undefined ||
      context.typeof(selArg) !== "string"
    ) {
      return this.phase5Rejected(
        handle,
        "HTML_INVALID_SELECTOR",
        "html.select(document, selector) requires a selector string",
        tracked,
      );
    }
    let root: unknown;
    try {
      root = context.dump(docArg);
    } catch (error) {
      return this.phase5Rejected(
        handle,
        "HTML_SELECT_ERROR",
        error instanceof RangeError
          ? "HTML structure is too deep to select"
          : "document argument is not JSON-serializable",
        tracked,
      );
    }
    try {
      return this.jsonToHandle(
        context,
        selectHtml(root, context.getString(selArg)),
        tracked,
      );
    } catch (error) {
      return this.phase5Rejected(
        handle,
        error instanceof Phase5Error ? error.code : "HTML_SELECT_ERROR",
        error instanceof Phase5Error
          ? error.message
          : error instanceof RangeError
            ? "HTML structure is too deep to select"
            : "HTML selection failed",
        tracked,
      );
    }
  }

  private phase5Extract(
    handle: LoadedPluginHandle,
    elementArg: QuickJSHandle | undefined,
    tracked: Disposable[],
  ): QuickJSHandle {
    const context = handle.context;
    if (elementArg === undefined) {
      return this.phase5Rejected(
        handle,
        "HTML_INVALID_ELEMENT",
        "html.extract() requires an element",
        tracked,
      );
    }
    let element: unknown;
    try {
      element = context.dump(elementArg);
    } catch (error) {
      return this.phase5Rejected(
        handle,
        "HTML_EXTRACT_ERROR",
        error instanceof RangeError
          ? "HTML element is too deep to extract"
          : "element argument is not JSON-serializable",
        tracked,
      );
    }
    try {
      return this.jsonToHandle(context, extractHtml(element), tracked);
    } catch (error) {
      return this.phase5Rejected(
        handle,
        error instanceof Phase5Error ? error.code : "HTML_EXTRACT_ERROR",
        error instanceof Phase5Error
          ? error.message
          : error instanceof RangeError
            ? "HTML element is too deep to extract"
            : "HTML extraction failed",
        tracked,
      );
    }
  }

  /**
   * Synchronous entry point for a guest `context.http.*` call.
   *
   * Reads the guest arguments, creates a guest promise (deferred),
   * schedules the host-side HTTP work, and returns the promise handle.
   * quickjs-emscripten host functions must be synchronous (the sync
   * Wasm variant has no asyncify), so all argument reading happens here
   * and the network I/O runs later on the event loop.
   */
  private startHttpCall(
    handle: LoadedPluginHandle,
    operation: "get" | "getJson" | "request",
    callArgs: QuickJSHandle[],
    opAbort: AbortController,
    tracked: Disposable[],
  ): QuickJSHandle {
    const context = handle.context;
    const deferred = track(context.newPromise(), tracked);

    let request: { url: string; options: HttpRequestOptions } | undefined;
    let invalid: HttpErrorObject | undefined;

    const readOptions = (h: QuickJSHandle | undefined): Record<string, unknown> | undefined => {
      if (h === undefined) {
        return undefined;
      }
      const kind = context.typeof(h);
      if (kind === "undefined" || kind === "null") {
        return undefined;
      }
      if (kind !== "object") {
        invalid = {
          code: "HTTP_INVALID_REQUEST",
          message: "HTTP options must be a plain object",
        };
        return undefined;
      }
      const dumped = context.dump(h);
      if (typeof dumped !== "object" || dumped === null || Array.isArray(dumped)) {
        invalid = {
          code: "HTTP_INVALID_REQUEST",
          message: "HTTP options must be a plain object",
        };
        return undefined;
      }
      return dumped as Record<string, unknown>;
    };

    if (invalid === undefined) {
      if (operation === "get" || operation === "getJson") {
        const urlArg = callArgs[0];
        if (urlArg === undefined || context.typeof(urlArg) !== "string") {
          invalid = {
            code: "HTTP_INVALID_REQUEST",
            message: `${operation}(url) requires a URL string as its first argument`,
          };
        } else {
          const url = context.getString(urlArg);
          const options = readOptions(callArgs[1]);
          if (invalid === undefined) {
            if (options !== undefined && "url" in options) {
              invalid = {
                code: "HTTP_INVALID_REQUEST",
                message: `${operation}(url, options) takes the URL as its first argument; 'options.url' is not allowed`,
              };
            } else if (options !== undefined && "method" in options) {
              invalid = {
                code: "HTTP_INVALID_REQUEST",
                message: `${operation}() is always GET; use request() to choose a method`,
              };
            } else {
              request = { url, options: options ?? {} };
            }
          }
        }
      } else {
        const options = readOptions(callArgs[0]);
        if (invalid === undefined) {
          if (options === undefined) {
            invalid = {
              code: "HTTP_INVALID_REQUEST",
              message: "request(options) requires an options object with a 'url'",
            };
          } else if (typeof options.url !== "string") {
            invalid = {
              code: "HTTP_INVALID_REQUEST",
              message: "request(options) requires 'options.url' to be a string",
            };
          } else {
            request = { url: options.url, options: options as HttpRequestOptions };
          }
        }
      }
    }

    // Per-plugin in-flight cap: a plugin fanning out with Promise.all
    // can otherwise open an unbounded number of host sockets. The
    // rejected promise is structured, so `Promise.allSettled`-style
    // plugin code degrades gracefully instead of failing wholesale.
    if (
      request !== undefined &&
      this.maxInFlightPerPlugin > 0 &&
      handle.inFlightRequests >= this.maxInFlightPerPlugin
    ) {
      request = undefined;
      invalid = {
        code: "HTTP_TOO_MANY_REQUESTS",
        message: `Plugin already has ${this.maxInFlightPerPlugin} HTTP requests in flight; the engine limit is ${this.maxInFlightPerPlugin}`,
      };
    }

    // Schedule the host-side work. The promise is always settled (or the
    // operation ends first, which aborts the request and drains the
    // guest), so the guest never sees an unhandled rejection.
    if (request !== undefined) {
      handle.inFlightRequests += 1;
      void this.finishHttpCall(handle, deferred, operation, request, opAbort.signal)
        .catch(() => {
          // finishHttpCall never rejects; this is a defensive guard.
        })
        .finally(() => {
          handle.inFlightRequests -= 1;
        });
    } else if (invalid !== undefined) {
      void this.settleHttpError(handle, deferred, invalid).catch(() => {});
    } else {
      // Defensive: must not happen (exactly one of request/invalid is
      // always set). Settle anyway so the guest promise never hangs.
      void this.settleHttpError(
        handle,
        deferred,
        { code: "HTTP_INVALID_REQUEST", message: "Invalid HTTP request" },
      ).catch(() => {});
    }

    // Ownership: returning deferred.handle from a host function transfers
    // the promise handle to the framework; settle/reject clean up the
    // resolvers. The deferred itself stays tracked so a torn-down
    // operation still releases it.
    return deferred.handle;
  }

  /**
   * Run one host-side HTTP request and bridge the validated result (or
   * structured error) back into the guest promise.
   *
   * After settling, the guest's pending microtasks MUST be pumped:
   * the promise reactions (and with them the capability's continuation)
   * only run inside executePendingJobs.
   */
  private async finishHttpCall(
    handle: LoadedPluginHandle,
    deferred: QuickJSDeferredPromise,
    operation: "get" | "getJson" | "request",
    request: { url: string; options: HttpRequestOptions },
    signal: AbortSignal,
  ): Promise<void> {
    let ok = true;
    let payload: unknown;
    let errorObject: HttpErrorObject = {
      code: "HTTP_INTERNAL_ERROR",
      message: "HTTP request failed",
    };

    try {
      // The declared-domain allowlist is enforced inside the client on
      // every hop, so a redirect cannot leave the plugin's declared
      // surface (HTTP_DOMAIN_NOT_ALLOWED before any I/O).
      const response = await this.httpClient.request(
        request.url,
        request.options,
        signal,
        { allowedDomains: handle.allowedDomains },
      );
      if (operation === "getJson") {
        try {
          payload = JSON.parse(response.body) as unknown;
        } catch {
          ok = false;
          errorObject = {
            code: "HTTP_INVALID_JSON",
            message: "Response body is not valid JSON",
          };
        }
      } else {
        payload = response;
      }
    } catch (error) {
      ok = false;
      if (error instanceof HttpError) {
        errorObject = { code: error.code, message: error.message };
      }
    }

    await this.settleHttpResult(handle, deferred, ok, payload, errorObject);
  }

  /** Settle the guest promise with a precomputed structured error. */
  private async settleHttpError(
    handle: LoadedPluginHandle,
    deferred: QuickJSDeferredPromise,
    errorObject: HttpErrorObject,
  ): Promise<void> {
    await this.settleHttpResult(handle, deferred, false, undefined, errorObject);
  }

  /**
   * Convert the host-side result/error into a guest value, settle the
   * deferred promise, and pump the guest so the capability resumes.
   * No-ops (safely) if the plugin was disposed or the operation already
   * tore the guest down.
   */
  private async settleHttpResult(
    handle: LoadedPluginHandle,
    deferred: QuickJSDeferredPromise,
    ok: boolean,
    payload: unknown,
    errorObject: HttpErrorObject,
  ): Promise<void> {
    if (handle.disposed || !deferred.alive) {
      return;
    }
    const localTracked: Disposable[] = [];
    let settled = false;
    try {
      const context = handle.context;
      const value = ok ? payload : errorObject;
      const valueHandle = this.jsonToHandle(context, value, localTracked);
      if (ok) {
        deferred.resolve(valueHandle);
      } else {
        deferred.reject(valueHandle);
      }
      settled = true;
      // Ownership: resolve/reject pass the handle to the guest promise
      // machinery; the host-side handle is released here.
      valueHandle.dispose();
    } catch {
      // The guest context vanished (plugin disposed) while the request
      // was in flight. The operation is over; there is nothing to
      // settle. The request itself is aborted by the operation's
      // teardown.
      return;
    } finally {
      for (const d of localTracked) {
        if (d.alive) d.dispose();
      }
    }
    if (settled) {
      this.pumpJobsQuiet(handle, localTracked);
    }
  }

  /**
   * Pump guest jobs after a host-side promise settlement, WITHOUT
   * rethrowing job errors. A job may throw (for example a continuation
   * interrupted by the deadline); the error will surface through the
   * capability's own promise, so the pump must keep draining the queue
   * so the promise bridge can fire.
   */
  private pumpJobsQuiet(handle: LoadedPluginHandle, tracked: Disposable[]): void {
    if (handle.disposed) {
      return;
    }
    const runtime = handle.runtime;
    while (!handle.disposed && runtime.hasPendingJob()) {
      const jobs = track(runtime.executePendingJobs(), tracked);
      if (jobs.error !== undefined) {
        try {
          handle.context.unwrapResult(jobs);
        } catch {
          // Guest job error: intentionally not rethrown here (see above).
        }
      }
    }
  }

  /**
   * Module loader: only files inside the plugin's own directory may be
   * imported. Host/built-in specifiers and escaping paths are rejected
   * with a typed failure so the guest sees a descriptive error.
   */
  private loadPluginModule(
    name: string,
    pluginDir: string,
  ): string | { error: Error } {
    if (name.startsWith("node:") || /^[a-z][a-z0-9+.-]*:/i.test(name)) {
      return {
        error: new Error(
          `Host module imports are not allowed in plugins: '${name}'`,
        ),
      };
    }
    const resolved = path.resolve(pluginDir, name);
    const relative = path.relative(pluginDir, resolved);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      return {
        error: new Error(
          `Plugin module imports must stay inside the plugin directory: '${name}'`,
        ),
      };
    }
    try {
      return readFileSync(resolved, "utf8");
    } catch {
      return { error: new Error(`Cannot find plugin module: '${name}'`) };
    }
  }

  /** Map a thrown error to a structured runtime error. */
  private toRuntimeError(
    error: unknown,
    fallback: PluginRuntimeErrorType,
  ): PluginRuntimeError {
    if (error instanceof PluginTimeoutError) {
      return {
        type: "PLUGIN_TIMEOUT",
        message: "Plugin did not complete within the time limit",
      };
    }
    if (error instanceof PluginAbortedError) {
      return {
        type: "PLUGIN_RUNTIME_ERROR",
        message: "Plugin operation was aborted (the plugin was disposed or the operation was cancelled)",
      };
    }
    if (error instanceof RuntimeFailure) {
      return { type: error.type, message: error.message };
    }
    if (error instanceof Error) {
      // A guest that throws (or rejects with) a plain object such as an
      // HTTP error {code, message} should surface it verbatim rather
      // than as an opaque wrapper message.
      const cause = (error as { cause?: unknown }).cause;
      if (isStructuredErrorObject(cause)) {
        return { type: fallback, message: `${cause.code}: ${cause.message}` };
      }
      const detail = errorMessageDetail(error);
      if (/interrupted/i.test(detail)) {
        return {
          type: "PLUGIN_TIMEOUT",
          message: "Plugin execution was interrupted (time limit exceeded)",
        };
      }
      if (/out of memory/i.test(detail)) {
        return {
          type: "PLUGIN_MEMORY_LIMIT",
          message: "Plugin exceeded the memory limit",
        };
      }
      return { type: fallback, message: firstLine(detail) };
    }
    return { type: fallback, message: String(error) };
  }

  private classify(
    error: unknown,
    fallback: PluginRuntimeErrorType,
  ): never {
    throw this.toRuntimeError(error, fallback);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True for values shaped like a structured runtime error ({type, message}). */
function isRuntimeErrorShape(
  value: unknown,
): value is { type: PluginRuntimeErrorType; message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string" &&
    "message" in value &&
    typeof (value as { message: unknown }).message === "string"
  );
}

/**
 * True for plain (non-Error) objects shaped like a structured error
 * ({code, message}) — e.g. an HTTP error the guest threw uncaught.
 */
function isStructuredErrorObject(
  value: unknown,
): value is { code: string; message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !(value instanceof Error) &&
    "code" in value &&
    typeof (value as { code: unknown }).code === "string" &&
    "message" in value &&
    typeof (value as { message: unknown }).message === "string"
  );
}

/**
 * Combine the unwrapping error with its guest-side cause so that
 * QuickJSUnwrapError (host wrapper) still exposes the guest message.
 */
function errorMessageDetail(error: Error): string {
  const cause = (error.cause ?? null) as Error | null;
  return [
    error.name,
    error.message,
    cause ? `${cause.name} ${cause.message}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

function firstLine(value: string): string {
  const index = value.indexOf("\n");
  return index === -1 ? value : value.slice(0, index);
}
