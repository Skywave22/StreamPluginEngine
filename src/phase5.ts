/**
 * Phase 5: JSON + HTML parsing capabilities (host-side module).
 *
 * This module is pure host logic: it never touches QuickJS, never
 * executes HTML/JavaScript, never follows URLs, never touches the
 * filesystem, and performs no network requests. The PluginRuntime wires
 * its functions into the controlled context (see src/runtime.ts):
 *
 * - `context.json` is installed as a small static guest-side source
 *   (PHASE5_JSON_GUEST_SOURCE) that wraps the guest's native JSON. No
 *   value crosses the Wasm boundary for JSON work, so there is no host
 *   round-trip and no host object can enter the guest through it.
 * - `context.html` is implemented host-side on top of the mature,
 *   lightweight htmlparser2 + css-select + dom-serializer packages
 *   (the same parser core cheerio is built on). Parsing is data-only:
 *   <script> and <style> contents become plain text nodes, nothing is
 *   executed, and no linked resource is ever fetched.
 *
 * Network access remains exclusively context.http from Phase 4.
 *
 * Guest-facing error contract (structured `{ code, message }` objects,
 * never host stack traces):
 * - context.json.parse / context.json.stringify are SYNCHRONOUS and
 *   THROW a structured error object on failure.
 * - context.html.parse / select / extract are SYNCHRONOUS on success
 *   (they return the value directly) and return a REJECTED PROMISE
 *   carrying a structured error object on failure.
 */
import { DomHandler, Parser } from "htmlparser2";
import {
  Comment as DomComment,
  Document as DomDocument,
  Element as DomElement,
  Text as DomText,
} from "domhandler";
import type { ChildNode, NodeWithChildren, ParentNode } from "domhandler";
import { getText } from "domutils";
import { render as serializeNode } from "dom-serializer";
import { selectAll } from "css-select";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Engine-controlled hard limits. Plugins cannot raise them: inputs are
 * bounded before parsing, node counts are bounded during parsing, and
 * selector result counts are bounded before serialization.
 */
export const PHASE5_LIMITS = {
  /** Maximum UTF-8 byte length of an HTML string passed to html.parse. */
  maxHtmlBytes: 5 * 1024 * 1024,
  /** Maximum length (in UTF-16 units) of JSON text / serialized output. */
  maxJsonBytes: 5 * 1024 * 1024,
  /** Maximum total node count (elements + text + comments) for one document. */
  maxHtmlNodes: 50_000,
  /** Maximum number of elements returned by one html.select call. */
  maxSelectResults: 1_000,
} as const;

// ---------------------------------------------------------------------------
// Structured errors
// ---------------------------------------------------------------------------

/** Structured error codes produced by the Phase 5 capabilities. */
export const PHASE5_ERROR_CODES = [
  /** Argument of the wrong type (e.g. parse received a non-string). */
  "JSON_INVALID_INPUT",
  /** JSON input exceeds PHASE5_LIMITS.maxJsonBytes. */
  "JSON_INPUT_TOO_LARGE",
  /** The input text is not valid JSON. */
  "JSON_INVALID",
  /** JSON output exceeds PHASE5_LIMITS.maxJsonBytes. */
  "JSON_OUTPUT_TOO_LARGE",
  /** The value is not JSON-serializable (circular structure, top-level
   * undefined or function). */
  "JSON_STRINGIFY_ERROR",
  /** Argument of the wrong type for an html.* call. */
  "HTML_INVALID_INPUT",
  /** HTML input exceeds PHASE5_LIMITS.maxHtmlBytes. */
  "HTML_INPUT_TOO_LARGE",
  /** The HTML could not be parsed (malformed beyond tolerance, node
   * limit exceeded, structure too deep). */
  "HTML_PARSE_ERROR",
  /** The selector argument is missing or empty. */
  "HTML_INVALID_SELECTOR",
  /** The selector is invalid, or the document argument is not a parsed
   * document/element. */
  "HTML_SELECT_ERROR",
  /** The extract() argument is missing. */
  "HTML_INVALID_ELEMENT",
  /** The extract() argument is not a parsed element, or extraction
   * failed. */
  "HTML_EXTRACT_ERROR",
  /** A selector matched more than PHASE5_LIMITS.maxSelectResults elements. */
  "HTML_TOO_MANY_RESULTS",
] as const;

