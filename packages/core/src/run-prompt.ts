/**
 * The prompt of a run (docs/arquitectura.md §5, "Lanzar"): explicit and auditable. A pure,
 * deterministic function of the plan, so the same task always yields the same prompt and the
 * exact text is stored in `run.json`.
 *
 * It carries the task (title, description, acceptance criteria and their checks), the project's
 * checks, the human's `feedback` notes and each `answer` with the question it answers, the
 * summaries of the dependencies, and the protocol. Ordinary notes, questions without an answer
 * and the agent's own summaries stay out: they are progress, not instructions.
 */
import { indexTasks } from "./graph.ts";
import type { Note, Task, TasksDocument } from "./schema.ts";

export type RunPromptOptions = {
  /** The run's branch, named in the protocol when known. */
  branch?: string;
};

export function buildRunPrompt(
  document: TasksDocument,
  taskId: string,
  options: RunPromptOptions = {},
): string {
  const index = indexTasks(document);
  const task = index.get(taskId);
  if (!task) throw new RangeError(`Task ${taskId} does not exist`);

  const parts: string[] = [
    `You are working on task ${task.id} of the project "${document.project.name}", planned with Konsora.`,
    section(`Task ${task.id}: ${task.title}`, task.desc?.trim() || "(no description)"),
  ];

  if (task.acceptance?.length) {
    parts.push(
      section(
        "Acceptance criteria",
        [
          "The task is done when every criterion holds:",
          ...task.acceptance.map(
            (ac) => `- ${ac.id}: ${ac.text}${ac.check ? `\n  Check: \`${ac.check}\`` : ""}`,
          ),
        ].join("\n"),
      ),
    );
  }

  if (document.project.checks?.length) {
    parts.push(
      section(
        "Project checks",
        [
          "Konsora runs these in your worktree after you finish; make them pass:",
          ...document.project.checks.map((check) => `- ${check.id}: \`${check.run}\``),
        ].join("\n"),
      ),
    );
  }

  const guidance = humanGuidance(task.notes ?? []);
  if (guidance.length > 0) {
    parts.push(
      section(
        "From the human",
        ["Earlier feedback and answers on this task. Follow them:", ...guidance].join("\n\n"),
      ),
    );
  }

  const deps = (task.deps ?? []).flatMap((id) => {
    const dep = index.get(id);
    return dep ? [dependencyBlock(dep)] : [];
  });
  if (deps.length > 0) {
    parts.push(
      section("Dependencies", ["This task builds on these finished tasks:", ...deps].join("\n\n")),
    );
  }

  parts.push(section("How to work", protocol(task, document, options)));
  return `${parts.join("\n\n")}\n`;
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

function quote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

/** `feedback` notes, and each `answer` preceded by the question it answers. */
function humanGuidance(notes: readonly Note[]): string[] {
  const blocks: string[] = [];
  let question: Note | undefined;
  for (const note of notes) {
    if (note.kind === "question") {
      question = note;
    } else if (note.kind === "answer") {
      blocks.push(
        question
          ? `Question (${question.at}):\n${quote(question.text)}\nAnswer (${note.at}):\n${quote(note.text)}`
          : `Answer (${note.at}):\n${quote(note.text)}`,
      );
      question = undefined;
    } else if (note.kind === "feedback") {
      blocks.push(`Feedback (${note.at}):\n${quote(note.text)}`);
    }
  }
  return blocks;
}

function dependencyBlock(dep: Task): string {
  const summary = [...(dep.notes ?? [])].reverse().find((note) => note.kind === "summary");
  return `### ${dep.id}: ${dep.title} (${dep.state})\n\n${
    summary ? quote(summary.text) : "(no summary)"
  }`;
}

function protocol(task: Task, document: TasksDocument, options: RunPromptOptions): string {
  const branch = options.branch ? `the branch \`${options.branch}\`` : "this worktree's branch";
  return [
    `- You are in a git worktree of your own, on ${branch}, created from \`${document.project.base_branch}\`. Work only on this task.`,
    `- Commit your work on this branch in small commits. Never push, never switch branches and never rewrite the history of \`${document.project.base_branch}\`.`,
    "- Do not create, edit or delete anything under `.konsora/`: the plan changes only through Konsora's tools.",
    `- Use the Konsora MCP tools on ${task.id}: \`note\` to record meaningful progress, \`ask\` when you need a decision from the human (then stop and wait for the answer), and \`finish\` with a summary of what you did and how it meets each acceptance criterion when you are done.`,
    "- You cannot approve tasks, accept work or mark anything done; the human reviews your result.",
  ].join("\n");
}

/**
 * The message that delivers the human's answer to a run's agent: the latest `answer` with the
 * question it answers. `null` if the task has no answer after its latest question.
 */
export function buildAnswerMessage(task: Task): string | null {
  const notes = task.notes ?? [];
  const last = notes.findLastIndex((note) => note.kind === "answer");
  const answer = notes[last];
  if (!answer) return null;
  const laterQuestion = notes.slice(last + 1).some((note) => note.kind === "question");
  if (laterQuestion) return null;
  const question = notes.slice(0, last).findLast((note) => note.kind === "question");
  return [
    `The human answered your question on ${task.id}.`,
    ...(question ? ["", "Question:", quote(question.text)] : []),
    "",
    "Answer:",
    quote(answer.text),
    "",
    `Continue with ${task.id}. When it is done, call \`finish\` with your summary.`,
    "",
  ].join("\n");
}
