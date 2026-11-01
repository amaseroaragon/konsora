/**
 * `konsora mcp`: the Konsora MCP server (MCP-01: read tools). Every tool returns the same JSON
 * the matching CLI command prints with `--json`, through the shared functions in read.ts.
 * The project is resolved on each call (like the CLI), so a missing or invalid plan is a tool
 * error and never stops the server. Nothing here writes to the project.
 */
import { TaskStateSchema } from "@konsora/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { checkData, LIST_PRESETS, listData, showData, statusData } from "./read.ts";
import { CliError, type Io, load, locate, VERSION } from "./shared.ts";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

const listFilter = {
  state: TaskStateSchema.optional().describe("only tasks in this state"),
  group: z.string().optional().describe("only tasks of this group id, e.g. CORE"),
  ready: z.boolean().optional().describe("only tasks ready to start"),
  blocked: z.boolean().optional().describe("only todo tasks blocked by unfinished dependencies"),
  waiting: z.boolean().optional().describe("only tasks waiting for an answer from the human"),
};

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/** Runs a tool body and turns Konsora errors into actionable tool errors. */
async function guarded(body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof CliError)
      return failure(`Error: ${error.message}${error.hint ? `\nHint: ${error.hint}` : ""}`);
    return failure("Error: unexpected failure while reading the plan.");
  }
}

export function createMcpServer(io: Io, root: string | undefined): McpServer {
  const server = new McpServer(
    { name: "konsora", version: VERSION },
    {
      instructions:
        "Konsora keeps this project's plan in .konsora/tasks.json. Use these tools to see what " +
        "needs attention (status), what you can start (ready) and the details of a task (show). " +
        "Never edit .konsora/tasks.json by hand.",
    },
  );

  server.registerTool(
    "status",
    {
      title: "Plan status",
      description:
        "Summary of the plan: counts per state, and ids that are ready, blocked, waiting, in review or proposed.",
      annotations: READ_ONLY,
    },
    () =>
      guarded(async () => {
        const { doc } = await load(io, root);
        return ok(statusData(doc));
      }),
  );

  const lists = [
    ["list", "List tasks in dependency order, optionally filtered."],
    ["ready", "Tasks an agent can start now (todo with every dependency done)."],
    ["blocked", "Todo tasks waiting on unfinished dependencies."],
  ] as const;
  for (const [name, description] of lists) {
    server.registerTool(
      name,
      { title: `Tasks: ${name}`, description, inputSchema: listFilter, annotations: READ_ONLY },
      (filter) =>
        guarded(async () => {
          const { doc } = await load(io, root);
          return ok(listData(doc, filter, LIST_PRESETS[name]));
        }),
    );
  }

  server.registerTool(
    "show",
    {
      title: "Show task",
      description: "Details of one task: description, dependencies, acceptance criteria and notes.",
      inputSchema: { id: z.string().min(1).describe("task id, e.g. CORE-01") },
      annotations: READ_ONLY,
    },
    ({ id }) =>
      guarded(async () => {
        const { doc } = await load(io, root);
        return ok(showData(doc, id));
      }),
  );

  server.registerTool(
    "check",
    {
      title: "Validate plan",
      description:
        "Validate .konsora/tasks.json. An invalid plan is reported with every problem and its path.",
      annotations: READ_ONLY,
    },
    () =>
      guarded(async () => {
        const result = await checkData(locate(io, root));
        return result.ok ? ok(result) : { ...ok(result), isError: true };
      }),
  );

  return server;
}

/**
 * Serves MCP over the process's stdio until the client disconnects. When stdin ends, the server
 * answers the requests already received before closing, so a piped session gets every reply.
 */
export async function serveStdio(io: Io, root: string | undefined): Promise<void> {
  const stdin = io.stdio?.stdin ?? process.stdin;
  const stdout = io.stdio?.stdout ?? process.stdout;
  const server = createMcpServer(io, root);
  const transport = new StdioServerTransport(stdin, stdout);
  const closed = new Promise<void>((resolve) => {
    transport.onclose = resolve;
  });
  await server.connect(transport);

  const pending = new Set<string | number>();
  let ended = false;
  const closeIfIdle = () => {
    if (ended && pending.size === 0) void server.close();
  };
  const receive = transport.onmessage;
  transport.onmessage = (message) => {
    if ("method" in message && "id" in message) pending.add(message.id);
    receive?.(message);
  };
  const send = transport.send.bind(transport);
  transport.send = async (message) => {
    await send(message);
    if (!("method" in message) && "id" in message && message.id !== undefined) {
      if (pending.delete(message.id)) closeIfIdle();
    }
  };
  stdin.once("end", () => {
    ended = true;
    closeIfIdle();
  });
  await closed;
}
