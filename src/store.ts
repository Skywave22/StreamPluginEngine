/**
 * Per-plugin persistent storage — `context.store`.
 *
 * Every system we benchmark ourselves against gives plugins a place to
 * remember things (a key-value store, "preferences", or a settings
 * object). This module is ours, designed around two rules:
 *
 * 1. **The guest never talks to a backend.** A plugin's `store.get()`
 *    is a synchronous read of a host-side map that was loaded once per
 *    call. The alternative — an async bridge call per read, which is
 *    what a naive implementation does — costs a Wasm round trip and a
 *    promise tick for every single `get`. Reads here are free; writes
 *    are validated in place and persisted ONCE when the capability call
 *    ends, so a plugin that writes 200 keys pays one save, not 200.
 *
 * 2. **Persisted data is untrusted input.** Nothing from a backend (or
 *    a plugin) is trusted: values are validated for shape and size,
 *    deep-copied through a JSON round trip so no exotic host object can
 *    ride along, and prototype-polluting key names are refused
 *    everywhere in the value tree.
 *
 * The backend is pluggable (`StoreBackend`): the default is in-memory
 * (a plugin's data lives for the runtime's lifetime), and an
 * application can supply a file/MMKV/SQLite-backed implementation
 * without the engine knowing anything about it.
 */
import type { PluginManifest, PluginSetting } from "./types.js";

/** Quotas for one plugin's store. Applied host-side, always. */
export const STORE_LIMITS = {
  /** Maximum number of stored keys per plugin. */
  maxKeys: 256,
  /** Maximum key length in characters. */
  maxKeyLength: 64,
  /** Maximum serialized size of ONE value, in bytes (UTF-8). */
  maxValueBytes: 4_096,
  /** Maximum serialized size of a plugin's whole store, in bytes. */
  maxTotalBytes: 65_536,
  /** Maximum nesting depth of a stored value. */
  maxValueDepth: 8,
} as const;

/** Structured failure codes a store operation can report. */
export const STORE_ERROR_CODES = [
  /** The key is not a string matching the store key rules. */
  "STORE_INVALID_KEY",
  /** The value is not JSON-serializable, is too big, or too deep. */
  "STORE_INVALID_VALUE",
  /** Writing this value or key would exceed a quota. */
  "STORE_QUOTA_EXCEEDED",
  /** The store backend failed to persist (host-side problem). */
  "STORE_BACKEND_ERROR",
] as const;

export type StoreErrorCode = (typeof STORE_ERROR_CODES)[number];

/** A structured store error, shaped like every other engine error. */
export interface StoreError {
  code: StoreErrorCode;
  message: string;
}

/**
 * Storage behind a plugin's `context.store`. Implementations are
 * responsible ONLY for moving a plain object in and out; all validation
 * and quota enforcement happens in `PluginStore`.
 *
 * Both methods may be synchronous or asynchronous — the engine awaits
 * whatever they return, so an in-memory backend costs nothing and a
 * file-backed one can do real I/O.
 */
export interface StoreBackend {
  /** Reads a plugin's stored values. Missing/never-written → `{}`. */
  load(pluginId: string): unknown | Promise<unknown>;
  /** Persists a plugin's complete value set (replace, not merge). */
  save(pluginId: string, values: Record<string, unknown>): void | Promise<void>;
  /**
   * Optional: removes a plugin's data entirely (uninstall/purge).
   * The engine calls this from nothing; it exists for host tools.
   */
  remove?(pluginId: string): void | Promise<void>;
}

/** The default backend: values live as long as the host process. */
export class MemoryStoreBackend implements StoreBackend {
  private readonly plugins = new Map<string, Record<string, unknown>>();

  load(pluginId: string): unknown {
    return this.plugins.get(pluginId) ?? {};
  }

  save(pluginId: string, values: Record<string, unknown>): void {
    // Copy so a later mutation of the live map cannot leak into what the
    // backend hands out on the next load.
    this.plugins.set(pluginId, { ...values });
  }

  remove(pluginId: string): void {
    this.plugins.delete(pluginId);
  }
}

/**
 * Keys a plugin may use: 1–64 characters, letters/digits/`.`/`_`/`-`,
 * starting with a letter or digit. Deliberately excludes anything that
 * could collide with object plumbing.
 */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Names refused ANYWHERE in a value tree (prototype pollution vectors). */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export function isValidStoreKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    key.length <= STORE_LIMITS.maxKeyLength &&
    KEY_PATTERN.test(key) &&
    !FORBIDDEN_KEYS.has(key)
  );
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Validates and copies a candidate value.
 *
 * The copy is produced by a JSON round trip, which means the stored
 * value never holds a reference to a host object (or, for a guest
 * value, anything that could alias engine state), and `undefined` and
 * symbols cannot survive.
 *
 * Guest functions are refused by the RUNTIME before they get here
 * (`dump()` would otherwise hand us the function's source text as a
 * string). Returns a structured error rather than throwing.
 */
