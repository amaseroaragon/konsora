/**
 * The prompt of a planning session (`konsora plan` or the UI's AI panel): the agent interviews
 * the human and ends by proposing a batch of tasks. A pure, deterministic function of the plan,
 * so the same plan always yields the same text.
 *
 * It carries the interview steps, what every proposed task needs (verifiable criteria,
 * dependencies, a template when one fits), a summary of the plan as it is (groups,
 * task counts, templates) and the rules of the session.
 */
import type { TaskState, TasksDocument } from "./schema.ts";

export type PlanPromptOptions = {
  /** What the human said they want to plan, if they said it when starting the session. */
  goal?: string;
};

/**
 * Konsora's MCP tools a planning session may call without asking: reads, plus proposing and
 * revising or deleting tasks nobody started. Core's ops still refuse
 * anything else (`ctx.plan`).
 */
export const PLAN_TOOLS: readonly string[] = [
  "status",
  "list",
  "ready",
  "blocked",
  "show",
  "check",
  "propose",
  "batch",
  "edit",
  "delete",
  "depend",
  "undepend",
  "promote",
].map((tool) => `mcp__konsora__${tool}`);

/**
 * The only built-in Claude Code tools the AI panel's agent has (DMN-04, `--tools`): it may read
 * the code, and ToolSearch loads Konsora's MCP tools when the CLI defers them. Nothing that
 * writes, runs commands, makes worktrees or schedules work.
 */
export const PLAN_BUILTIN_TOOLS: readonly string[] = ["Glob", "Grep", "Read", "ToolSearch"];

/**
 * Tools denied on top of that, as a second guard: deny rules win over the project's allow rules
 * and over the user's default permission mode.
 */
export const PLAN_DENIED_TOOLS: readonly string[] = ["Bash", "Edit", "NotebookEdit", "Write"];

const STATES: readonly TaskState[] = ["proposed", "todo", "doing", "done"];

export function buildPlanPrompt(document: TasksDocument, options: PlanPromptOptions = {}): string {
  const { project } = document;
  const parts: string[] = [
    `You are helping the human plan work on the project "${project.name}", whose plan Konsora keeps in .konsora/tasks.json. This is a planning session: you interview the human and create the tasks of the plan. Tasks go straight to "todo" (no approval); only loose ideas the human has not committed to go in as ideas ("proposed"), with idea: true on that task of the batch. Do not change any code and do not start any task.`,
  ];

  const goal = options.goal?.trim();
  if (goal) parts.push(section("What the human wants to plan", goal));

  parts.push(
    section(
      "The interview",
      [
        `1. Ask the human, one topic at a time, and wait for each answer:${goal ? " start from what they said above and ask only what is missing." : ""}`,
        "   - the goal: what must be true when the work is done, and why;",
        "   - the scope: what is in and what is explicitly out;",
        "   - the constraints: technology, deadlines, things that must not change.",
        "2. Read the plan with Konsora's status, list and show tools, and read the code the goal touches, so the tasks fit what exists and do not repeat planned work.",
        "3. Sum up what you understood, with the tasks you would propose, and let the human correct it.",
        "4. Create all the tasks with a single batch call. Then tell the human their ids, and stop.",
      ].join("\n"),
    ),
  );

  parts.push(
    section(
      "Every task",
      [
        "- An imperative title and a desc that says what the task achieves and why.",
        '- Acceptance criteria that can be verified: a command that passes or an observable result, never a judgement such as "works well". Each task should be small enough for one agent run.',
        "- deps on the tasks it needs (ids of existing tasks, or titles of earlier tasks in the same batch).",
        "- A group from the plan's groups; a new one only if none fits, declared in the batch's groups.",
        "- A template when one fits (template: <id>): the task takes its description, criteria and labels, and what you pass completes or replaces them.",
      ].join("\n"),
    ),
  );

  const count = (state: TaskState) => document.tasks.filter((t) => t.state === state).length;
  const today = [
    `Groups: ${document.groups.map((g) => `${g.id} (${g.name})`).join(", ")}.`,
    `Tasks: ${document.tasks.length} (${STATES.map((s) => `${count(s)} ${s}`).join(", ")}).`,
  ];
  const templates = project.templates ?? [];
  today.push(
    templates.length > 0
      ? ["Templates:", ...templates.map((t) => `- ${t.id}: ${t.name}`)].join("\n")
      : "Templates: none.",
  );
  parts.push(section("The plan today", today.join("\n")));

  parts.push(
    section(
      "Rules",
      [
        "- Read and change the plan only with Konsora's tools; never edit .konsora/tasks.json.",
        "- In this session you may only plan: create tasks (propose, batch), revise or delete tasks nobody started (edit, delete, depend, undepend, promote). Konsora refuses anything else.",
        "- If something is unclear, ask the human instead of guessing.",
      ].join("\n"),
    ),
  );

  return `${parts.join("\n\n")}\n`;
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}
