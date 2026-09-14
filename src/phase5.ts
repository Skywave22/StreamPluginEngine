/**
 * Phase 5: JSON + HTML parsing capabilities.
 *
 * Data-only parsing. This module never executes HTML/JavaScript, follows
 * URLs, touches the filesystem, or performs network requests.
 *
 * Network access remains exclusively context.http from Phase 4.
 */
import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten";
import { PluginRuntime } from "./runtime.js";

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_JSON_BYTES = 5 * 1024 * 1024;
const MAX_HTML_NODES = 50_000;

type Disposable = { alive: boolean; dispose(): void };
type ContextBuilder = (
  this: PluginRuntime,
  context: QuickJSContext,
  handle: unknown,
  tracked: Disposable[],
  opAbort: AbortController,
) => QuickJSHandle;

export interface HtmlDocument {
  type: "document";
  children: HtmlNode[];
}
export type HtmlNode = HtmlElement | HtmlText | HtmlComment;
export interface HtmlText { type: "text"; text: string }
export interface HtmlComment { type: "comment"; text: string }
export interface HtmlElement {
  type: "element";
  tagName: string;
  attributes: Record<string, string>;
  children: HtmlNode[];
}
export interface HtmlElementInfo {
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
}

let installed = false;

/** Install Phase 5 capabilities once for this process. */
export function installPhase5Capabilities(): void {
  if (installed) return;

  const prototype = PluginRuntime.prototype as unknown as Record<string, unknown>;
  const original = prototype["buildPluginContext"];
  if (typeof original !== "function") {
    throw new Error("Phase 5: PluginRuntime context builder not found");
  }

  const build = original as ContextBuilder;
  prototype["buildPluginContext"] = function (
    context: QuickJSContext,
    handle: unknown,
    tracked: Disposable[],
    opAbort: AbortController,
  ): QuickJSHandle {
    const contextObject = build.call(this, context, handle, tracked, opAbort);

    const jsonObject = track(context.newObject(), tracked);

    const jsonParse = track(
      context.newFunction("parse", (arg?: QuickJSHandle) => {
        if (!arg || context.typeof(arg) !== "string") {
          return rejected(
            context,
            "JSON_INVALID_INPUT",
            "json.parse() requires a string",
          );
        }
        const text = context.getString(arg);
        if (utf8Length(text) > MAX_JSON_BYTES) {
          return rejected(
            context,
            "JSON_INPUT_TOO_LARGE",
            "JSON input exceeds 5 MiB",
          );
        }
        try {
          return jsonLiteral(context, JSON.parse(text));
        } catch (error) {
          return rejected(context, "JSON_INVALID", errorMessage(error));
        }
      }),
      tracked,
    );

    const jsonStringify = track(
      context.newFunction("stringify", (arg?: QuickJSHandle) => {
        try {
          const value = arg ? context.dump(arg) : undefined;
          const text = JSON.stringify(value);
          if (text === undefined) return context.newString("undefined");
          if (utf8Length(text) > MAX_JSON_BYTES) {
            return rejected(
              context,
              "JSON_OUTPUT_TOO_LARGE",
              "JSON output exceeds 5 MiB",
            );
          }
          return context.newString(text);
        } catch (error) {
          return rejected(
            context,
            "JSON_STRINGIFY_ERROR",
            errorMessage(error),
          );
        }
      }),
      tracked,
    );

    context.setProp(jsonObject, "parse", jsonParse);
    context.setProp(jsonObject, "stringify", jsonStringify);

    const htmlObject = track(context.newObject(), tracked);

    const htmlParse = track(
      context.newFunction("parse", (arg?: QuickJSHandle) => {
        if (!arg || context.typeof(arg) !== "string") {
          return rejected(
            context,
            "HTML_INVALID_INPUT",
            "html.parse() requires a string",
          );
        }
        const html = context.getString(arg);
        if (utf8Length(html) > MAX_HTML_BYTES) {
          return rejected(
            context,
            "HTML_INPUT_TOO_LARGE",
            "HTML input exceeds 5 MiB",
          );
        }
        try {
          return jsonLiteral(context, parseHtml(html));
        } catch (error) {
          return rejected(context, "HTML_PARSE_ERROR", errorMessage(error));
        }
      }),
      tracked,
    );

    const htmlSelect = track(
      context.newFunction(
        "select",
        (docArg?: QuickJSHandle, selectorArg?: QuickJSHandle) => {
          if (
            !docArg ||
            !selectorArg ||
            context.typeof(selectorArg) !== "string"
          ) {
            return rejected(
              context,
              "HTML_INVALID_SELECTOR",
              "html.select(document, selector) requires a selector string",
            );
          }
          try {
            const root = context.dump(docArg) as HtmlDocument | HtmlElement;
            const selector = context.getString(selectorArg);
            return jsonLiteral(
              context,
              selectHtml(root, selector).map(toInfo),
            );
          } catch (error) {
            return rejected(context, "HTML_SELECT_ERROR", errorMessage(error));
          }
        },
      ),
      tracked,
    );

    const htmlExtract = track(
      context.newFunction("extract", (elementArg?: QuickJSHandle) => {
        if (!elementArg) {
          return rejected(
            context,
            "HTML_INVALID_ELEMENT",
            "html.extract() requires an element",
          );
        }
        try {
          return jsonLiteral(
            context,
            toInfo(context.dump(elementArg) as HtmlElement),
          );
        } catch (error) {
          return rejected(context, "HTML_EXTRACT_ERROR", errorMessage(error));
        }
      }),
      tracked,
    );

    context.setProp(htmlObject, "parse", htmlParse);
    context.setProp(htmlObject, "select", htmlSelect);
    context.setProp(htmlObject, "extract", htmlExtract);
    context.setProp(contextObject, "json", jsonObject);
    context.setProp(contextObject, "html", htmlObject);

    installed = true;
    return contextObject;
  };
}

