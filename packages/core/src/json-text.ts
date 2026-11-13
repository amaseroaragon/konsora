/**
 * Strict JSON text reading for `.konsora/tasks.json`: size limit, UTF-8, and duplicate keys.
 * `JSON.parse` silently keeps the last duplicate, which would hide edits; we reject them.
 */
import { type SchemaIssue, toPointer } from "./schema.ts";

export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

export type JsonTextResult = { ok: true; value: unknown } | { ok: false; issues: SchemaIssue[] };

export function parseJsonText(
  input: string | Uint8Array,
  maxBytes = MAX_DOCUMENT_BYTES,
): JsonTextResult {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input).length : input.length;
  if (bytes > maxBytes) {
    return fail(
      "",
      "too_large",
      `File is ${bytes} bytes; the limit is ${maxBytes} (${maxBytes / 1024 / 1024} MiB)`,
    );
  }
  let text: string;
  try {
    text =
      typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    return fail("", "invalid_utf8", "File is not valid UTF-8");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return fail("", "invalid_json", `Invalid JSON: ${(error as Error).message}`);
  }
  const duplicates = findDuplicateKeys(text);
  if (duplicates.length > 0) {
    return {
      ok: false,
      issues: duplicates.map((path) => ({
        path: toPointer(path),
        code: "duplicate_key",
        message: `Duplicate key "${String(path.at(-1))}"; JSON parsers would silently keep only the last one`,
      })),
    };
  }
  return { ok: true, value };
}

function fail(path: string, code: string, message: string): JsonTextResult {
  return { ok: false, issues: [{ path, code, message }] };
}

type Frame =
  | { kind: "object"; keys: Set<string>; key: string | null; path: (string | number)[] }
  | { kind: "array"; index: number; path: (string | number)[] };

/**
 * Single pass over text that `JSON.parse` already accepted, so it can assume valid syntax.
 * Returns the JSON path of every repeated key.
 */
export function findDuplicateKeys(text: string): (string | number)[][] {
  const duplicates: (string | number)[][] = [];
  const stack: Frame[] = [];
  let expectingKey = false;

  const childPath = (): (string | number)[] => {
    const top = stack.at(-1);
    if (!top) return [];
    if (top.kind === "array") return [...top.path, top.index];
    return [...top.path, top.key ?? ""];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      const top = stack.at(-1);
      if (expectingKey && top?.kind === "object") {
        const key = JSON.parse(text.slice(i, end + 1)) as string;
        if (top.keys.has(key)) duplicates.push([...top.path, key]);
        top.keys.add(key);
        top.key = key;
        expectingKey = false;
      }
      i = end;
    } else if (ch === "{") {
      stack.push({ kind: "object", keys: new Set(), key: null, path: childPath() });
      expectingKey = true;
    } else if (ch === "[") {
      stack.push({ kind: "array", index: 0, path: childPath() });
    } else if (ch === "}" || ch === "]") {
      stack.pop();
    } else if (ch === ",") {
      const top = stack.at(-1);
      if (top?.kind === "object") expectingKey = true;
      else if (top?.kind === "array") top.index++;
    }
  }
  return duplicates;
}