export function sanitizeStoreValue(
  value: unknown,
): { ok: true; value: unknown } | { ok: false; error: StoreError } {
  const invalid = (message: string): { ok: false; error: StoreError } => ({
    ok: false,
    error: { code: "STORE_INVALID_VALUE", message },
  });

  if (value === undefined) {
    return invalid("Value must be JSON-serializable (got undefined)");
  }

  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return invalid(
      "Value must be JSON-serializable (circular structure or unsupported type)",
    );
  }
  if (text === undefined) {
    // JSON.stringify returns undefined for functions and symbols.
    return invalid("Value must be JSON-serializable (got a function or symbol)");
  }
  if (utf8Bytes(text) > STORE_LIMITS.maxValueBytes) {
    return invalid(
      `Value exceeds ${STORE_LIMITS.maxValueBytes} bytes when serialized`,
    );
  }

  // Depth + forbidden-key scan on the ORIGINAL structure is unnecessary:
  // the parsed copy below is what gets stored, and it is scanned.
  let copy: unknown;
  try {
    copy = JSON.parse(text);
  } catch {
    return invalid("Value must be JSON-serializable");
  }

  const problem = findForbiddenKey(copy, 0);
  if (problem) {
    return invalid(problem);
  }
  return { ok: true, value: copy };
}

/** Depth-first scan for prototype-polluting keys and excessive nesting. */
function findForbiddenKey(value: unknown, depth: number): string | null {
  if (depth > STORE_LIMITS.maxValueDepth) {
    return `Value nests deeper than ${STORE_LIMITS.maxValueDepth} levels`;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const problem = findForbiddenKey(entry, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        return `Value contains a forbidden key: ${JSON.stringify(key)}`;
      }
      const problem = findForbiddenKey(
        (value as Record<string, unknown>)[key],
        depth + 1,
      );
      if (problem) return problem;
    }
  }
  return null;
}

/**
 * One plugin's store, host-side.
 *
 * Lifecycle: `load()` once when the plugin is loaded, then reads and
 * writes for the lifetime of the plugin, then `persist()` — which the
 * runtime calls when a capability call ends and only does work if
 * something actually changed.
 */
export class PluginStore {
  readonly pluginId: string;
  private readonly backend: StoreBackend;
  private readonly defaults: Readonly<Record<string, unknown>>;
  /** True when the plugin has settings declared in its manifest. */
  readonly hasSettings: boolean;
  private values: Record<string, unknown> = {};
  private dirty = false;
  private loaded = false;
  /**
   * The most recent backend failure, if any.
   *
   * Backend problems never throw out of `load()`/`persist()` — a plugin
   * must keep working even when the host's storage is unavailable — but
   * they must not be invisible either, so the runtime reads this and
   * reports it through the logger. `takeLastError()` clears it, so a
   * persistent problem is logged once per occurrence rather than on
   * every call.
   */
  private lastError: StoreError | null = null;

  constructor(
    pluginId: string,
    backend: StoreBackend,
    defaults: Readonly<Record<string, unknown>> = {},
  ) {
    this.pluginId = pluginId;
    this.backend = backend;
    this.defaults = defaults;
    this.hasSettings = Object.keys(defaults).length > 0;
  }

