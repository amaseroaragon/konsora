/**
 * The prompt of a planning session (`konsora plan`, CLI-05): the agent interviews the human and
 * ends by proposing a batch of tasks. A pure, deterministic function of the plan, like the run's
 * prompt, so the same plan always yields the same text.
 *
 * It carries the interview steps, what every proposed task needs (verifiable criteria,
 * dependencies, difficulty, a template when one fits), a summary of the plan as it is (groups,
 * task counts, templates) and the rules of the session.
 */
import type { TaskState, TasksDocument } from "./schema.ts";

export type PlanPromptOptions = {
  /** What the human said they want to plan, if they said it when starting the session. */
  goal?: string;
};

const STATES: readonly TaskState[] = ["proposed", "todo", "doing", "review", "done"];

export function buildPlanPrompt(document: TasksDocument, options: PlanPromptOptions = {}): string {
  const { project } = document;
  const parts: string[] = [
    `You are helping the human plan work on the project "${project.name}", whose plan Konsora keeps in .konsora/tasks.json. This is a planning session: you interview the human and propose tasks; the human approves them or not. Do not change any code and do not start any task.`,
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
        "4. Propose all the tasks with a single batch call. Then tell the human their ids, remind them that they approve proposals in Konsora, and stop.",
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
        "- A difficulty: low (mechanical, a few files), medium (a feature within one area), or high (cross-cutting, design decisions, or risky). Konsora picks the agent the project recommends for it.",
        "- A group from the plan's groups; a new one only if none fits, declared in the batch's groups.",
        "- A template when one fits (template: <id>): the task takes its description, criteria, labels and difficulty, and what you pass completes or replaces them.",
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
      ? [
          "Templates:",
          ...templates.map(
            (t) => `- ${t.id}: ${t.name}${t.difficulty ? ` (difficulty ${t.difficulty})` : ""}`,
          ),
        ].join("\n")
      : "Templates: none.",
  );
  parts.push(section("The plan today", today.join("\n")));

  parts.push(
    section(
      "Rules",
      [
        "- Read and change the plan only with Konsora's tools; never edit .konsora/tasks.json.",
        "- In this session you may only propose (propose, batch) and revise or withdraw proposals (edit, withdraw). Konsora refuses anything else.",
        "- If something is unclear, ask the human instead of guessing.",
      ].join("\n"),
    ),
  );

  return `${parts.join("\n\n")}\n`;
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}
