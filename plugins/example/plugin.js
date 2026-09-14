// Example plugin (Phase 3).
//
// Plugin contract:
//   export const plugin = { <capability>: fn, ... }
//
// Each capability function receives its JSON-serializable arguments first,
// then a controlled `context` object as the LAST argument:
//   context.manifest  — this plugin's manifest (read-only)
//   context.log(...)  — route a log line to the host
//
// Plugins run inside a sandboxed QuickJS (Wasm) runtime. They have NO
// access to Node.js globals, the filesystem, or the network. The only
// values that cross back to the host are JSON-serializable results.
//
// `search` returns static test data ONLY — it is not connected to any
// real streaming website.

export const plugin = {
  /** Harmless self-test used by the CLI and test suite. */
  test() {
    return "Example Result";
  },

  /**
   * Returns a fixed test result. Test data only.
   * @param {string} query
   * @param {{ manifest: object, log: (...args: unknown[]) => void }} context
   */
  async search(query, context) {
    context.log("search called for", query);
    return [{ id: "example-1", title: "Example Result" }];
  },
};
