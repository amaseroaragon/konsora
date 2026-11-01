/** Tool results shared by the MCP tools. */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CliError } from "./shared.ts";

export function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/** Runs a tool body and turns Konsora errors into actionable tool errors. */
export async function guarded(body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof CliError)
      return failure(`Error: ${error.message}${error.hint ? `\nHint: ${error.hint}` : ""}`);
    return failure("Error: unexpected failure while handling the request.");
  }
}
