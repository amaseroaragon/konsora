import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DescField } from "../src/shell/DescField.tsx";

describe("description with preview (UI-29)", () => {
  it("writes in a textarea by default, with a tab to preview", () => {
    const html = renderToStaticMarkup(
      <DescField rows={6} value="**hola**" error={undefined} onChange={() => {}} />,
    );
    expect(html).toContain('role="tablist"');
    expect(html).toContain(">Escribir<");
    expect(html).toContain(">Vista previa<");
    expect(html).toContain("<textarea");
    expect(html).toContain("**hola**");
  });

  it("previews the draft with the safe Markdown renderer, never as HTML", () => {
    const html = renderToStaticMarkup(
      <DescField
        rows={6}
        value={"# Título\n\n**hola** <script>x</script>"}
        error={undefined}
        onChange={() => {}}
        initialTab="preview"
      />,
    );
    expect(html).not.toContain("<textarea");
    expect(html).toContain("<strong>hola</strong>");
    expect(html).toContain('class="md-h md-h1"');
    expect(html).not.toContain("<script>");
  });

  it("says so when there is nothing to preview", () => {
    const html = renderToStaticMarkup(
      <DescField rows={6} value="  " error={undefined} onChange={() => {}} initialTab="preview" />,
    );
    expect(html).toContain("Aún no hay descripción");
  });
});
