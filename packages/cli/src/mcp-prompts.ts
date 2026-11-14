/**
 * Prompts and resources of `konsora mcp` (MCP-02). Claude Code offers each prompt as a command of
 * the konsora server (`/mcp__konsora__next`), and the plan's status as a resource the human can
 * attach with a mention (`@konsora:konsora://status`).
 *
 * - `next`: the next ready task in full, with the steps of the protocol to work on it.
 * - `resume`: the tasks this agent has in progress, with their notes, to pick them up.
 * - `plan`: the planning interview (core's buildPlanPrompt), optionally with a goal.
 *
 * Prompts only read the plan: the agent then acts through the tools, with their usual rules.
 * A plan that cannot be read becomes a prompt that says why, so the command never just fails.
 */
import { buildPlanPrompt, startedBy, type TasksDocument } from "@konsora/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { showText, views } from "./format.ts";
import { mcpActor } from "./mcp-write.ts";
import { nextData, statusData, statusSkill } from "./read.ts";
import { CliError, type Io, load, staleHours } from "./shared.ts";

export const STATUS_URI = "konsora://status";

const user = (text: string): GetPromptResult => ({
  messages: [{ role: "user", content: { type: "text", text } }],
});

/** Builds a prompt from the plan; a Konsora error becomes a prompt that explains it. */
async function fromPlan(
  io: Io,
  root: string | undefined,
  build: (doc: TasksDocument) => string,
): Promise<GetPromptResult> {
  try {
    const { doc } = await load(io, root);
    return user(build(doc));
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    const hint = error.hintFor("mcp");
    return user(
      `Konsora could not give you work: ${error.message}${hint ? `\nHint: ${hint}` : ""}\nTell the human, and do not change .konsora/tasks.json by hand.`,
    );
  }
}

const WORK_STEPS = [
  "Work on it following the Konsora protocol:",
  "1. Start it with the start tool, passing your plan. Read the closing summaries of its dependencies that start returns.",
  "2. Implement it. Add a note at each meaningful step; if you need a decision from the human, ask with the ask tool and stop.",
  "3. Verify every acceptance criterion and commit your work.",
  "4. Finish it with the finish tool: a summary, the evidence for each criterion and the commits.",
].join("\n");

export function nextPrompt(doc: TasksDocument): string {
  try {
    const task = nextData(doc);
    return `The next task to take in this project's Konsora plan is ${task.id}.\n\n${showText(doc, task)}\n${WORK_STEPS}`;
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    const hint = error.hintFor("mcp");
    return `There is no task to work on in this project's Konsora plan right now.\n\n${error.message}${hint ? `\nHint: ${hint}` : ""}\n\nTell the human, and do not start any task.`;
  }
}

export function resumePrompt(doc: TasksDocument, actor: string): string {
  const mine = views(doc).filter((t) => t.state === "doing" && startedBy(t)?.by === actor);
  if (mine.length === 0)
    return `You (${actor}) have no task in progress in this project's Konsora plan. Use the next tool (or the next prompt) to pick one, or ask the human what to do.`;
  const tasks = mine.map((t) => showText(doc, t)).join("\n");
  return (
    `You (${actor}) have ${mine.length === 1 ? "a task" : `${mine.length} tasks`} in progress in this project's Konsora plan. Pick up where it stands: read its notes (and any answer from the human), check the code, then go on.\n\n` +
    `${tasks}\nWhen it is done and verified, commit and finish it with the finish tool (summary, evidence per criterion, commits). If you cannot go on now, add a note of where it stands or pause it. Work on one task at a time.`
  );
}

export function registerPromptsAndResources(server: McpServer, io: Io, root: string | undefined) {
  server.registerPrompt(
    "next",
    {
      title: "Work on the next task",
      description:
        "Take the next ready task of the Konsora plan (lowest rank) and work on it following the protocol.",
    },
    () => fromPlan(io, root, nextPrompt),
  );

  server.registerPrompt(
    "resume",
    {
      title: "Resume my task in progress",
      description: "Pick up the Konsora tasks you have in progress, with their notes.",
    },
    () =>
      fromPlan(io, root, (doc) =>
        resumePrompt(doc, mcpActor(io.env, server.server.getClientVersion()?.name)),
      ),
  );

  server.registerPrompt(
    "plan",
    {
      title: "Plan with the human",
      description:
        "Interview the human about what to build and create the tasks of the Konsora plan.",
      argsSchema: { goal: z.string().optional().describe("what you want to plan, if you know") },
    },
    ({ goal }) =>
      fromPlan(io, root, (doc) => buildPlanPrompt(doc, goal?.trim() ? { goal: goal.trim() } : {})),
  );

  server.registerResource(
    "status",
    STATUS_URI,
    {
      title: "Konsora plan status",
      description:
        "The plan's status, as the status tool returns it: counts per state, what is ready, blocked, waiting or abandoned, ideas, milestones and templates.",
      mimeType: "application/json",
    },
    async (uri) => {
      const { root: dir, doc } = await load(io, root);
      const check = { now: io.now?.() ?? new Date(), hours: staleHours(io.env) };
      const value = statusData(doc, check, await statusSkill(dir));
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(value, null, 2) },
        ],
      };
    },
  );
}