  /**
   * Reads this plugin's persisted values. Anything that does not survive
   * validation (corrupted file, hand-edited backend, values written by
   * an older engine) is DROPPED rather than surfaced — a store that
   * silently returns garbage is worse than one that returns nothing.
   *
   * Manifest defaults are merged underneath the stored values, so a
   * first run sees the declared defaults and a user's stored choice
   * always wins.
   */
  async load(): Promise<void> {
    let raw: unknown;
    try {
      raw = await this.backend.load(this.pluginId);
    } catch (error) {
      this.lastError = {
        code: "STORE_BACKEND_ERROR",
        message: `Could not load stored values: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
      raw = {};
    }
    const restored: Record<string, unknown> = {};
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw)) {
        if (!isValidStoreKey(key)) continue;
        const checked = sanitizeStoreValue(value);
        if (checked.ok) restored[key] = checked.value;
      }
    }
    this.values = restored;
    this.loaded = true;
  }

  /** True when this store has been loaded from its backend. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.values, key) ||
      Object.prototype.hasOwnProperty.call(this.defaults, key);
  }

  /**
   * Reads a key: stored value, else the manifest default, else
   * `fallback`. Returns the stored copy — never a live reference.
   */
  get(key: string, fallback?: unknown): unknown {
    if (Object.prototype.hasOwnProperty.call(this.values, key)) {
      return this.values[key];
    }
    if (Object.prototype.hasOwnProperty.call(this.defaults, key)) {
      return this.defaults[key];
    }
    return fallback;
  }

  /** Every key a plugin can see, sorted (stored first, then defaults). */
  keys(): string[] {
    const keys = new Set<string>([
      ...Object.keys(this.values),
      ...Object.keys(this.defaults),
    ]);
    return [...keys].sort();
  }

  /** A defensive copy of everything the plugin can see. */
  all(): Record<string, unknown> {
    return { ...this.defaults, ...this.values };
  }

  /**
   * Writes a value. Validates shape/size/depth, enforces the key and
   * total-size quotas, and marks the store for persistence.
   */
  set(key: unknown, value: unknown): { ok: true } | { ok: false; error: StoreError } {
    if (!isValidStoreKey(key)) {
      return {
        ok: false,
        error: {
          code: "STORE_INVALID_KEY",
          message: `Invalid store key: must be 1-${STORE_LIMITS.maxKeyLength} characters of [A-Za-z0-9._-], starting with a letter or digit`,
        },
      };
    }
    const checked = sanitizeStoreValue(value);
    if (!checked.ok) {
      return checked;
    }

    const isNewKey = !Object.prototype.hasOwnProperty.call(this.values, key);
    if (isNewKey && Object.keys(this.values).length >= STORE_LIMITS.maxKeys) {
      return {
        ok: false,
        error: {
          code: "STORE_QUOTA_EXCEEDED",
          message: `Store already holds the maximum of ${STORE_LIMITS.maxKeys} keys`,
        },
      };
    }

    const next = { ...this.values, [key]: checked.value };
    const totalBytes = utf8Bytes(JSON.stringify(next));
    if (totalBytes > STORE_LIMITS.maxTotalBytes) {
      return {
        ok: false,
        error: {
          code: "STORE_QUOTA_EXCEEDED",
          message: `Store would exceed ${STORE_LIMITS.maxTotalBytes} bytes in total`,
        },
      };
    }

    this.values = next;
    this.dirty = true;
    return { ok: true };
  }

  /** Removes a key. Returns whether it existed (defaults are NOT removed). */
  delete(key: unknown): boolean {
    if (!isValidStoreKey(key)) {
      return false;
    }
    if (!Object.prototype.hasOwnProperty.call(this.values, key)) {
      return false;
    }
    const next = { ...this.values };
    delete next[key];
    this.values = next;
    this.dirty = true;
    return true;
  }

  /**
   * Persists if — and only if — something changed since the last save.
   *
   * The dirty flag is cleared only AFTER the backend accepts the write,
   * so a backend failure (disk full, permission denied) leaves the store
   * marked for retry instead of silently dropping the plugin's data.
   *
   * No write can interleave with the save: operations on one plugin are
   * serialized by the runtime, and this runs inside that same queue.
   */
  async persist(): Promise<void> {
    if (!this.dirty) {
      return;
    }
    try {
      await this.backend.save(this.pluginId, { ...this.values });
    } catch (error) {
      this.lastError = {
        code: "STORE_BACKEND_ERROR",
        message: `Could not persist stored values: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
      // Rethrow so a caller that WANTS to react (a host tool, a test) can;
      // the runtime catches it, logs it, and leaves the store dirty.
      throw error;
    }
    this.dirty = false;
  }

  /** Returns and clears the last backend failure. */
  takeLastError(): StoreError | null {
    const error = this.lastError;
    this.lastError = null;
    return error;
  }

  /** True when there are unsaved changes (host introspection). */
  get isDirty(): boolean {
    return this.dirty;
  }

  /** The stored values only (no defaults) — for host-side tools/tests. */
  storedValues(): Record<string, unknown> {
    return { ...this.values };
  }
}

/**
 * Builds the default value map from a manifest's `settings` declaration.
 *
 * Only the DEFAULT is taken here; a stored user value always wins at read
 * time (`PluginStore.get`). `select` and `mirror` settings contribute
 * their declared default so a plugin never has to special-case "unset".
 */
export function settingsDefaults(
  manifest: Pick<PluginManifest, "settings">,
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const setting of manifest.settings ?? []) {
    if (setting.default !== undefined) {
      defaults[setting.key] = setting.default;
    }
  }
  return defaults;
}

/**
 * The declared setting for a key, if any. Used by the runtime to apply
 * type-specific rules (see `mirror` settings, whose value must be one of
 * the manifest's declared mirrors).
 */
export function findSetting(
  settings: readonly PluginSetting[] | undefined,
  key: string,
): PluginSetting | undefined {
  return settings?.find((setting) => setting.key === key);
}

/** Creates a store for a manifest, wiring its declared defaults. */
export function createPluginStore(
  pluginId: string,
  backend: StoreBackend,
  manifest: Pick<PluginManifest, "settings">,
): PluginStore {
  return new PluginStore(pluginId, backend, settingsDefaults(manifest));
}