export type Phase5ErrorCode = (typeof PHASE5_ERROR_CODES)[number];

/** The structured error shape plugins see (thrown or in a rejection). */
export interface Phase5ErrorObject {
  code: Phase5ErrorCode;
  message: string;
}

/** Internal host-side error carrying a Phase 5 code. */
export class Phase5Error extends Error {
  constructor(
    readonly code: Phase5ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "Phase5Error";
  }
}

// ---------------------------------------------------------------------------
// Document tree shape (guest-visible; JSON-serializable)
// ---------------------------------------------------------------------------

export interface HtmlDocument {
  type: "document";
  children: HtmlNode[];
}
export type HtmlNode = HtmlElement | HtmlText | HtmlComment;
export interface HtmlText {
  type: "text";
  text: string;
}
export interface HtmlComment {
  type: "comment";
  text: string;
}
export interface HtmlElement {
  type: "element";
  tagName: string;
  attributes: Record<string, string>;
  children: HtmlNode[];
}
export interface HtmlElementInfo {
  tagName: string;
  /** Normalized (whitespace-collapsed, trimmed) descendant text. */
  text: string;
  attributes: Record<string, string>;
  href?: string;
  src?: string;
  class?: string;
  id?: string;
  /** `data-*` attributes without the `data-` prefix. */
  data: Record<string, string>;
  innerHTML: string;
  outerHTML: string;
}

// ---------------------------------------------------------------------------
// HTML parsing (htmlparser2, with bounded node counting)
// ---------------------------------------------------------------------------

/**
 * Parse an HTML string into the guest-visible tree.
 *
 * Uses htmlparser2 (mature, permissive, browser-like error recovery).
 * The node count is bounded DURING parsing via the counting handlers:
 * a pathological document aborts as soon as the limit is exceeded
 * instead of being fully materialized.
 */
export function parseHtml(source: string): HtmlDocument {
  const dom = new DomHandler();
  let nodes = 1; // the document root
  const count = (): void => {
    nodes += 1;
    if (nodes > PHASE5_LIMITS.maxHtmlNodes) {
      throw new Phase5Error(
        "HTML_PARSE_ERROR",
        `HTML node limit exceeded (${PHASE5_LIMITS.maxHtmlNodes})`,
      );
    }
  };
  // Wrap the tree-building handlers with a node counter. Every handler
  // that creates a node counts it, so the guest-tree node count and the
  // counted budget can never diverge. The Parser propagates handler
  // errors (unlike the parseDocument convenience wrapper), so the limit
  // aborts the parse immediately.
  const originalOpen = dom.onopentag.bind(dom);
  const originalText = dom.ontext.bind(dom);
  const originalComment = dom.oncomment.bind(dom);
  const originalPi = dom.onprocessinginstruction.bind(dom);
  dom.onopentag = (name, attribs) => {
    count();
    originalOpen(name, attribs);
  };
  dom.ontext = (text) => {
    count();
    originalText(text);
  };
  dom.oncomment = (text) => {
    count();
    originalComment(text);
  };
  dom.onprocessinginstruction = (name, value) => {
    count();
    originalPi(name, value);
  };
  // (CDATA never occurs in HTML mode — it parses as a comment, which the
  // oncomment counter above already accounts for.)

  const parser = new Parser(dom);
  parser.write(source);
  parser.end();

  return domToTree(dom.root);
}

/**
 * Iteratively convert domhandler child nodes into guest-tree nodes,
 * appending them to `into`. Single implementation shared by document
 * and element conversion. Depth is bounded only by the node budget, not
 * by the host call stack.
 *
 * Notes: <script>/<style> elements carry domhandler types "script"/
 * "style" and their contents are raw text data (never executed); CDATA
 * content lives in its text children; processing instructions are
 * dropped (data-only simplification for an HTML data model).
 */
