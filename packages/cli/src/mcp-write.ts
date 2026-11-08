/**
 * Agent write tools of `konsora mcp` (MCP-02): the same operations as the CLI write commands,
 * built into the same core ops and applied by the same `runOp` (lock + validation + atomic
 * write). Human transitions (approve, accept, send back, reopen, YOLO, editing approved work)
 * have no tool, on purpose.
 *
 * The actor is `agent:<name>`, from KONSORA_AGENT or else the MCP client's name
 * (`claude-code` → `agent:claude`, `codex-mcp-client` → `agent:codex`).
 */
import { DifficultySchema, type Op, type TasksDocument } from "@konsora/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { failure, guarded, ok } from "./mcp-result.ts";
import type { Io } from "./shared.ts";
import { agentActor, BatchSchema, batchOp, editOp, opHint, runOp, writeJson } from "./write.ts";

/** The agent for attribution: KONSORA_AGENT, else the first word of the MCP client's name. */
export function mcpActor(env: NodeJS.ProcessEnv, clientName: string | undefined): string {
  if (env.KONSORA_AGENT) return agentActor(env.KONSORA_AGENT);
  const word = clientName?.toLowerCase().match(/[a-z0-9]+/)?.[0];
  return agentActor(word && word !== "human" && word !== "konsora" ? word : "unknown");
}

const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

const id = z.string().min(1).describe("task id, e.g. CORE-01");
const ids = z.array(z.string().min(1));
const text = (what: string) => z.string().min(1).describe(what);

