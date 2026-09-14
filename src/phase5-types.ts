/**
 * Phase 5 parsing API types.
 */
export interface PluginJson {
  parse<T = unknown>(text: string): T;
  stringify(value: unknown): string;
}

export interface PluginHtml {
  parse(html: string): unknown;
  select(document: unknown, selector: string): unknown[];
  extract(element: unknown): {
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