function convertDomChildren(
  into: HtmlNode[],
  children: readonly ChildNode[],
): void {
  const pending: Array<{ into: HtmlNode[]; node: ChildNode }> = [];
  for (let i = children.length - 1; i >= 0; i--) {
    pending.push({ into, node: children[i]! });
  }
  while (pending.length > 0) {
    const { into: target, node } = pending.pop()!;
    if (node.type === "tag" || node.type === "script" || node.type === "style") {
      const el: HtmlElement = {
        type: "element",
        tagName: node.name,
        attributes: { ...node.attribs },
        children: [],
      };
      target.push(el);
      const kids = node.children;
      for (let i = kids.length - 1; i >= 0; i--) {
        pending.push({ into: el.children, node: kids[i]! });
      }
    } else if (node.type === "cdata") {
      let text = "";
      for (const c of node.children) {
        if (c.type === "text") text += c.data;
      }
      target.push({ type: "text", text });
    } else if (node.type === "text") {
      target.push({ type: "text", text: node.data });
    } else if (node.type === "comment") {
      target.push({ type: "comment", text: node.data });
    } else {
      target.push({ type: "text", text: "" });
    }
  }
}

function domToTree(root: NodeWithChildren): HtmlDocument {
  const doc: HtmlDocument = { type: "document", children: [] };
  convertDomChildren(doc.children, root.children);
  return doc;
}

function domElementToTree(el: DomElement): HtmlElement {
  const out: HtmlElement = {
    type: "element",
    tagName: el.name,
    attributes: { ...el.attribs },
    children: [],
  };
  convertDomChildren(out.children, el.children);
  return out;
}

// ---------------------------------------------------------------------------
// Validation of guest-supplied trees (select/extract arguments)
// ---------------------------------------------------------------------------

function validateNodeTree(root: unknown): asserts root is HtmlNode {
  // ITERATIVE (explicit stack): guest-supplied trees can be as deep as
  // the parser's node budget; recursion would overflow the stack first.
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (typeof node !== "object" || node === null) {
      throw new Phase5Error("HTML_SELECT_ERROR", "invalid element structure");
    }
    const n = node as Record<string, unknown>;
    if (n.type === "text" || n.type === "comment") {
      if (typeof n.text !== "string") {
        throw new Phase5Error("HTML_SELECT_ERROR", "invalid element structure");
      }
      continue;
    }
    if (n.type !== "element") {
      throw new Phase5Error("HTML_SELECT_ERROR", "invalid element structure");
    }
    if (typeof n.tagName !== "string" || n.tagName.length === 0) {
      throw new Phase5Error("HTML_SELECT_ERROR", "invalid element structure");
    }
    if (typeof n.attributes !== "object" || n.attributes === null) {
      throw new Phase5Error("HTML_SELECT_ERROR", "invalid element structure");
    }
    const attrs = n.attributes as Record<string, unknown>;
    if (Object.keys(attrs).length > 1024) {
      throw new Phase5Error("HTML_SELECT_ERROR", "invalid element structure");
    }
    for (const value of Object.values(attrs)) {
      if (typeof value !== "string") {
        throw new Phase5Error("HTML_SELECT_ERROR", "invalid element structure");
      }
    }
    if (!Array.isArray(n.children)) {
      throw new Phase5Error("HTML_SELECT_ERROR", "invalid element structure");
    }
    const children = n.children as unknown[];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]);
    }
  }
}

function validateDocumentOrElement(root: unknown): HtmlDocument | HtmlElement {
  if (typeof root !== "object" || root === null) {
    throw new Phase5Error(
      "HTML_SELECT_ERROR",
      "document argument is not a parsed HTML document or element",
    );
  }
  const r = root as Record<string, unknown>;
  if (r.type === "document") {
    if (!Array.isArray(r.children)) {
      throw new Phase5Error(
        "HTML_SELECT_ERROR",
        "document argument is not a parsed HTML document or element",
      );
    }
    for (const child of r.children as unknown[]) {
      validateNodeTree(child);
    }
    return root as HtmlDocument;
  }
  validateNodeTree(root);
  return root as HtmlElement;
}

