import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/shell/Markdown.tsx";
import { type Block, parseInline, parseMarkdown, safeHref } from "../src/shell/md-parse.ts";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);
/** The tree without its React keys, to compare shapes. */
const shape = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (k, v) => (k === "k" ? undefined : v)));

describe("markdown safety (UI-08)", () => {
  it("shows HTML and scripts as text, never as elements (ac1)", () => {
    const out = html(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)"> <b>bold?</b>\n\n<iframe src="https://evil.example"></iframe>',
    );
    expect(out).not.toMatch(/<script|<img|<iframe|<b>/i);
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("&lt;img src=x onerror=&quot;alert(2)&quot;&gt;");
    expect(out).toContain("&lt;b&gt;bold?&lt;/b&gt;");
  });

  it("keeps HTML inside code and code blocks as text too", () => {
    const out = html("`<script>x</script>`\n\n```html\n<style>body{}</style>\n```");
    expect(out).toContain("<code>&lt;script&gt;x&lt;/script&gt;</code>");
    expect(out).toContain("&lt;style&gt;body{}&lt;/style&gt;");
    expect(out).not.toMatch(/<style/);
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "/relative/path",
    "//evil.example/x",
  ])("does not turn %j into a link (ac2)", (url) => {
    expect(safeHref(url)).toBeNull();
    const out = html(`[pulsa](${url}) y <${url}>`);
    expect(out).not.toContain("<a ");
    expect(out).toContain("pulsa");
  });

  it("allows http, https and mailto, opening them without opener or referrer", () => {
    const out = html(
      "[docs](https://example.com/a?b=1) <mailto:yo@example.com> y http://x.example/p.",
    );
    expect(out).toContain(
      '<a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer">docs</a>',
    );
    expect(out).toContain(
      '<a href="mailto:yo@example.com" target="_blank" rel="noopener noreferrer">',
    );
    // A bare URL stops before the sentence's final dot.
    expect(out).toContain(
      '<a href="http://x.example/p" target="_blank" rel="noopener noreferrer">http://x.example/p</a>.',
    );
  });

  it("never emits inline styles or event handlers, whatever the input", () => {
    const out = html('*a* **b** [c](https://c.example "t") `d`\n\n> e\n\n- f\n1. g\n\n---\n\n# h');
    expect(out).not.toMatch(/\sstyle=|\son[a-z]+=/i);
  });

  it("caps nesting so deep input cannot recurse unbounded", () => {
    const deep = `${"> ".repeat(500)}x`;
    expect(() => html(deep)).not.toThrow();
    expect(() =>
      html(`${Array.from({ length: 300 }, (_, i) => `${"  ".repeat(i)}- x`).join("\n")}`),
    ).not.toThrow();
  });
});

describe("markdown formatting (ac3)", () => {
  it("parses headings, lists, quotes, code blocks and rules", () => {
    const blocks = parseMarkdown(
      "# Título\n\nTexto con `code`.\n\n- uno\n- dos\n  - anidado\n\n3. tres\n4. cuatro\n\n> cita\n\n```ts\nconst a = 1;\n```\n\n---",
    );
    expect(blocks.map((b: Block) => b.type)).toEqual([
      "heading",
      "paragraph",
      "list",
      "list",
      "quote",
      "code",
      "rule",
    ]);
    const lists = blocks.filter((b) => b.type === "list");
    expect(shape(lists[0])).toMatchObject({
      ordered: false,
      items: [[{ type: "paragraph" }], [{ type: "paragraph" }, { type: "list" }]],
    });
    expect(shape(lists[1])).toMatchObject({ ordered: true, start: 3 });
    expect(shape(blocks[5])).toEqual({ type: "code", lang: "ts", text: "const a = 1;" });
  });

  it("renders emphasis, code and line breaks inline", () => {
    expect(html("**fuerte** y *suave* y _también_\nnueva línea")).toBe(
      '<div class="md"><p><strong>fuerte</strong> y <em>suave</em> y <em>también</em><br/>nueva línea</p></div>',
    );
  });

  it("leaves snake_case, lone asterisks and escapes alone", () => {
    expect(shape(parseInline("mi_var_x y 2 * 3 * 4 y \\*no\\*"))).toEqual([
      { type: "text", text: "mi_var_x y 2 * 3 * 4 y *no*" },
    ]);
  });

  it("maps markdown headings below the panel title (h2)", () => {
    expect(html("# A\n## B\n### C")).toBe(
      '<div class="md"><h3 class="md-h md-h1">A</h3><h4 class="md-h md-h2">B</h4><h5 class="md-h md-h3">C</h5></div>',
    );
  });

  it("renders a plain note unchanged, as one paragraph", () => {
    expect(html("Started UI-05 (doing).")).toBe(
      '<div class="md"><p>Started UI-05 (doing).</p></div>',
    );
  });
});

describe("markdown tables (UI-06)", () => {
  const text = (s: string) => [{ type: "text", text: s }];

  it("parses a GFM table with its header, rows and column alignment (ac1)", () => {
    const blocks = parseMarkdown(
      "Tareas creadas:\n| Id | Título | Horas |\n|:---|:------:|---:|\n| `UI-01` | **Crear** | 2 |\n| UI-02 | a \\| b |\n\nFin.",
    );
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "table", "paragraph"]);
    expect(shape(blocks[1])).toEqual({
      type: "table",
      align: ["left", "center", "right"],
      head: [text("Id"), text("Título"), text("Horas")],
      rows: [
        [
          [{ type: "code", text: "UI-01" }],
          [{ type: "strong", children: text("Crear") }],
          text("2"),
        ],
        [text("UI-02"), text("a | b"), []], // a short row is padded, the escaped pipe kept
      ],
    });
  });

  it("drops extra cells and keeps a table without outer pipes", () => {
    const [table] = parseMarkdown("a | b\n--- | ---\n1 | 2 | 3");
    expect(shape(table)).toMatchObject({
      align: [null, null],
      rows: [[text("1"), text("2")]],
    });
  });

  it("leaves lines with pipes that are not a table as a paragraph (ac2)", () => {
    for (const source of [
      "a | b\nc | d", // no delimiter row
      "| a | b |\n| --- |", // delimiter with another number of cells
      "uno | dos\n---", // a rule, not a delimiter
      "| a | b |\n| -x- | --- |",
    ])
      expect(parseMarkdown(source)[0]?.type, source).not.toBe("table");
  });

  it("renders the table with alignment classes, never inline styles, and cells as text", () => {
    const out = html("| A | B |\n|:-:|--:|\n| <b>x</b> | [ok](https://x.y) |");
    expect(out).toContain('<div class="md-table"><table><thead><tr><th class="md-center">A</th>');
    expect(out).toContain('<td class="md-right"><a href="https://x.y/"');
    expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(out).not.toContain("style=");
  });
});
