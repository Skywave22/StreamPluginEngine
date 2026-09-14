// Example plugin (Phase 4).
//
// Plugin contract:
//   export const plugin = { <capability>: fn, ... }
//
// Each capability function receives its JSON-serializable arguments first,
// then a controlled `context` object as the LAST argument:
//   context.manifest  — this plugin's manifest (read-only)
//   context.log(...)  — route a log line to the host
//   context.http      — the engine-controlled HTTP capability:
//       await context.http.get(url, options?)      → {status, statusText, headers, url, body}
//       await context.http.getJson(url, options?)  → parsed JSON body
//       await context.http.request({url, method?, headers?, body?, ...})
//     Transport failures REJECT with a structured error object
//     {code, message} (e.g. {code: "HTTP_TIMEOUT", message: "..."}).
//     Non-2xx status codes (404, 500, ...) are NOT errors — they resolve
//     normally so the plugin can inspect status and body.
//
// Plugins run inside a sandboxed QuickJS (Wasm) runtime. They have NO
// access to Node.js globals, the filesystem, sockets, or an unrestricted
// fetch. The ONLY way a plugin performs network I/O is context.http,
// which the engine validates and bounds (scheme, timeout, size,
// redirects, headers). The only values that cross back to the host are
// JSON-serializable results.
//
// `search` returns static test data ONLY — it is not connected to any
// real streaming website. `httpExample` performs a real GET against
// https://example.com for demonstration; the automated test suite does
// NOT depend on it (tests use a local server).

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

  /**
   * Demonstrates the controlled HTTP capability against a stable public
   * endpoint (no authentication, not a bypass/security-testing target).
   *
   * Demonstrates: GET, reading status, reading the body, handling an
   * HTTP error status (404 resolves normally), and handling a request
   * failure (structured rejection).
   *
   * @param {{ manifest: object, log: (...args: unknown[]) => void }} context
   */
  async httpExample(context) {
    const result = { ok: true, requests: {} };
    try {
      // 1. A normal GET: status + body.
      const res = await context.http.get("https://example.com", {
        timeoutMs: 10000,
      });
      result.requests.get = {
        status: res.status,
        url: res.url,
        contentType: res.headers["content-type"] ?? null,
        bodyStart: res.body.slice(0, 80),
      };

      // 2. An HTTP error status: NOT a transport failure — it resolves.
      const missing = await context.http.get("https://example.com/definitely-not-a-page-404");
      result.requests.httpError = { status: missing.status, isFailure: missing.status >= 400 };

      // 3. A request failure (unreachable host): structured rejection.
      try {
        await context.http.get("https://no-such-host.invalid/x", { timeoutMs: 5000 });
        result.requests.failure = { sawError: false };
      } catch (err) {
        // err is a structured object: { code: "HTTP_...", message: "..." }
        result.requests.failure = { sawError: true, code: err.code, message: err.message };
      }

      context.log("httpExample finished");
      return result;
    } catch (err) {
      // Any unexpected transport failure: report it structurally.
      result.ok = false;
      result.error = { code: err && err.code, message: err && err.message };
      return result;
    }
  },
};
