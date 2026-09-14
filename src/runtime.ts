/**
 * PluginRuntime — sandboxed execution of plugin JavaScript.
 *
 * Plugins run inside QuickJS, a full JavaScript engine compiled to
 * WebAssembly (via the quickjs-emscripten package). It is a SEPARATE
 * engine from the host Node.js process: the plugin realm contains no
 * Node.js globals, no host objects, and no built-in modules. Plugins
 * communicate with the host exclusively through the controlled
 * PluginContext (manifest + log + http) and by returning
 * JSON-serializable values.
 *
 * Phase 4 adds the controlled HTTP capability: `context.http.get` /
 * `context.http.getJson` / `context.http.request`. The host functions
 * return guest promises (deferred promises); the actual network I/O
 * happens host-side in HttpClient (src/http.ts) and the settled,
 * validated result is bridged back into the guest. Plugins never touch
 * Node networking directly.
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
import type {
  QuickJSContext,
  QuickJSDeferredPromise,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSWASMModule,
} from "quickjs-emscripten";

import { HttpClient, HttpError } from "./http.js";
import type { HttpRequestOptions, HttpErrorObject } from "./http.js";
import type {
  LoadedPlugin,
  Plugin,
  PluginLoadResult,
  PluginRuntimeError,
  PluginRuntimeErrorType,
  PluginRuntimeOptions,
} from "./types.js";
import type { PluginExecutionResult, PluginManifest } from "./types.js";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;

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
 * Internal handle: the public LoadedPlugin plus the QuickJS resources
 * backing it. Disposing it frees the guest heap.
 */
class LoadedPluginHandle implements LoadedPlugin {
  readonly pluginId: string;
  readonly manifest: PluginManifest;
  readonly capabilities: string[];
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
  /** Set when the guest environment has been (or is being) disposed. */
  disposed = false;

  constructor(
    manifest: PluginManifest,
    capabilities: string[],
    runtime: QuickJSRuntime,
    context: QuickJSContext,
    capabilityFns: Map<string, QuickJSHandle>,
  ) {
    this.pluginId = manifest.id;
    this.manifest = manifest;
    this.capabilities = capabilities;
    this.runtime = runtime;
    this.context = context;
    this.capabilityFns = capabilityFns;
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.inFlightHttp) {
      controller.abort(new Error("plugin disposed"));
    }
    this.inFlightHttp.clear();
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

  constructor(options: PluginRuntimeOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.memoryLimitBytes = options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES;
    this.logger =
      options.logger ??
      ((pluginId, message) => console.log(`[plugin:${pluginId}] ${message}`));
    this.httpClient = new HttpClient({ limits: options.http?.limits });
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
      );
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
      );
      if (settled !== valueHandle) {
        track(settled, tracked);
      }
      return {
        success: true,
        value: context.dump(settled),
        executionTimeMs: executionTimeMs(),
      };
    } catch (error) {
      // Errors classified inside are already structured {type, message}.
      if (isRuntimeErrorShape(error)) {
        return fail(error);
      }
      return fail(this.toRuntimeError(error, "PLUGIN_RUNTIME_ERROR"));
    } finally {
      runtime.removeInterruptHandler();
      // Abort any HTTP request still in flight for this operation.
      opAbort.abort(new Error("operation ended"));
      handle.inFlightHttp.delete(opAbort);
      for (const d of tracked) {
        if (d.alive) d.dispose();
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
      settled = await this.withDeadline(hostPromise, deadline);
    } catch (error) {
      throw this.classify(error, "PLUGIN_TIMEOUT");
    }
    this.pumpJobs(runtime, tracked, deadline);

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
    while (runtime.hasPendingJob() && performance.now() < deadline) {
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
  private withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
    const remaining = Math.max(0, deadline - performance.now());
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new PluginTimeoutError()), remaining);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
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

    // context.http — the ONLY network surface a plugin has.
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

    context.setProp(contextObject, "manifest", manifestHandle);
    context.setProp(contextObject, "log", logFn);
    context.setProp(contextObject, "http", httpObject);
    return contextObject;
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

    // Schedule the host-side work. The promise is always settled (or the
    // operation ends first, which aborts the request and drains the
    // guest), so the guest never sees an unhandled rejection.
    if (request !== undefined) {
      void this.finishHttpCall(handle, deferred, operation, request, opAbort.signal).catch(
        () => {
          // finishHttpCall never rejects; this is a defensive guard.
        },
      );
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
      const response = await this.httpClient.request(request.url, request.options, signal);
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
