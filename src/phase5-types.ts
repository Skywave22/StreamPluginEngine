/**
 * Phase 5 parsing API types (the guest-facing context surface).
 *
 * Error contract — structured `{ code, message }` objects, never host
 * stack traces (see PHASE5_ERROR_CODES in src/phase5.ts):
 * - `context.json.parse` / `context.json.stringify` are SYNCHRONOUS and
 *   THROW a structured error object on failure — catch it in the plugin.
 * - `context.html.parse` / `select` / `extract` return their value
 *   directly on success and return a REJECTED PROMISE carrying a
 *   structured error object on failure.
 */
export interface PluginJson {
  /**
   * Parse a bounded JSON text and return the value (synchronous).
   * Throws `{ code: "JSON_INVALID", message }` for malformed text,
   * `{ code: "JSON_INVALID_INPUT" }` for non-string input, and
   * `{ code: "JSON_INPUT_TOO_LARGE" }` beyond the 5 MiB input limit.
   * Parsing is a pure data operation: it never evaluates code.
   */
  parse<T = unknown>(text: string): T;
  /**
   * Serialize a JSON-safe value into a JSON string (synchronous).
   * Throws `{ code: "JSON_STRINGIFY_ERROR" }` for unserializable values
   * (circular structures) and `{ code: "JSON_OUTPUT_TOO_LARGE" }`
   * beyond the 5 MiB output limit.
   */
  stringify(value: unknown): string;
}

export interface PluginHtml {
  /**
   * Parse an HTML string (bounded to 5 MiB, 50 000 nodes) into a
   * JSON-serializable document tree. Synchronous on success; returns a
   * rejected promise on failure (e.g. `{ code: "HTML_INPUT_TOO_LARGE" }`,
   * `{ code: "HTML_PARSE_ERROR" }`). Parsing is data-only: no script or
   * event-handler execution, no resource loading.
   */
  parse(html: string): Promise<unknown> | unknown;
  /**
   * Select elements with a CSS selector (tag, .class, #id, tag.class,
   * descendant and basic attribute selectors). Returns the matched
   * ELEMENTS (parsed-tree nodes) — pass them to `extract` for the
   * normalized info objects. Synchronous on success; returns a rejected
   * promise on failure (invalid selector, non-document argument, or more
   * than 1 000 matches).
   */
  select(document: unknown, selector: string): Promise<unknown[]> | unknown[];
  /**
   * Extract the normalized, JSON-serializable info object for one
   * parsed element. Synchronous on success; returns a rejected promise
   * on failure.
   */
  extract(element: unknown): Promise<{
    tagName: string;
    text: string;
    attributes: Record<string, string>;
    href?: string;
    src?: string;
    class?: string;
    id?: string;
    data: Record<string, string>;
    innerHTML: string;
    outerHTML: string;
  }> | {
    tagName: string;
    text: string;
    attributes: Record<string, string>;
    href?: string;
    src?: string;
    class?: string;
    id?: string;
    data: Record<string, string>;
    innerHTML: string;
    outerHTML: string;
  };
}
