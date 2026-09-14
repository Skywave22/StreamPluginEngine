# Phase 5 — HTML + JSON Parsing

Phase 5 adds data parsing capabilities to the existing sandboxed plugin engine.

## Plugin API

```js
export const plugin = {
  async search(query, context) {
    const response = await context.http.get("https://example.com");
    const doc = context.html.parse(response.body);

    return context.html
      .select(doc, ".result a[href]")
      .map(context.html.extract);
  },

  parseApi(_, context) {
    const value = context.json.parse('{"ok":true}');
    return value;
  }
};
```

### JSON

- `context.json.parse(text)`
- `context.json.stringify(value)`
- 5 MiB input/output guard
- structured rejected errors
- no host objects exposed to the guest

### HTML

`context.html.parse(html)` produces a JSON-serializable tree.

`context.html.select(document, selector)` supports:

- tag: `article`
- class: `.card`
- id: `#results`
- tag + class: `article.card`
- descendant selectors: `#results article.card a`
- basic attributes: `[href]`, `[data-id="42"]`
- combinations such as `article.card[href]`

`context.html.extract(element)` returns:

- `tagName`
- normalized `text`
- `attributes`
- `href`
- `src`
- `class`
- `id`
- `data` (`data-*` attributes)
- `innerHTML`
- `outerHTML`

## Security boundary

HTML parsing is parser-only.

It does **not**:

- execute `<script>` or event-handler code
- load images, scripts, frames, or other external resources
- make network requests
- access cookies, browser storage, filesystem, Node.js APIs, or host objects
- bypass CAPTCHA, Cloudflare, DRM, authentication, or other security controls

URLs in `href` and `src` are returned as data only. A plugin must explicitly use the Phase 4 controlled HTTP API for a network request.

## Limits

- HTML input: 5 MiB
- JSON input/output: 5 MiB
- HTML nodes: 50,000

These are deliberately conservative defaults for a lightweight plugin engine and should remain engine-controlled.

## Verification

Run:

```bash
npm test
npm run build
```

Phase 5 tests are deterministic and do not require internet access.