// ---------------------------------------------------------------------------
// Selecting (css-select on a rebuilt domhandler tree)
// ---------------------------------------------------------------------------

/**
 * Wire parent/prev/next sibling pointers on a rebuilt parent node.
 * css-select resolves descendant combinator matching by walking these
 * ancestor links, so every rebuilt tree must be fully wired.
 */
function wireChildren(parent: ParentNode): void {
  let prev: ChildNode | null = null;
  for (const child of parent.children) {
    child.parent = parent;
    child.prev = prev;
    if (prev !== null) {
      prev.next = child;
    }
    prev = child;
  }
}

function makeDomNode(node: HtmlNode): ChildNode {
  if (node.type === "text") {
    return new DomText(node.text);
  }
  if (node.type === "comment") {
    return new DomComment(node.text);
  }
  return new DomElement(node.tagName, { ...node.attributes });
}

/**
 * Rebuild a domhandler tree from a (validated) JSON tree so the mature
 * css-select engine can run on it.
 *
 * ITERATIVE (explicit stack): guest-supplied trees can be as deep as the
 * parser's node budget; recursion would overflow the stack first.
 */
function domFromJson(rootNode: HtmlNode): ChildNode {
  const root = makeDomNode(rootNode);
  if (rootNode.type !== "element") {
    return root;
  }
  const rootParent = root as DomElement;
  const parents: ParentNode[] = [rootParent];
  const pending: Array<{ parent: DomElement; child: HtmlNode }> = [];
  for (let i = rootNode.children.length - 1; i >= 0; i--) {
    pending.push({ parent: rootParent, child: rootNode.children[i]! });
  }
  while (pending.length > 0) {
    const { parent, child } = pending.pop()!;
    const domChild = makeDomNode(child);
    parent.children.push(domChild);
    if (child.type === "element") {
      const el = domChild as DomElement;
      parents.push(el);
      for (let i = child.children.length - 1; i >= 0; i--) {
        pending.push({ parent: el, child: child.children[i]! });
      }
    }
  }
  // Every parent is wired independently, so creation order is irrelevant.
  for (const parent of parents) {
    wireChildren(parent);
  }
  return root;
}

