/**
 * `konsora mcp`: the Konsora MCP server. Every tool returns the same JSON the matching CLI
 * command prints with `--json`, through the functions the CLI uses (read.ts, write.ts), so no
 * rule is implemented twice. The project is resolved on each call (like the CLI), so a missing
 * or invalid plan is a tool error and never stops the server. Starting the server and the read
 * tools write nothing; the agent write tools (mcp-write.ts) go through core's semantic ops.
 */
import { DIFFICULTIES, TaskStateSchema } from "@konsora/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { guarded, ok } from "./mcp-result.ts";
import { registerWriteTools } from "./mcp-write.ts";
import { checkData, LIST_PRESETS, listData, logData, showAnyData, statusData } from "./read.ts";
import { type Io, load, locate, sessionScope, staleHours, VERSION } from "./shared.ts";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

const listFilter = {
  state: TaskStateSchema.optional().describe("only tasks in this state"),
  group: z.string().optional().describe("only tasks of this group id, e.g. CORE"),
  ready: z.boolean().optional().describe("only tasks ready to start"),
  blocked: z.boolean().optional().describe("only todo tasks blocked by unfinished dependencies"),
  waiting: z.boolean().optional().describe("only tasks waiting for an answer from the human"),
  difficulty: z
    .enum([...DIFFICULTIES, "none"])
    .optional()
    .describe("only tasks of this difficulty (none: without one)"),
};

const GUIDE =
  "Konsora keeps this project's plan in .konsora/tasks.json. Read it with status, ready and " +
  "show, and log for what was finished lately. Plan by creating tasks (propose, batch): they " +
  "go straight to todo, no approval. Work one task at a time (next gives the one to take): " +
  "start it, add notes as you go, ask when blocked on a decision (then " +
  "stop and wait), and finish with a summary of how you met each acceptance criterion. Humans " +
  "reopen tasks and change finished work; there are no tools for that. Never edit " +
  ".konsora/tasks.json by hand.";

function instructions(env: NodeJS.ProcessEnv): string {
  if (!sessionScope(env).plan) return GUIDE;
  return (
    `${GUIDE}\n\nThis is a planning session: interview the human, then create tasks with ` +
    `propose or batch. You may revise, reorder, split, link, promote, demote or delete tasks ` +
    `nobody started; every other write is refused, and nothing is started.`
  );
}

export function createMcpServer(io: Io, root: string | undefined): McpServer {
  const server = new McpServer(
    { name: "konsora", version: VERSION },
    { instructions: instructions(io.env) },
  );

  server.registerTool(
    "status",
    {
      title: "Plan status",
      description:
        "Summary of the plan: counts per state, ids that are ready, blocked, waiting, abandoned (stale: in progress with no recent activity) or ideas (proposed), the milestones with their progress, and the project (its task templates in project.templates).",
      annotations: READ_ONLY,
    },
    () =>
      guarded(async () => {
        const { doc } = await load(io, root);
        return ok(statusData(doc, { now: io.now?.() ?? new Date(), hours: staleHours(io.env) }));
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
        const { root: dir, doc } = await load(io, root);
        return ok(await showAnyData(dir, doc, id));
      }),
  );

  server.registerTool(
    "log",
    {
      title: "Completion log",
      description:
        "Finished tasks, newest first (archived ones included): when, who closed each one and its closing summary. Use it to see what was done lately before picking work.",
      inputSchema: {
        since: z
          .string()
          .optional()
          .describe("only tasks finished on or after this date or timestamp, e.g. 2026-11-01"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("at most this many, the most recent"),
      },
      annotations: READ_ONLY,
    },
    (filter) =>
      guarded(async () => {
        const { root: dir, doc } = await load(io, root);
        return ok(await logData(dir, doc, filter));
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

  registerWriteTools(server, io, root);
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