function track<T extends Disposable>(value: T, list: Disposable[]): T {
  list.push(value);
  return value;
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonLiteral(context: QuickJSContext, value: unknown): QuickJSHandle {
  const json = JSON.stringify(value);
  if (json === undefined) return context.undefined;
  const result = context.evalCode(`(${json})`, "phase5-data", {
    type: "global",
  });
  return context.unwrapResult(result);
}

function rejected(
  context: QuickJSContext,
  code: string,
  message: string,
): QuickJSHandle {
  const result = context.evalCode(
    `Promise.reject(${JSON.stringify({ code, message })})`,
    "phase5-error",
    { type: "global" },
  );
  return context.unwrapResult(result);
}

function parseHtml(source: string): HtmlDocument {
  const root: HtmlDocument = { type: "document", children: [] };
  const stack: HtmlElement[] = [];
  let nodes = 1;
  let i = 0;

  const children = (): HtmlNode[] =>
    stack.length ? stack[stack.length - 1].children : root.children;

  const add = (node: HtmlNode): void => {
    nodes += 1;
    if (nodes > MAX_HTML_NODES) throw new Error("HTML_NODE_LIMIT");
    children().push(node);
  };

  while (i < source.length) {
    const lt = source.indexOf("<", i);

    if (lt < 0) {
      if (i < source.length) {
        add({ type: "text", text: decodeEntities(source.slice(i)) });
      }
      break;
    }

    if (lt > i) {
      add({
        type: "text",
        text: decodeEntities(source.slice(i, lt)),
      });
    }

    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      add({
        type: "comment",
        text: source.slice(lt + 4, end < 0 ? source.length : end),
      });
      i = end < 0 ? source.length : end + 3;
      continue;
    }

    const gt = source.indexOf(">", lt + 1);
    if (gt < 0) {
      add({
        type: "text",
        text: decodeEntities(source.slice(lt)),
      });
      break;
    }

    const raw = source.slice(lt + 1, gt).trim();

    if (
      /^!doctype\b/i.test(raw) ||
      /^\?/.test(raw) ||
      /^!/.test(raw)
    ) {
      i = gt + 1;
      continue;
    }

    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim().split(/\s+/)[0]?.toLowerCase();
      if (name) {
        for (let n = stack.length - 1; n >= 0; n -= 1) {
          if (stack[n].tagName === name) {
            stack.length = n;
            break;
          }
        }
      }
      i = gt + 1;
      continue;
    }

    const selfClosing = /\/\s*$/.test(raw);
    const clean = raw.replace(/\/\s*$/, "");
    const nameMatch = /^([^\s/>]+)/.exec(clean);

    if (!nameMatch) {
      i = gt + 1;
      continue;
    }

    const tagName = nameMatch[1].toLowerCase();
    const attributes: Record<string, string> = {};
    const rest = clean.slice(nameMatch[0].length);

    const attrRe =
      /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

    let match: RegExpExecArray | null;
    while ((match = attrRe.exec(rest)) !== null) {
      attributes[match[1].toLowerCase()] = decodeEntities(
        match[2] ?? match[3] ?? match[4] ?? "",
      );
    }

    const element: HtmlElement = {
      type: "element",
      tagName,
      attributes,
      children: [],
    };

    add(element);

    const voidTag =
      /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(
        tagName,
      );

    if (!selfClosing && !voidTag) stack.push(element);

    i = gt + 1;

    // Treat script/style as raw text. Never execute their contents.
    if (tagName === "script" || tagName === "style") {
      const close = new RegExp(`</${tagName}\\s*>`, "ig");
      close.lastIndex = i;
      const found = close.exec(source);
      const end = found ? found.index : source.length;

      if (end > i) {
        add({ type: "text", text: source.slice(i, end) });
      }

      i = found ? found.index + found[0].length : source.length;

      if (stack[stack.length - 1] === element) stack.pop();
    }
  }

  return root;
}

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi,
    (all, name: string) => {
      const n = name.toLowerCase();

      if (n === "amp") return "&";
      if (n === "lt") return "<";
      if (n === "gt") return ">";
      if (n === "quot") return '"';
      if (n === "apos") return "'";
      if (n === "nbsp") return "\u00a0";

      const code =
        n[1] === "x"
          ? parseInt(n.slice(2), 16)
          : parseInt(n.slice(1), 10);

      return Number.isFinite(code) && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : all;
    },
  );
}

