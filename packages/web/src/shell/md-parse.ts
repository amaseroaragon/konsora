/**
 * A small, safe markdown subset for task descriptions and notes (UI-08), parsed to a tree that
 * `Markdown.tsx` turns into React elements. There is no HTML string anywhere: raw HTML in the
 * source is plain text, and React escapes all text. Links keep only http, https and mailto.
 *
 * Blocks: ATX headings, paragraphs (a newline is a line break), `-`/`*`/`+` and numbered lists
 * (nestable), `>` quotes, fenced code (``` or ~~~) and rules. Inline: `code`, **strong**,
 * *em* / _em_, [text](url), <url> and bare http(s) URLs, and backslash escapes.
 */

export type Inline =
  | { k: number; type: "text"; text: string }
  | { k: number; type: "code"; text: string }
  | { k: number; type: "strong" | "em"; children: Inline[] }
  | { k: number; type: "link"; href: string; children: Inline[] }
  | { k: number; type: "break" };

export type Block =
  | { k: number; type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { k: number; type: "paragraph"; children: Inline[] }
  | { k: number; type: "list"; ordered: boolean; start: number; items: Block[][] }
  | { k: number; type: "code"; lang: string; text: string }
  | { k: number; type: "quote"; children: Block[] }
  | { k: number; type: "rule" };

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
/** Nesting of lists and quotes beyond this is kept as text, so no input can recurse unbounded. */
const MAX_DEPTH = 8;

/** The normalized URL if it is absolute http, https or mailto; null for anything else. */
export function safeHref(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null;
}

let counter = 0;
const key = () => ++counter;

// ── Blocks ────────────────────────────────────────────────────────────────

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)/;

const blank = (line: string) => line.trim() === "";
const indentOf = (line: string) => line.length - line.trimStart().length;

function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line)
  );
}

export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.replace(/\r\n?/g, "\n").split("\n"), 0);
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (blank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] as string;
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] as string).trim().startsWith(marker)) {
        body.push(lines[i] as string);
        i++;
      }
      i++; // closing fence (or end of input)
      blocks.push({ k: key(), type: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = (heading[1] as string).length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ k: key(), type: "heading", level, children: parseInline(heading[2] ?? "") });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ k: key(), type: "rule" });
      i++;
      continue;
    }
    if (depth < MAX_DEPTH && QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] as string)) {
        inner.push((lines[i] as string).replace(QUOTE, ""));
        i++;
      }
      blocks.push({ k: key(), type: "quote", children: parseBlocks(inner, depth + 1) });
      continue;
    }
    const item = ITEM.exec(line);
    if (depth < MAX_DEPTH && item) {
      const [list, next] = parseList(lines, i, depth);
      blocks.push(list);
      i = next;
      continue;
    }
    // Paragraph: until a blank line or the start of another block.
    const text: string[] = [line.trim()];
    i++;
    while (i < lines.length && !blank(lines[i] as string) && !startsBlock(lines[i] as string)) {
      text.push((lines[i] as string).trim());
      i++;
    }
    blocks.push({ k: key(), type: "paragraph", children: parseInline(text.join("\n")) });
  }
  return blocks;
}

function parseList(lines: string[], from: number, depth: number): [Block, number] {
  const first = ITEM.exec(lines[from] as string) as RegExpExecArray;
  const ordered = /\d/.test(first[2] as string);
  const start = ordered ? Number.parseInt(first[2] as string, 10) : 1;
  const items: Block[][] = [];
  let i = from;
  while (i < lines.length) {
    const match = ITEM.exec(lines[i] as string);
    if (!match || /\d/.test(match[2] as string) !== ordered) break;
    const contentIndent = (match[0] as string).length;
    const body = [(lines[i] as string).slice(contentIndent)];
    i++;
    // The item goes on while lines are indented to its content, or are blank before such a line.
    while (i < lines.length) {
      const next = lines[i] as string;
      if (blank(next)) {
        const after = lines[i + 1];
        if (after !== undefined && !blank(after) && indentOf(after) >= contentIndent) {
          body.push("");
          i++;
          continue;
        }
        break;
      }
      if (indentOf(next) >= contentIndent) body.push(next.slice(contentIndent));
      else if (!startsBlock(next))
        body.push(next.trim()); // lazy continuation of the paragraph
      else break;
      i++;
    }
    items.push(parseBlocks(body, depth + 1));
    // A single blank line between items keeps the list going.
    if (blank(lines[i] ?? "x") && ITEM.test(lines[i + 1] ?? "")) i++;
  }
  return [{ k: key(), type: "list", ordered, start, items }, i];
}