function toInfoDom(el: DomElement): HtmlElementInfo {
  const data: Record<string, string> = {};
  for (const key of Object.keys(el.attribs)) {
    const value = el.attribs[key];
    if (value === undefined) continue;
    if (key.startsWith("data-")) {
      data[key.slice(5)] = value;
    }
  }
  return {
    tagName: el.name,
    text: normalizeWhitespace(getText(el)),
    attributes: { ...el.attribs },
    href: el.attribs.href,
    src: el.attribs.src,
    class: el.attribs.class,
    id: el.attribs.id,
    data,
    innerHTML: el.children.map((c) => serializeNode(c)).join(""),
    outerHTML: serializeNode(el),
  };
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Select elements in a parsed document/element tree using a CSS
 * selector. Returns the matched ELEMENTS (guest-tree nodes) so plugins
 * can pass them to extractHtml. Invalid selectors and invalid document
 * arguments produce Phase5Error (HTML_SELECT_ERROR). Matches are
 * bounded by PHASE5_LIMITS.maxSelectResults.
 */
export function selectHtml(root: unknown, selector: string): HtmlElement[] {
  if (typeof selector !== "string" || selector.trim() === "") {
    throw new Phase5Error(
      "HTML_INVALID_SELECTOR",
      "html.select() requires a non-empty selector string",
    );
  }
  const docRoot = validateDocumentOrElement(root);

  let domRoot: NodeWithChildren;
  if (docRoot.type === "document") {
    const docNode = new DomDocument([]);
    for (const child of docRoot.children) {
      docNode.children.push(domFromJson(child));
    }
    wireChildren(docNode);
    domRoot = docNode;
  } else {
    // validateDocumentOrElement guarantees an element here, which
    // domFromJson rebuilds as a DomElement (a NodeWithChildren).
    domRoot = domFromJson(docRoot) as NodeWithChildren;
  }

  let matches: DomElement[];
  try {
    matches = selectAll(selector, domRoot) as unknown as DomElement[];
  } catch (error) {
    throw new Phase5Error(
      "HTML_SELECT_ERROR",
      `Invalid selector: ${errorMessage(error)}`,
    );
  }
  if (matches.length > PHASE5_LIMITS.maxSelectResults) {
    throw new Phase5Error(
      "HTML_TOO_MANY_RESULTS",
      `Selector matched ${matches.length} elements; the maximum is ${PHASE5_LIMITS.maxSelectResults}`,
    );
  }
  return matches.map(domElementToTree);
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extract the JSON-serializable info object for one parsed element.
 */
export function extractHtml(element: unknown): HtmlElementInfo {
  if (typeof element !== "object" || element === null) {
    throw new Phase5Error(
      "HTML_INVALID_ELEMENT",
      "html.extract() requires a parsed element",
    );
  }
  const el = element as Record<string, unknown>;
  if (el.type !== "element") {
    throw new Phase5Error(
      "HTML_EXTRACT_ERROR",
      "html.extract() requires an element (not a document or text node)",
    );
  }
  validateNodeTree(element);
  return toInfoDom(domFromJson(element as HtmlElement) as DomElement);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Guest-side JSON capability (static engine source)
// ---------------------------------------------------------------------------

/**
 * Guest-side source of the `context.json` capability.
 *
 * Evaluated once per capability call by the runtime into the guest.
 * The code is a static engine constant: it references no plugin data,
 * no host identifiers, and no globals other than `JSON` and `Object`.
 * Error codes and the size limit are injected from the TS constants so
 * the host and guest sides can never drift apart.
 *
 * The functions wrap the guest's native JSON (no host round-trip):
 * `parse` never evaluates code, and `stringify` reports circular
 * structures as a structured error instead of silently dropping them.
 */
export const PHASE5_JSON_GUEST_SOURCE = `(function () {
  const CODES = ${JSON.stringify({
    invalidInput: "JSON_INVALID_INPUT",
    inputTooLarge: "JSON_INPUT_TOO_LARGE",
    invalid: "JSON_INVALID",
    outputTooLarge: "JSON_OUTPUT_TOO_LARGE",
    stringifyError: "JSON_STRINGIFY_ERROR",
  })};
  const MAX_BYTES = ${PHASE5_LIMITS.maxJsonBytes};
  return {
    parse: function parse(text) {
      if (typeof text !== "string") {
        throw {
          code: CODES.invalidInput,
          message: "json.parse(text) requires a string",
        };
      }
      if (text.length > MAX_BYTES) {
        throw {
          code: CODES.inputTooLarge,
          message: "JSON input exceeds 5 MiB",
        };
      }
      try {
        return JSON.parse(text);
      } catch (e) {
        throw {
          code: CODES.invalid,
          message: "Invalid JSON" + (e && e.message ? ": " + e.message : ""),
        };
      }
    },
    stringify: function stringify(value) {
      if (arguments.length === 0) {
        throw {
          code: CODES.invalidInput,
          message: "json.stringify(value) requires a value argument",
        };
      }
      let out;
      try {
        out = JSON.stringify(value);
      } catch (e) {
        throw {
          code: CODES.stringifyError,
          message:
            "Value is not JSON-serializable" +
            (e && e.message ? ": " + e.message : ""),
        };
      }
      if (typeof out !== "string") {
        throw {
          code: CODES.invalidInput,
          message:
            "Value is not JSON-serializable (top-level undefined or function)",
        };
      }
      if (out.length > MAX_BYTES) {
        throw {
          code: CODES.outputTooLarge,
          message: "JSON output exceeds 5 MiB",
        };
      }
      return out;
    },
  };
})()`;