interface SelectorPart {
  tag?: string;
  id?: string;
  classes: string[];
  attr?: { name: string; value?: string };
}

function parseSelector(selector: string): SelectorPart[] {
  const parts = selector.trim().split(/\s+/);
  if (!selector.trim()) throw new Error("invalid selector");
  return parts.map(parseSelectorPart);
}

function parseSelectorPart(part: string): SelectorPart {
  const attrMatch =
    /\[([^=\]]+)(?:=["']?([^\]"']+)["']?)?\]/.exec(part);

  const attr = attrMatch
    ? {
        name: attrMatch[1].toLowerCase(),
        value: attrMatch[2],
      }
    : undefined;

  const base = part.replace(/\[[^\]]+\]/g, "");
  const id = /#([\w-]+)/.exec(base)?.[1];
  const classes = [...base.matchAll(/\.([\w-]+)/g)].map(
    (m) => m[1],
  );
  const tag = /^[a-zA-Z][\w-]*/.exec(base)?.[0]?.toLowerCase();

  if (!tag && !id && classes.length === 0 && !attr) {
    throw new Error("invalid selector");
  }

  return { tag, id, classes, attr };
}

function matches(element: HtmlElement, part: SelectorPart): boolean {
  if (part.tag && element.tagName !== part.tag) return false;
  if (part.id && element.attributes.id !== part.id) return false;

  const classes = (element.attributes.class ?? "")
    .split(/\s+/)
    .filter(Boolean);

  if (part.classes.some((c) => !classes.includes(c))) return false;

  if (part.attr && !(part.attr.name in element.attributes)) return false;

  if (
    part.attr?.value !== undefined &&
    element.attributes[part.attr.name] !== part.attr.value
  ) {
    return false;
  }

  return true;
}

function selectHtml(
  root: HtmlDocument | HtmlElement,
  selector: string,
): HtmlElement[] {
  const parts = parseSelector(selector);
  const result: HtmlElement[] = [];

  const walk = (nodes: HtmlNode[], ancestors: HtmlElement[]): void => {
    for (const node of nodes) {
      if (node.type !== "element") continue;

      const last = parts.length - 1;

      if (matches(node, parts[last])) {
        let ai = ancestors.length - 1;
        let pi = last - 1;

        while (pi >= 0) {
          while (ai >= 0 && !matches(ancestors[ai], parts[pi])) {
            ai -= 1;
          }

          if (ai < 0) break;

          ai -= 1;
          pi -= 1;
        }

        if (pi < 0) result.push(node);
      }

      walk(node.children, [...ancestors, node]);
    }
  };

  walk(root.children, []);
  return result;
}

function textContent(element: HtmlElement): string {
  let text = "";

  const walk = (nodes: HtmlNode[]): void => {
    for (const node of nodes) {
      if (node.type === "text") text += node.text;
      else if (node.type === "element") walk(node.children);
    }
  };

  walk(element.children);
  return text.replace(/\s+/g, " ").trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function serialize(node: HtmlNode): string {
  if (node.type === "text") return escapeHtml(node.text);
  if (node.type === "comment") return `<!--${node.text}-->`;

  const attrs = Object.entries(node.attributes)
    .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
    .join("");

  const voidTag =
    /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(
      node.tagName,
    );

  if (voidTag) return `<${node.tagName}${attrs}>`;

  return `<${node.tagName}${attrs}>${node.children
    .map(serialize)
    .join("")}</${node.tagName}>`;
}

function toInfo(element: HtmlElement): HtmlElementInfo {
  const data: Record<string, string> = {};

  for (const [key, value] of Object.entries(element.attributes)) {
    if (key.startsWith("data-")) data[key.slice(5)] = value;
  }

  return {
    tagName: element.tagName,
    text: textContent(element),
    attributes: { ...element.attributes },
    href: element.attributes.href,
    src: element.attributes.src,
    class: element.attributes.class,
    id: element.attributes.id,
    data,
    innerHTML: element.children.map(serialize).join(""),
    outerHTML: serialize(element),
  };
}