// ── Inline ────────────────────────────────────────────────────────────────

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!<>~|]/;
const BARE_URL = /^https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]]/;

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ k: key(), type: "text", text });
    text = "";
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    const rest = source.slice(i);
    if (ch === "\\" && ESCAPABLE.test(source[i + 1] ?? "")) {
      text += source[i + 1];
      i += 2;
      continue;
    }
    if (ch === "\n") {
      flush();
      out.push({ k: key(), type: "break" });
      i++;
      continue;
    }
    if (ch === "`") {
      const run = /^`+/.exec(rest)?.[0] as string;
      const close = source.indexOf(run, i + run.length);
      if (close >= 0) {
        flush();
        const code = source.slice(i + run.length, close);
        out.push({
          k: key(),
          type: "code",
          text: code.length > 2 ? code.replace(/^ (.*) $/s, "$1") : code,
        });
        i = close + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }
    if (ch === "[") {
      const link = /^\[((?:[^\][\\]|\\.)*)\]\(\s*<?([^\s()<>]*)>?(?:\s+"[^"]*")?\s*\)/.exec(rest);
      if (link) {
        const href = safeHref(link[2] as string);
        if (href) {
          flush();
          out.push({
            k: key(),
            type: "link",
            href,
            children: withoutLinks(parseInline(link[1] as string)),
          });
        } else text += link[0]; // not a safe link: shown exactly as written
        i += (link[0] as string).length;
        continue;
      }
    }
    if (ch === "<") {
      const auto = /^<([a-z][a-z0-9+.-]{1,31}:[^\s<>]+)>/i.exec(rest);
      if (auto) {
        const href = safeHref(auto[1] as string);
        if (href) {
          flush();
          out.push({
            k: key(),
            type: "link",
            href,
            children: [{ k: key(), type: "text", text: auto[1] as string }],
          });
        } else text += auto[0];
        i += (auto[0] as string).length;
        continue;
      }
    }
    if (
      (ch === "h" || ch === "H") &&
      /[^\p{L}\p{N}]$|^$/u.test(source.slice(Math.max(0, i - 1), i))
    ) {
      const bare = BARE_URL.exec(rest);
      const href = bare ? safeHref(bare[0]) : null;
      if (bare && href) {
        flush();
        out.push({
          k: key(),
          type: "link",
          href,
          children: [{ k: key(), type: "text", text: bare[0] }],
        });
        i += bare[0].length;
        continue;
      }
    }
    if (ch === "*" || ch === "_") {
      const emphasis = delimited(source, i, ch);
      if (emphasis) {
        flush();
        out.push({
          k: key(),
          type: emphasis.strong ? "strong" : "em",
          children: parseInline(emphasis.inner),
        });
        i = emphasis.end;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

/** `**x**` / `*x*` (and `_` forms, only at word edges so snake_case stays as is). */
function delimited(
  source: string,
  at: number,
  ch: "*" | "_",
): { strong: boolean; inner: string; end: number } | null {
  const strong = source[at + 1] === ch;
  const marker = strong ? ch + ch : ch;
  const open = at + marker.length;
  if (/\s/.test(source[open] ?? " ")) return null;
  if (ch === "_" && /[\p{L}\p{N}]/u.test(source[at - 1] ?? "")) return null;
  let close = source.indexOf(marker, open + 1);
  while (close >= 0) {
    const before = source[close - 1] ?? "";
    const after = source[close + marker.length] ?? "";
    const wordAfter = ch === "_" && /[\p{L}\p{N}]/u.test(after);
    const tripled = !strong && after === ch; // `*a**` is not em
    if (!/\s/.test(before) && before !== "\\" && !wordAfter && !tripled) break;
    close = source.indexOf(marker, close + 1);
  }
  if (close < 0) return null;
  const inner = source.slice(open, close);
  if (inner.includes("\n\n")) return null;
  return { strong, inner, end: close + marker.length };
}

/** A link's text cannot hold another link: nested ones are flattened to their text. */
function withoutLinks(nodes: Inline[]): Inline[] {
  return nodes.flatMap((node): Inline[] => {
    if (node.type === "link") return withoutLinks(node.children);
    if (node.type === "strong" || node.type === "em")
      return [{ ...node, children: withoutLinks(node.children) }];
    return [node];
  });
}
