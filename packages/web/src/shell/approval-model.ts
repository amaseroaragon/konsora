/** How an approval's tool input is shown (UI-11): readable, bounded, and always plain text. */

export const INPUT_MAX_CHARS = 1500;
export const INPUT_MAX_LINES = 40;

/**
 * The input as indented JSON, cut at `maxChars` characters (whole code points) or `maxLines`
 * lines. It is rendered as text, so React escapes it: no markup from an agent ever runs.
 */
export function approvalInputText(
  input: unknown,
  maxChars = INPUT_MAX_CHARS,
  maxLines = INPUT_MAX_LINES,
): { text: string; truncated: boolean } {
  let full: string;
  try {
    full = JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    full = String(input);
  }
  let text = full;
  let truncated = false;
  const lines = text.split("\n");
  if (lines.length > maxLines) {
    text = lines.slice(0, maxLines).join("\n");
    truncated = true;
  }
  const chars = Array.from(text);
  if (chars.length > maxChars) {
    text = chars.slice(0, maxChars).join("");
    truncated = true;
  }
  return { text, truncated };
}

/** The most telling field of a tool input, for a one-line summary (command, path, pattern…). */
export function approvalSummary(input: Record<string, unknown>): string | null {
  for (const key of ["command", "file_path", "path", "url", "pattern", "query"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      const line = value.replace(/\s+/g, " ").trim();
      const chars = Array.from(line);
      return chars.length > 160 ? `${chars.slice(0, 159).join("")}…` : line;
    }
  }
  return null;
}
