/**
 * Phase 5 — host-level unit tests for the pure parsing functions
 * (src/phase5.ts). These run entirely on the host (no QuickJS), so they
 * verify the parser/selector/serializer behavior directly and quickly.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PHASE5_ERROR_CODES,
  PHASE5_LIMITS,
  Phase5Error,
  extractHtml,
  parseHtml,
  selectHtml,
} from "../src/phase5.js";
import type {
  HtmlComment,
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  HtmlText,
} from "../src/phase5.js";

// --- small type-safe helpers (strict index access) -------------------------

function child(node: HtmlDocument | HtmlElement, i: number): HtmlNode {
  const c = node.children[i];
  assert.ok(c, `expected child #${i}`);
  return c;
}
function asElement(node: HtmlNode): HtmlElement {
  assert.equal(node.type, "element", `expected element, got ${node.type}`);
  return node;
}
function asText(node: HtmlNode): HtmlText {
  assert.equal(node.type, "text", `expected text, got ${node.type}`);
  return node;
}
function asComment(node: HtmlNode): HtmlComment {
  assert.equal(node.type, "comment", `expected comment, got ${node.type}`);
  return node;
}
function assertPhase5Error(
  fn: () => unknown,
  code: string,
): void {
  assert.throws(
    fn,
    (error: unknown) => {
      assert.ok(error instanceof Phase5Error, "expected Phase5Error");
      assert.equal(error.code, code);
      return true;
    },
  );
}

// ---------------------------------------------------------------------------
// parseHtml
// ---------------------------------------------------------------------------

test("parseHtml: basic structure, attributes, and text", () => {
  const doc = parseHtml(
    '<div id="root"><a class="link" href="/x" data-id="7">  Hello  World </a></div>',
  );
  assert.equal(doc.type, "document");
  assert.equal(doc.children.length, 1);
  const div = asElement(child(doc, 0));
  assert.equal(div.tagName, "div");
  assert.deepEqual(div.attributes, { id: "root" });
  const a = asElement(child(div, 0));
  assert.equal(a.tagName, "a");
  assert.deepEqual(a.attributes, {
    class: "link",
    href: "/x",
    "data-id": "7",
  });
  assert.equal(a.children.length, 1);
  assert.equal(asText(child(a, 0)).text, "  Hello  World ");
});

test("parseHtml: '>' inside a quoted attribute value is preserved", () => {
  // Regression: the original hand-rolled parser split tags at the first
  // '>' and corrupted attribute values containing '>'.
  const doc = parseHtml(
    '<a title="x > y" data-note="a > b > c" href="/ok">text</a>',
  );
  const a = asElement(child(doc, 0));
  assert.equal(a.attributes.title, "x > y");
  assert.equal(a.attributes["data-note"], "a > b > c");
  assert.equal(a.attributes.href, "/ok");
  assert.equal(a.children.length, 1);
});

test("parseHtml: entities are decoded", () => {
  const doc = parseHtml("<p>&amp; &lt; &gt; &#x41;&#66;</p>");
  const p = asElement(child(doc, 0));
  assert.equal(asText(child(p, 0)).text, "& < > AB");
});

test("parseHtml: comments are kept as comment nodes", () => {
  const doc = parseHtml("<div><!-- a comment --><p>x</p></div>");
  const div = asElement(child(doc, 0));
  assert.equal(div.children.length, 2);
  assert.equal(asComment(child(div, 0)).text, " a comment ");
});

test("parseHtml: malformed HTML is tolerated (unclosed/stray tags)", () => {
  const doc = parseHtml("<div><p>one</p><b>two</div>tail</div><span>odd");
  assert.equal(doc.type, "document");
  // The exact recovery tree is an implementation detail; the parse must
  // succeed and preserve all text content.
  const texts: string[] = [];
  const walk = (node: HtmlDocument | HtmlElement): void => {
    for (const c of node.children) {
      if (c.type === "text") {
        texts.push(c.text);
      } else if (c.type === "element") {
        walk(c);
      }
    }
  };
  walk(doc);
  assert.deepEqual(texts.sort(), ["odd", "one", "tail", "two"]);
});

test("parseHtml: script and style contents are data, not elements", () => {
  const doc = parseHtml(
    '<script>var a = 1 < 2; if (a > 1) { throw "x"; }</script><style>p { color: red; }</style><p>ok</p>',
  );
  assert.equal(doc.children.length, 3);
  const script = asElement(child(doc, 0));
  assert.equal(script.tagName, "script");
  // The script body is a single text child — never parsed as elements.
  assert.equal(script.children.length, 1);
  assert.equal(
    asText(child(script, 0)).text,
    'var a = 1 < 2; if (a > 1) { throw "x"; }',
  );
  const style = asElement(child(doc, 1));
  assert.equal(style.tagName, "style");
  assert.equal(style.children.length, 1);
  const p = asElement(child(doc, 2));
  assert.equal(p.tagName, "p");
});

test("parseHtml: void elements and self-closing tags", () => {
  const doc = parseHtml('<img src="/a.png"><br/><input type="text">text');
  assert.equal(doc.children.length, 4);
  const img = asElement(child(doc, 0));
  assert.equal(img.tagName, "img");
  assert.deepEqual(img.attributes, { src: "/a.png" });
  assert.equal(img.children.length, 0);
});

test("parseHtml: node limit aborts with HTML_PARSE_ERROR", () => {
  // 60k open tags > 50k node limit. The count aborts DURING parsing.
  const big = "<i></i>".repeat(60_000);
  assert.equal(PHASE5_LIMITS.maxHtmlNodes, 50_000);
  assertPhase5Error(() => parseHtml(big), "HTML_PARSE_ERROR");
  // Well under the limit parses fine.
  const okDoc = parseHtml("<i></i>".repeat(40_000));
  assert.equal(okDoc.children.length, 40_000);
});

test("parseHtml: empty input is an empty document", () => {
  const doc = parseHtml("");
  assert.deepEqual(doc, { type: "document", children: [] });
});

// ---------------------------------------------------------------------------
// selectHtml
// ---------------------------------------------------------------------------

test("selectHtml: tag, class, id, tag.class, descendant, and attribute selectors", () => {
  const doc = parseHtml(
    '<div id="root" class="wrap"><article class="card featured" data-id="1"><a href="/1">A</a></article>' +
      '<article class="card"><a href="/2" data-flag="on">B</a></article><span>tail</span></div>',
  );
  assert.equal(selectHtml(doc, "div").length, 1);
  assert.equal(selectHtml(doc, ".card").length, 2);
  assert.equal(selectHtml(doc, "#root").length, 1);
  assert.equal(selectHtml(doc, "div.wrap").length, 1);
  assert.equal(selectHtml(doc, "article.card").length, 2);
  assert.equal(selectHtml(doc, "div .card").length, 2);
  assert.equal(selectHtml(doc, "article a").length, 2);
  assert.equal(selectHtml(doc, "[href]").length, 2);
  assert.equal(selectHtml(doc, "a[data-flag]").length, 1);
  assert.equal(selectHtml(doc, 'a[data-flag="on"]').length, 1);
  assert.equal(selectHtml(doc, "article[data-id]").length, 1);
  assert.equal(selectHtml(doc, "div.wrap .card a").length, 2);
  assert.equal(selectHtml(doc, "span").length, 1);
  assert.equal(selectHtml(doc, "table").length, 0);
  // No match: the tail span is not inside a card.
  assert.equal(selectHtml(doc, ".card span").length, 0);
});

test("selectHtml: works on an element subtree, not only documents", () => {
  const doc = parseHtml(
    '<div><section class="s"><p>x</p><p>y</p></section></div>',
  );
  const div = asElement(child(doc, 0));
  const info = selectHtml(div, "section.s p");
  assert.equal(info.length, 2);
});

test("selectHtml: invalid selectors produce structured errors", () => {
  const doc = parseHtml("<p>one</p>");
  // Unparseable selectors -> HTML_SELECT_ERROR.
  for (const selector of ["p::before(", "p>>>q", "p[unclosed", "&&&"]) {
    assertPhase5Error(() => selectHtml(doc, selector), "HTML_SELECT_ERROR");
  }
  // Missing/empty selector -> HTML_INVALID_SELECTOR.
  assertPhase5Error(() => selectHtml(doc, ""), "HTML_INVALID_SELECTOR");
});

test("selectHtml: non-document/element arguments are rejected", () => {
  assertPhase5Error(() => selectHtml("not a document", "p"), "HTML_SELECT_ERROR");
  // A plain object that is not a parsed tree.
  assertPhase5Error(() => selectHtml({ type: "document" }, "p"), "HTML_SELECT_ERROR");
  assertPhase5Error(
    () => selectHtml({ type: "element", tagName: 1, attributes: {}, children: [] }, "p"),
    "HTML_SELECT_ERROR",
  );
});

test("selectHtml: result count is bounded by maxSelectResults", () => {
  const n = PHASE5_LIMITS.maxSelectResults + 1;
  const doc = parseHtml(Array.from({ length: n }, () => "<i></i>").join(""));
  assertPhase5Error(() => selectHtml(doc, "i"), "HTML_TOO_MANY_RESULTS");
  // Exactly at the limit is allowed.
  const atLimit = parseHtml(
    Array.from({ length: PHASE5_LIMITS.maxSelectResults }, () => "<i></i>").join(""),
  );
  assert.equal(selectHtml(atLimit, "i").length, PHASE5_LIMITS.maxSelectResults);
});

// ---------------------------------------------------------------------------
// extractHtml
// ---------------------------------------------------------------------------

test("extractHtml: full info object including data-* and html serialization", () => {
  const doc = parseHtml(
    '<a id="main" class="btn primary" href="/w/1" data-track="watch" data-lang="en" src="/s.png">' +
      "  <b>Bold</b> and plain &amp; nested </a>",
  );
  const a = asElement(child(doc, 0));
  const info = extractHtml(a);
  assert.equal(info.tagName, "a");
  assert.equal(info.text, "Bold and plain & nested");
  assert.deepEqual(info.attributes, {
    id: "main",
    class: "btn primary",
    href: "/w/1",
    "data-track": "watch",
    "data-lang": "en",
    src: "/s.png",
  });
  assert.equal(info.href, "/w/1");
  assert.equal(info.src, "/s.png");
  assert.equal(info.class, "btn primary");
  assert.equal(info.id, "main");
  assert.deepEqual(info.data, { track: "watch", lang: "en" });
  // innerHTML is the raw serialized subtree (whitespace preserved);
  // `text` is the normalized view of the same content.
  assert.equal(info.innerHTML, "  <b>Bold</b> and plain &amp; nested ");
  assert.equal(
    info.outerHTML,
    '<a id="main" class="btn primary" href="/w/1" data-track="watch" data-lang="en" src="/s.png">  <b>Bold</b> and plain &amp; nested </a>',
  );
});

test("extractHtml: rejects documents, text nodes, and garbage", () => {
  const doc = parseHtml("<p>x</p>");
  assertPhase5Error(() => extractHtml(doc), "HTML_EXTRACT_ERROR");
  assertPhase5Error(() => extractHtml("nope"), "HTML_INVALID_ELEMENT");
  assertPhase5Error(() => extractHtml(undefined), "HTML_INVALID_ELEMENT");
  assertPhase5Error(() => extractHtml({ type: "text", text: 123 }), "HTML_EXTRACT_ERROR");
});

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

test("PHASE5_ERROR_CODES is a stable, unique list", () => {
  assert.equal(new Set(PHASE5_ERROR_CODES).size, PHASE5_ERROR_CODES.length);
  assert.ok(PHASE5_ERROR_CODES.every((c) => typeof c === "string" && c.length > 0));
});
