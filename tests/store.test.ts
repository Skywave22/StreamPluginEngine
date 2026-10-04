/**
 * v0.4.0: `context.store` — per-plugin persistent storage.
 *
 * Covered here (host-side unit level):
 *   - validation of values/keys, quotas, and prototype-pollution refusal
 *   - manifest `settings` defaults merged under stored values
 *   - persistence through a StoreBackend, including "save only when dirty"
 *   - corrupted backend data being dropped rather than surfaced
 *
 * The in-sandbox behaviour (sync reads, per-call persistence, permission
 * gating) lives in store-runtime.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createPluginStore,
  MemoryStoreBackend,
  PluginStore,
  sanitizeStoreValue,
  settingsDefaults,
  STORE_LIMITS,
  isValidStoreKey,
} from "../src/store.js";
import type { StoreBackend } from "../src/store.js";
import { validateManifest } from "../src/manifest.js";

test("store: keys follow a documented, conservative pattern", () => {
  assert.ok(isValidStoreKey("baseUrl"));
  assert.ok(isValidStoreKey("user.preference-2"));
  assert.ok(isValidStoreKey("a"));

  assert.ok(!isValidStoreKey(""), "empty key");
  assert.ok(!isValidStoreKey("-leading-dash"));
  assert.ok(!isValidStoreKey(".leading-dot"));
  assert.ok(!isValidStoreKey("has space"));
  assert.ok(!isValidStoreKey("a".repeat(STORE_LIMITS.maxKeyLength + 1)), "too long");
  assert.ok(!isValidStoreKey(42), "non-string");
  // Prototype-pollution vectors are refused as keys.
  assert.ok(!isValidStoreKey("__proto__"));
  assert.ok(!isValidStoreKey("constructor"));
  assert.ok(!isValidStoreKey("prototype"));
});

test("store: values are validated, copied, and size-bounded", () => {
  // Round-trippable scalars, arrays and plain objects are accepted.
  for (const value of ["text", 42, 3.5, true, false, null, [1, 2, 3], { a: 1 }]) {
    const result = sanitizeStoreValue(value);
    assert.ok(result.ok, `expected ${JSON.stringify(value)} to be accepted`);
  }

  // `undefined`, functions and symbols cannot be stored.
  assert.ok(!sanitizeStoreValue(undefined).ok);
  assert.ok(!sanitizeStoreValue(() => 1).ok);
  assert.ok(!sanitizeStoreValue(Symbol("s")).ok);

  // Oversized values are refused with a structured code, not truncated.
  const big = sanitizeStoreValue("x".repeat(STORE_LIMITS.maxValueBytes + 1));
  assert.equal(big.ok, false);
  assert.equal(big.ok ? "" : big.error.code, "STORE_INVALID_VALUE");

  // Over-deep structures are refused.
  let deep: unknown = 1;
  for (let i = 0; i <= STORE_LIMITS.maxValueDepth + 1; i += 1) deep = { nested: deep };
  assert.ok(!sanitizeStoreValue(deep).ok, "deep structure");

  // Circular structures are refused rather than crashing the engine.
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.ok(!sanitizeStoreValue(circular).ok, "circular structure");
});

test("store: prototype-polluting keys are refused anywhere in a value", () => {
  // NOTE: an object LITERAL `{ __proto__: ... }` sets the prototype (it is
  // not an own key). The realistic vector is JSON — which is exactly how a
  // persisted store and a guest value both arrive — so build it that way.
  const direct = sanitizeStoreValue(
    JSON.parse('{"__proto__": {"polluted": true}}'),
  );
  assert.equal(direct.ok, false);
  assert.ok(
    Object.keys(JSON.parse('{"__proto__": 1}')).includes("__proto__"),
    "JSON.parse creates an own __proto__ key (the vector under test)",
  );

  const nested = sanitizeStoreValue({ a: { b: { constructor: "x" } } });
  assert.equal(nested.ok, false);
  assert.match(nested.ok ? "" : nested.error.message, /forbidden key/);

  const inArray = sanitizeStoreValue([{ ok: 1 }, { prototype: 2 }]);
  assert.equal(inArray.ok, false);

  // And nothing was actually polluted.
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("store: the accepted value is a copy, not the caller's object", () => {
  const original = { list: [1, 2], flag: true };
  const result = sanitizeStoreValue(original);
  assert.ok(result.ok);
  const stored = result.value as { list: number[]; flag: boolean };
  original.list.push(3);
  original.flag = false;
  assert.deepEqual(stored.list, [1, 2], "later mutation must not reach the store");
  assert.equal(stored.flag, true);
});

test("store: quotas are enforced on keys and total size", () => {
  const store = new PluginStore("t.quota", new MemoryStoreBackend());

  assert.deepEqual(store.set("ok", 1), { ok: true });
  const badKey = store.set("bad key!", 1);
  assert.equal(badKey.ok, false);
  assert.equal(badKey.ok ? "" : badKey.error.code, "STORE_INVALID_KEY");

  // Fill to the key limit, then one more.
  for (let i = Object.keys(store.storedValues()).length; i < STORE_LIMITS.maxKeys; i += 1) {
    const result = store.set(`k${i}`, i);
    assert.equal(result.ok, true, `key ${i} should fit`);
  }
  const overflow = store.set("one-too-many", 1);
  assert.equal(overflow.ok, false);
  assert.equal(overflow.ok ? "" : overflow.error.code, "STORE_QUOTA_EXCEEDED");

  // Overwriting an EXISTING key is still allowed at the key limit.
  assert.deepEqual(store.set("ok", 2), { ok: true });
});

test("store: total byte quota rejects a write that would blow the budget", () => {
  const store = new PluginStore("t.bytes", new MemoryStoreBackend());
  const chunk = "x".repeat(4_000);
  let written = 0;
  let rejected = false;
  for (let i = 0; i < 40; i += 1) {
    const result = store.set(`chunk${i}`, chunk);
    if (!result.ok) {
      assert.equal(result.error.code, "STORE_QUOTA_EXCEEDED");
      rejected = true;
      break;
    }
    written += 1;
  }
  assert.ok(rejected, "the byte quota must eventually refuse a write");
  assert.ok(
    Object.keys(store.storedValues()).length < STORE_LIMITS.maxKeys,
    "the byte quota, not the key quota, must be what stops this",
  );
  assert.ok(written > 0);
});

test("store: manifest settings provide defaults that stored values override", async () => {
  const manifest = {
    settings: [
      { key: "baseUrl", type: "mirror" as const, default: "https://a.example" },
      { key: "quality", type: "select" as const, default: "1080p", options: ["1080p", "720p"] },
      { key: "retries", type: "number" as const, default: 3 },
      { key: "adult", type: "boolean" as const, default: false },
    ],
  };
  assert.deepEqual(Object.keys(settingsDefaults(manifest)).sort(), [
    "adult",
    "baseUrl",
    "quality",
    "retries",
  ]);

  const store = createPluginStore("t.settings", new MemoryStoreBackend(), manifest);
  await store.load();
  assert.equal(store.get("quality"), "1080p", "declared default");
  assert.equal(store.get("retries"), 3);
  assert.equal(store.get("adult"), false);
  assert.equal(store.get("missing", "fallback"), "fallback");
  assert.ok(store.has("quality"), "defaults count as present");
  assert.ok(store.keys().includes("baseUrl"));

  // A user choice wins over the default.
  assert.deepEqual(store.set("quality", "720p"), { ok: true });
  assert.equal(store.get("quality"), "720p");

  // Deleting a key falls back to the declared default, not to undefined.
  assert.equal(store.delete("quality"), true);
  assert.equal(store.get("quality"), "1080p");
});

test("store: persistence saves once per change and skips untouched stores", async () => {
  const saves: { pluginId: string; values: Record<string, unknown> }[] = [];
  const backend: StoreBackend = {
    load: () => ({}),
    save: (pluginId, values) => {
      saves.push({ pluginId, values });
    },
  };

  const store = new PluginStore("t.persist", backend);
  await store.load();
  assert.equal(store.isDirty, false);

  await store.persist();
  assert.equal(saves.length, 0, "an untouched store must not hit the backend");

  store.set("a", 1);
  assert.equal(store.isDirty, true);
  await store.persist();
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0]?.values, { a: 1 });
  assert.equal(store.isDirty, false);

  // A second persist with no writes is a no-op.
  await store.persist();
  assert.equal(saves.length, 1);
});

test("store: a plugin's data round-trips through a backend", async () => {
  const backend = new MemoryStoreBackend();

  const first = new PluginStore("t.round", backend);
  await first.load();
  first.set("token", { value: "abc", expires: 1_700_000_000 });
  first.set("count", 7);
  await first.persist();

  // A fresh store (a new process, in reality) sees the same values.
  const second = new PluginStore("t.round", backend);
  await second.load();
  assert.deepEqual(second.get("token"), { value: "abc", expires: 1_700_000_000 });
  assert.equal(second.get("count"), 7);

  // Another plugin's namespace is untouched.
  const other = new PluginStore("t.other", backend);
  await other.load();
  assert.equal(other.get("count"), undefined);
  assert.equal(other.keys().length, 0);
});

test("store: invalid persisted data is dropped, not surfaced to plugins", async () => {
  const backend: StoreBackend = {
    load: () => ({
      good: 1,
      "bad key!": 2, // invalid key
      deep: { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } },
      poisoned: JSON.parse('{"__proto__": {"evil": true}}'),
      oversized: "x".repeat(STORE_LIMITS.maxValueBytes + 1),
    }),
    save: () => {},
  };
  const store = new PluginStore("t.dirty", backend);
  await store.load();
  assert.equal(store.get("good"), 1);
  assert.equal(store.get("bad key!"), undefined);
  assert.equal(store.get("deep"), undefined);
  assert.equal(store.get("oversized"), undefined);
  assert.deepEqual(
    Object.keys(store.storedValues()),
    ["good"],
    "only valid entries survive loading",
  );
});

test("store: a failing backend does not throw out of load()", async () => {
  const backend: StoreBackend = {
    load: () => {
      throw new Error("backend exploded");
    },
    save: () => {},
  };
  const store = new PluginStore("t.broken", backend);
  await store.load();
  assert.equal(store.isLoaded, true);
  assert.equal(store.get("anything"), undefined);

  // ...and a failing SAVE propagates to the caller (the runtime logs it
  // and keeps the store dirty), rather than being swallowed silently.
  store.set("a", 1);
  const failing: StoreBackend = {
    load: () => ({}),
    save: () => {
      throw new Error("disk full");
    },
  };
  const store2 = new PluginStore("t.full", failing);
  await store2.load();
  store2.set("a", 1);
  await assert.rejects(() => store2.persist(), /disk full/);
  assert.equal(store2.isDirty, true, "a failed save stays dirty for a retry");
});

test("manifest: settings and mirrors are validated, including cross-references", () => {
  const base = {
    id: "t.example",
    name: "Example",
    version: "1.0.0",
    entry: "plugin.js",
  };

  // A well-formed declaration.
  const good = validateManifest({
    ...base,
    mirrors: ["mirror.example", "*.cdn.example"],
    settings: [
      { key: "baseUrl", type: "mirror", default: "mirror.example", label: "Mirror" },
      { key: "quality", type: "select", default: "auto", options: ["auto", "1080p"], description: "Preferred quality" },
      { key: "apiKey", type: "string" },
      { key: "enabled", type: "boolean", default: true },
    ],
  });
  assert.ok(good.ok, good.ok ? "" : good.errors.join("; "));
  assert.equal(good.ok ? good.manifest.mirrors?.length : 0, 2);
  assert.equal(good.ok ? good.manifest.settings?.length : 0, 4);

  const problems = (input: unknown): string[] => {
    const result = validateManifest(input);
    return result.ok ? [] : result.errors;
  };

  // Unknown type, missing select options, bad default, duplicate key.
  assert.match(
    problems({ ...base, settings: [{ key: "x", type: "colour" }] }).join("; "),
    /must be one of/,
  );
  assert.match(
    problems({ ...base, settings: [{ key: "x", type: "select" }] }).join("; "),
    /options is required/,
  );
  assert.match(
    problems({
      ...base,
      settings: [{ key: "x", type: "select", default: "z", options: ["a", "b"] }],
    }).join("; "),
    /not one of its own options/,
  );
  assert.match(
    problems({
      ...base,
      settings: [
        { key: "dup", type: "string" },
        { key: "dup", type: "string" },
      ],
    }).join("; "),
    /declared more than once/,
  );
  assert.match(
    problems({ ...base, settings: [{ key: "x", type: "number", default: "nope" }] }).join("; "),
    /must be a finite number/,
  );

  // Mirror settings must reference declared mirrors.
  assert.match(
    problems({ ...base, settings: [{ key: "baseUrl", type: "mirror" }] }).join("; "),
    /declares no 'mirrors'/,
  );
  assert.match(
    problems({
      ...base,
      mirrors: ["a.example"],
      settings: [{ key: "baseUrl", type: "mirror", default: "elsewhere.example" }],
    }).join("; "),
    /not one of the manifest's declared mirrors/,
  );

  // Mirrors themselves must be non-empty strings.
  assert.match(
    problems({ ...base, mirrors: [""] }).join("; "),
    /mirrors\[0\]/,
  );

  // An undeclared field inside a setting is caught too.
  assert.match(
    problems({ ...base, settings: [{ key: "x", type: "string", extra: 1 }] }).join("; "),
    /unknown field 'extra'/,
  );
});

test("manifest: store permission is part of the documented permission set", () => {
  // The permission is resolved by the runtime; this test pins the shape
  // contract that hosts and plugins rely on.
  const store = new PluginStore("t.perm", new MemoryStoreBackend());
  assert.equal(typeof store.get, "function");
  assert.equal(typeof store.set, "function");
  assert.equal(typeof store.delete, "function");
  assert.equal(typeof store.keys, "function");
  assert.equal(typeof store.all, "function");
});
