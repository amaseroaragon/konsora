import { Fragment, useMemo } from "react";
import { type Align, type Block, type Inline, parseMarkdown } from "./md-parse.ts";

function Inlines({ nodes }: { nodes: readonly Inline[] }) {
  return <>{nodes.map(inline)}</>;
}

function inline(node: Inline) {
  switch (node.type) {
    case "text":
      return <Fragment key={node.k}>{node.text}</Fragment>;
    case "break":
      return <br key={node.k} />;
    case "code":
      return <code key={node.k}>{node.text}</code>;
    case "strong":
      return (
        <strong key={node.k}>
          <Inlines nodes={node.children} />
        </strong>
      );
    case "em":
      return (
        <em key={node.k}>
          <Inlines nodes={node.children} />
        </em>
      );
    case "link":
      return (
        <a key={node.k} href={node.href} target="_blank" rel="noopener noreferrer">
          <Inlines nodes={node.children} />
        </a>
      );
  }
}

/** Markdown h1 is a level below the panel's own title (h2), and so on down to h6. */
const HEADING_TAG = { 1: "h3", 2: "h4", 3: "h5", 4: "h6", 5: "h6", 6: "h6" } as const;

/** Alignment goes in a class, never in an inline style. */
const alignClass = (align: Align) => (align ? `md-${align}` : undefined);

function Blocks({ blocks }: { blocks: readonly Block[] }) {
  return <>{blocks.map(block)}</>;
}

function block(block: Block) {
  switch (block.type) {
    case "heading": {
      const Tag = HEADING_TAG[block.level];
      return (
        <Tag key={block.k} className={`md-h md-h${block.level}`}>
          <Inlines nodes={block.children} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p key={block.k}>
          <Inlines nodes={block.children} />
        </p>
      );
    case "list": {
      const items = block.items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: items of a parsed text never reorder.
        <li key={index}>
          <Blocks blocks={item} />
        </li>
      ));
      return block.ordered ? (
        <ol key={block.k} start={block.start === 1 ? undefined : block.start}>
          {items}
        </ol>
      ) : (
        <ul key={block.k}>{items}</ul>
      );
    }
    case "code":
      return (
        <pre key={block.k} className="md-pre">
          <code>{block.text}</code>
        </pre>
      );
    case "quote":
      return (
        <blockquote key={block.k}>
          <Blocks blocks={block.children} />
        </blockquote>
      );
    case "rule":
      return <hr key={block.k} />;
    case "table":
      return (
        <div key={block.k} className="md-table">
          <table>
            <thead>
              <tr>
                {block.head.map((cell, column) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns of a parsed text never reorder.
                  <th key={column} className={alignClass(block.align[column] ?? null)}>
                    <Inlines nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows of a parsed text never reorder.
                <tr key={index}>
                  {row.map((cell, column) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: columns of a parsed text never reorder.
                    <td key={column} className={alignClass(block.align[column] ?? null)}>
                      <Inlines nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/**
 * Task text (descriptions, notes) as safe markdown: React elements only, never parsed HTML, and
 * only http, https and mailto links (opened in a new tab without opener or referrer).
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className={className ? `md ${className}` : "md"}>
      <Blocks blocks={blocks} />
    </div>
  );
}
