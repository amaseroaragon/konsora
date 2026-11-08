/**
 * UI-01 ac2: components never hard-code user-facing text. Every `.tsx` under src/ is parsed and
 * checked for JSX text, string children and text-bearing attributes that contain letters; those
 * must come from `t()` (src/i18n). Symbols such as "✕" or "·" are allowed.
 *
 * Exempt: the brand name.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAst } from "rolldown/parseAst";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
/** Props that end up as visible or announced text. */
const TEXT_PROPS = new Set([
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-valuetext",
  "alt",
  "caption",
  "eyebrow",
  "error",
  "hint",
  "label",
  "placeholder",
  "title",
]);
const LETTERS = /\p{L}/u;
const ALLOWED = new Set(["KONSORA"]);

type Node = { type: string; start: number; [key: string]: unknown };

export function findLiterals(code: string): { at: number; text: string }[] {
  const found: { at: number; text: string }[] = [];
  const report = (node: Node, text: string) => {
    if (LETTERS.test(text) && !ALLOWED.has(text.trim()))
      found.push({ at: node.start, text: text.trim() });
  };
  /** A string written directly in an expression: "x", `x` (quasis only) or a ? "x" : "y". */
  const literalText = (node: Node | null | undefined): void => {
    if (!node) return;
    if (node.type === "Literal" && typeof node.value === "string") report(node, node.value);
    else if (node.type === "TemplateLiteral")
      for (const quasi of node.quasis as Node[])
        report(quasi, (quasi.value as { cooked: string }).cooked);
    else if (node.type === "ConditionalExpression") {
      literalText(node.consequent as Node);
      literalText(node.alternate as Node);
    } else if (node.type === "LogicalExpression") literalText(node.right as Node);
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!node || typeof node !== "object" || typeof (node as Node).type !== "string") return;
    const n = node as Node;
    if (n.type === "JSXText") report(n, n.value as string);
    if (n.type === "JSXElement" || n.type === "JSXFragment") {
      for (const child of n.children as Node[])
        if (child.type === "JSXExpressionContainer") literalText(child.expression as Node);
    }
    if (n.type === "JSXAttribute") {
      const name = (n.name as Node).name;
      if (typeof name === "string" && TEXT_PROPS.has(name)) {
        const value = n.value as Node | null;
        if (value?.type === "Literal") literalText(value);
        else if (value?.type === "JSXExpressionContainer") literalText(value.expression as Node);
      }
    }
    for (const [key, value] of Object.entries(n)) if (key !== "type") visit(value);
  };
  visit(parseAst(code, { lang: "tsx" }).body);
  return found.sort((a, b) => a.at - b.at);
}

function components(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("no user-facing string literals in components", () => {
  it("the checker catches text, string children and text props", () => {
    const code = `const a = <p title="Hola" aria-label={x ? "Sí" : t("k")}>Texto {"más"} {\`pre \${v}\`}</p>;
      const b = <b className="k-x" data-id="X">{t("ok")} · ✕ {n}%</b>;`;
    expect(findLiterals(code).map((f) => f.text)).toEqual(["Hola", "Sí", "Texto", "más", "pre"]);
  });

  const files = components(SRC);
  it("finds the components", () => expect(files.length).toBeGreaterThan(10));

  it.each(files.map((file) => [relative(SRC, file), file]))("%s", (_name, file) => {
    const literals = findLiterals(readFileSync(file, "utf8")).map((f) => f.text);
    expect(literals, "move these strings to src/i18n/es.ts and use t()").toEqual([]);
  });
});
