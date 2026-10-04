// Example plugin written against plugin API version 2 (manifest
// apiVersion: 2) — the shape an application-facing source plugin takes.
//
// It demonstrates, entirely offline (static strings, no network):
//
//   1. The HANDLE-based html capability. `parse` returns a numeric
//      document handle, `select` returns numeric element handles, and
//      only `extract` produces an object — the document tree never
//      crosses the sandbox boundary. That is several times faster than
//      the v1 tree-based API and has no ~500-level nesting limit.
//      Handles are valid for the duration of ONE capability call.
//
//   2. The app-ready result shape: `format` (so a player can pick HLS vs
//      progressive) and `headers` (Referer/User-Agent, which most
//      scraped media endpoints require). Both are validated by the
//      engine on the way out — see src/results.ts.
//
//   3. Structured error handling: html failures arrive as rejected
//      promises carrying { code, message }, so `await` + try/catch
//      reports them instead of crashing the host.
//
//   4. Persistent settings (engine 0.4.0): the manifest declares a
//      `mirror` and a `select`, and the plugin reads them from
//      `context.store` — SYNCHRONOUSLY, because the store lives host-side
//      and was loaded once. The engine enforces that a `mirror` value is
//      one of the declared mirrors, so a user cannot point this plugin at
//      a host its manifest never declared.
//
// Multi-plugin fan-out is NOT this plugin's job: an application calls
// `PluginCoordinator.collectSources([...plugins])` to run every source
// plugin at once and merge the results.

/** A catalog page in the shape a scraped source would return. */
const CATALOG = `
<!doctype html><html><body>
  <div id="list">
    <article class="item" data-id="101" data-year="2010">
      <a class="link" href="/watch/101"><span class="name">First Title</span>
        <span class="q">1080p</span></a>
    </article>
    <article class="item" data-id="102" data-year="2021">
      <a class="link" href="/watch/102"><span class="name">Second Title</span>
        <span class="q">720p</span></a>
    </article>
    <article class="item" data-id="103" data-year="2024">
      <a class="link" href="/watch/103"><span class="name">Third Title</span>
        <span class="q">4K</span></a>
    </article>
  </div>
</body></html>`;

/** Live channels are a different kind of result — flagged with isLive. */
const LIVE_CHANNELS = [
  { id: "live-1", title: "Example News 24", url: "/live/news.m3u8", quality: "1080p" },
];

/**
 * Resolves the host to use.
 *
 * `context.store.get` is a synchronous read of the host-side store: the
 * declared default is visible on first run, and a user's stored choice
 * wins afterwards. Every read below is a plain value — no `await`.
 */
function base(context) {
  const host = context.store.get("baseUrl", "cdn.example");
  return `https://${host}`;
}

/** Preferred quality, or "auto" to keep whatever the page says. */
function preferredQuality(context) {
  return context.store.get("quality", "auto");
}

export const plugin = {
  /**
   * Returns RAW source results (the engine normalizes them at the app
   * boundary). Never touches the network: this is a fixture.
   */
  sources(context) {
    const doc = context.html.parse(CATALOG);

    const results = [];
    // Selecting the per-item ARTICLE first, then selecting inside it,
    // is both the natural shape for a catalog page and the reason the
    // handle API accepts an element handle as a select() root.
    for (const item of context.html.select(doc, "#list article.item")) {
      const card = context.html.extract(item);
      const linkHandle = context.html.select(item, "a.link")[0];
      if (linkHandle === undefined) continue; // no link → not a playable item
      const link = context.html.extract(linkHandle);
      const quality = context.html
        .extract(context.html.select(item, ".q")[0])
        .text.trim();

      results.push({
        id: card.data.id,
        // `extract().text` is the element's whole normalized text, which
        // here includes the nested quality span — strip it for display.
        title: link.text.replace(quality, "").trim(),
        type: "source",
        url: base(context) + link.href,
        // The user's preference wins; "auto" keeps the page's own value.
        quality: preferredQuality(context) === "auto" ? quality : preferredQuality(context),
        format: "m3u8",
        // Many media endpoints only serve with the provider's Referer.
        headers: { Referer: `${base(context)}/`, "User-Agent": "StreamPluginEngine/0.4" },
        subtitles: [
          { url: `${base(context)}${link.href}.en.vtt`, language: "en", name: "English" },
        ],
        metadata: { year: Number(card.data.year ?? 0), scraped: true },
      });
    }

    // Live channels are only returned when the user enabled them.
    if (context.store.get("includeLive", false) === true) {
      for (const channel of LIVE_CHANNELS) {
        results.push({
          id: channel.id,
          title: channel.title,
          type: "source",
          url: `${base(context)}${channel.url}`,
          quality: channel.quality,
          format: "m3u8",
          isLive: true, // a continuous stream: no resume, no download
          headers: { Referer: `${base(context)}/` },
          metadata: { live: true },
        });
      }
    }

    // Remember when this plugin last ran, so an app can show "updated …".
    context.store.set("lastRunAt", new Date().toISOString());

    context.log("sources produced", results.length, "results");
    return results;
  },

  /**
   * Demonstrates structured html error handling under the handle API.
   * Returns a report instead of throwing, so the host never sees a
   * crash from a bad selector.
   */
  async inspect(html, context) {
    const report = { parsed: false, matches: 0, error: null };
    try {
      const doc = context.html.parse(html);
      report.parsed = true;
      const links = context.html.select(doc, "a[href]");
      report.matches = links.length;
      if (links.length > 0) {
        report.first = context.html.extract(links[0]).text;
      }
    } catch (error) {
      report.error = { code: error.code, message: error.message };
    }
    return report;
  },

  /** Self-test used by the CLI and the offline suite. */
  test() {
    return "example-media-ok";
  },
};
