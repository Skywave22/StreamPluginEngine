// Example plugin (Phase 5).
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
// NOT depend on it (tests use a local server). `parseExample`
// demonstrates the Phase 5 JSON + HTML parsing capabilities entirely
// offline (static strings — no network). `sources` returns RAW
// structured source results (Phase 6 contract) — the app layer passes
// them through the engine's normalizeSourceResults() for trusted,
// normalized output.

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
  /**
   * Demonstrates the Phase 5 JSON + HTML parsing capabilities using
   * static strings only (fully offline — no network I/O).
   *
   * Demonstrates:
   * - context.json.parse / context.json.stringify
   * - context.html.parse / select / extract
   * - structured error handling (a malformed JSON string is caught and
   *   reported, not thrown to the host)
   *
   * @param {{ manifest: object, log: (...args: unknown[]) => void }} context
   */
  parseExample(context) {
    const json = context.json.parse('{"title":"Example","tags":["a","b"],"n":1}');
    const jsonAgain = context.json.stringify(json);

    const html =
      '<div id="list">' +
      '<article class="item" data-id="7"><a href="/w/7">  First Item </a></article>' +
      '<article class="item" data-id="8"><a href="/w/8">Second Item</a></article>' +
      "</div>";
    const doc = context.html.parse(html);
    const items = context.html.select(doc, "#list .item");
    const extracted = items.map((el) => context.html.extract(el));
    // Select the anchor links to demonstrate href extraction.
    const links = context.html.select(doc, "article.item a[href]");
    const linkInfo = links.map((el) => context.html.extract(el));

    // A structured error is caught inside the plugin (not a host crash).
    let badJson = null;
    try {
      context.json.parse("{not valid json");
    } catch (e) {
      badJson = { code: e.code, message: e.message };
    }

    context.log("parseExample finished");
    return {
      json: { title: json.title, tagCount: json.tags.length, n: json.n, roundTrip: jsonAgain },
      html: {
        itemCount: extracted.length,
        first: extracted[0]
          ? {
              tag: extracted[0].tagName,
              text: extracted[0].text,
              dataId: extracted[0].data.id,
            }
          : null,
        links: linkInfo.map((l) => ({
          text: l.text,
          href: l.href,
        })),
      },
      badJson,
    };
  },

  /**
   * Phase 6 contract: return RAW structured source results.
   *
   * The plugin does its work (HTTP in Phase 4, HTML/JSON parsing in
   * Phase 5, transforming the extracted data) and returns plain result
   * objects — an object or an array of them. The engine's
   * normalizeSourceResults() (host-side, called by the application
   * layer) validates and normalizes this raw output into trusted
   * SourceResult[] values. The plugin does not normalize anything
   * itself.
   *
   * Static test data only — not connected to any real website.
   *
   * @param {{ manifest: object, log: (...args: unknown[]) => void }} context
   */
  sources(context) {
    context.log("sources called");
    return [
      {
        id: "example-movie-1",
        title: "Example Movie",
        type: "movie",
        url: "https://example.com/watch/example-movie-1",
        source: "example.source",
        quality: "1080p",
        language: "en",
        subtitles: [
          { url: "https://example.com/subs/example-movie-1.srt", language: "en" },
        ],
        metadata: { year: 2024 },
      },
      {
        id: "example-episode-1",
        title: "Example Episode",
        type: "episode",
        url: "https://example.com/watch/example-episode-1",
        source: "example.source",
        metadata: { season: 1, episode: 7 },
      },
    ];
  },

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