export function registerWriteTools(server: McpServer, io: Io, root: string | undefined) {
  /** Applies one op as this session's agent; `next` tells the agent what to do afterwards. */
  const apply = (build: () => Op, next?: string | ((doc: TasksDocument) => string)) =>
    guarded(async (): Promise<CallToolResult> => {
      const op = build();
      const actor = mcpActor(io.env, server.server.getClientVersion()?.name);
      const outcome = await runOp(io, root, op, actor);
      if (!outcome.ok) {
        const hint = opHint(outcome.error);
        return failure(
          `Error (${outcome.error.code}): ${outcome.error.message}${hint ? `\nHint: ${hint}` : ""}`,
        );
      }
      const result = ok(writeJson(outcome));
      if (next)
        result.content.push({
          type: "text",
          text: typeof next === "string" ? next : next(outcome.document),
        });
      return result;
    });

  server.registerTool(
    "propose",
    {
      title: "Propose a task",
      description: "Propose a new task. It stays proposed until a human approves it.",
      inputSchema: {
        title: text("short imperative title"),
        group: text("group id, e.g. CORE (see status for the groups)"),
        desc: z.string().optional().describe("what the task achieves and why (markdown)"),
        acceptance: ids.optional().describe("verifiable acceptance criteria"),
        deps: ids.optional().describe("ids of the tasks it depends on"),
        labels: ids.optional(),
        difficulty: DifficultySchema.optional().describe(
          "estimated difficulty: low, medium or high",
        ),
        template: z
          .string()
          .min(1)
          .optional()
          .describe(
            "id of a project template the task starts from (status lists them); explicit values complete or replace it",
          ),
      },
      annotations: WRITE,
    },
    (args) =>
      apply(
        () => ({
          op: "propose",
          title: args.title,
          group: args.group.toUpperCase(),
          ...(args.desc ? { desc: args.desc } : {}),
          ...(args.acceptance ? { acceptance: args.acceptance } : {}),
          ...(args.deps ? { deps: args.deps.map((d) => d.toUpperCase()) } : {}),
          ...(args.labels ? { labels: args.labels } : {}),
          ...(args.difficulty ? { difficulty: args.difficulty } : {}),
          ...(args.template ? { template: args.template.toLowerCase() } : {}),
        }),
        "The proposal is waiting for human approval.",
      ),
  );

  server.registerTool(
    "batch",
    {
      title: "Propose many tasks",
      description:
        "Propose several tasks at once, all or nothing. deps may name task ids or the titles of earlier tasks in the same batch; new groups go in groups.",
      inputSchema: BatchSchema.shape,
      annotations: WRITE,
    },
    (args) => apply(() => batchOp(args), "The proposals are waiting for human approval."),
  );

  server.registerTool(
    "edit",
    {
      title: "Revise a proposal",
      description:
        "Revise one of the proposals. Approved tasks can only be changed by a human. acceptance replaces every criterion.",
      inputSchema: {
        id,
        title: z.string().min(1).optional(),
        desc: z.string().optional(),
        acceptance: ids.optional(),
        labels: z.array(z.string()).optional(),
        group: z.string().min(1).optional().describe("move to another group (the id stays)"),
        difficulty: z
          .enum([...DifficultySchema.options, "none"])
          .optional()
          .describe("estimated difficulty: low, medium or high; none removes it"),
      },
      annotations: WRITE,
    },
    ({ id: task, ...changes }) => apply(() => editOp(task, changes)),
  );

  server.registerTool(
    "withdraw",
    {
      title: "Withdraw a proposal",
      description: "Delete one of the proposals while it is still a proposal.",
      inputSchema: { id },
      annotations: { ...WRITE, destructiveHint: true },
    },
    (args) => apply(() => ({ op: "withdraw", task: args.id.toUpperCase() })),
  );

  for (const name of ["depend", "undepend"] as const) {
    server.registerTool(
      name,
      {
        title: name === "depend" ? "Add a dependency" : "Remove a dependency",
        description:
          name === "depend"
            ? "Make task id depend on task on (rejected if it would create a cycle)."
            : "Remove a dependency from one of the proposals.",
        inputSchema: { id, on: z.string().min(1).describe("the task it depends on") },
        annotations: WRITE,
      },
      (args) => apply(() => ({ op: name, task: args.id.toUpperCase(), on: args.on.toUpperCase() })),
    );
  }

  server.registerTool(
    "start",
    {
      title: "Start a task",
      description: "Start a ready task (todo → doing). Optionally note your plan.",
      inputSchema: { id, plan: z.string().min(1).optional().describe("your plan, as a note") },
      annotations: WRITE,
    },
    (args) =>
      apply(() => ({
        op: "start",
        task: args.id.toUpperCase(),
        ...(args.plan ? { text: args.plan } : {}),
      })),
  );

  server.registerTool(
    "pause",
    {
      title: "Pause a task",
      description: "Stop working on a task for now (doing → todo). Optionally say why.",
      inputSchema: { id, reason: z.string().min(1).optional() },
      annotations: WRITE,
    },
    (args) =>
      apply(() => ({
        op: "pause",
        task: args.id.toUpperCase(),
        ...(args.reason ? { text: args.reason } : {}),
      })),
  );

  server.registerTool(
    "note",
    {
      title: "Add a note",
      description: "Add a progress note to a task (markdown).",
      inputSchema: { id, text: text("what changed") },
      annotations: WRITE,
    },
    (args) => apply(() => ({ op: "note", task: args.id.toUpperCase(), text: args.text })),
  );

  server.registerTool(
    "ask",
    {
      title: "Ask the human",
      description:
        "Ask the human a question about a task you are doing. Then stop and wait for the answer.",
      inputSchema: { id, question: text("the decision you need") },
      annotations: WRITE,
    },
    (args) =>
      apply(
        () => ({ op: "ask", task: args.id.toUpperCase(), text: args.question }),
        "Stop here and wait for the human's answer.",
      ),
  );

  server.registerTool(
    "finish",
    {
      title: "Finish a task",
      description:
        "Finish a task you are doing (doing → review) with a summary of what you did and how it meets each acceptance criterion.",
      inputSchema: { id, summary: text("what you did and how it meets each criterion") },
      annotations: WRITE,
    },
    (args) =>
      apply(
        () => ({ op: "finish", task: args.id.toUpperCase(), summary: args.summary }),
        (doc) => {
          const state = doc.tasks.find((t) => t.id === args.id.toUpperCase())?.state;
          return state === "done"
            ? "The task is done (part of a YOLO chain, no review needed)."
            : state === "doing"
              ? "Konsora now runs the checks; if one fails, you will get its output to fix it. Stop here."
              : "The task is waiting for human review. Stop here.";
        },
      ),
  );
}
