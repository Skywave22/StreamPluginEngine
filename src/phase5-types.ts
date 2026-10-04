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

/**
 * `context.html` for plugins whose manifest declares `apiVersion: 2`
 * (or higher, up to the engine's ENGINE_API_VERSION).
 *
 * The document tree stays HOST-SIDE; the guest only ever handles opaque
 * numeric handles. This is the fast path:
 *
 * ```js
 * const doc = context.html.parse(html);      // → 3      (document handle)
 * const items = context.html.select(doc, ".item"); // → [4, 5] (element handles)
 * const first = context.html.extract(items[0]);    // → info object
 * ```
 *
 * Why it is faster: version 1 serialized the whole tree into the guest
 * and serialized matched nodes back out on every call, so the Wasm
 * boundary — not the parser — dominated. Handles make each call's
 * payload a few integers.
 *
 * Behaviour differences from version 1, all deliberate:
 * - Handles are valid for the duration of ONE capability call. Storing
 *   one on the plugin object and reusing it in a later call fails with
 *   `{ code: "HTML_STALE_HANDLE" }` — handles are not cross-operation
 *   state.
 * - A handle table is bounded (PHASE5_LIMITS.maxHtmlHandles per call);
 *   exceeding it fails with `HTML_HANDLE_LIMIT`.
 * - Nesting depth is no longer limited to ~500 levels, because no value
 *   is delivered into the guest.
 * - `select`/`extract` no longer accept hand-built document/element
 *   objects; only handles produced by this API.
 *
 * Error contract is unchanged: synchronous return on success, a REJECTED
 * promise carrying a structured `{ code, message }` object on failure.
 */
export interface PluginHtml2 {
  /**
   * Parse a bounded HTML string (5 MiB, 50 000 nodes) and return a
   * numeric document handle. Errors: `HTML_INVALID_INPUT`,
   * `HTML_INPUT_TOO_LARGE`, `HTML_PARSE_ERROR`, `HTML_HANDLE_LIMIT`.
   */
  parse(html: string): number;
  /**
   * Select elements matching a CSS selector inside a document (or
   * element) handle. Returns numeric element handles (at most 1 000).
   * Errors: `HTML_INVALID_SELECTOR`, `HTML_SELECT_ERROR`,
   * `HTML_TOO_MANY_RESULTS`, `HTML_STALE_HANDLE`, `HTML_HANDLE_LIMIT`.
   */
  select(documentHandle: number, selector: string): number[];
  /**
   * Return the normalized info object for an element handle. Errors:
   * `HTML_INVALID_ELEMENT`, `HTML_EXTRACT_ERROR`, `HTML_STALE_HANDLE`.
   */
  extract(elementHandle: number): {
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
