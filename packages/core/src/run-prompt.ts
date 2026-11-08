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

import { DEFAULT_PROFILE_COMMANDS, READONLY_PROFILE_COMMANDS } from "./agents.ts";
import { indexTasks } from "./graph.ts";
import { type CheckAttempt, checkPassed, type Run, tailOutput } from "./run.ts";
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
    toolGuidance(),
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

/**
 * The message that resumes the session of a run interrupted because Konsora stopped (RUN-27).
 * Deterministic: it depends only on the task id.
 */
export function buildResumePrompt(taskId: string): string {
  return [
    `Konsora stopped while you were working on ${taskId}, and the human has resumed this run. You are in the same worktree, on the same branch, and everything you committed or left in it is still there.`,
    "",
    `Check where you left off (\`git status\`, \`git log\`) and continue with ${taskId}. Anything you were waiting for when Konsora stopped (a command, an approval) did not finish: run it again if you still need it. When the task is done, call \`finish\` with your summary.`,
    "",
  ].join("\n");
}

/** How much of each failed check's output the retry prompt carries: its last characters. */
export const RETRY_OUTPUT_MAX = 4000;

/**
 * The message that gives a failed attempt back to the run's agent: each failed check with its
 * command, how it ended and the tail of its output (at most `RETRY_OUTPUT_MAX` characters).
 * Deterministic: no times or durations, so the same results always give the same text.
 */
export function buildRetryPrompt(
  taskId: string,
  attempt: Pick<CheckAttempt, "attempt" | "results">,
  retriesLeft: number,
): string {
  const failed = attempt.results.filter((result) => !checkPassed(result));
  const blocks = failed.map((result) => {
    const name =
      result.source === "project"
        ? `Project check ${result.id}`
        : `Acceptance criterion ${result.id}`;
    const ending = result.timed_out
      ? "It ran out of time and was stopped."
      : result.exit_code === null
        ? "It was stopped by a signal."
        : `It exited with code ${result.exit_code}.`;
    const { output, truncated } = tailOutput(result.output.trimEnd(), RETRY_OUTPUT_MAX);
    const body = output
      ? `${truncated ? "Last part of its output (earlier output omitted):" : "Its output:"}\n${fence(output)}`
      : "It printed nothing.";
    return `### ${name}: \`${result.command}\`\n\n${ending}\n\n${body}`;
  });
  const after =
    retriesLeft > 0
      ? `If they still fail, you will get ${retriesLeft === 1 ? "one more try" : `${retriesLeft} more tries`}.`
      : "This is the last try: if they still fail, the task goes to review with the checks failing.";
  return [
    `Konsora ran the checks of ${taskId} after you called \`finish\` (attempt ${attempt.attempt}), and ${failed.length === 1 ? "one failed" : `${failed.length} failed`}.`,
    "",
    ...blocks.flatMap((block) => [block, ""]),
    `Fix the cause in your worktree and commit, then call \`finish\` on ${taskId} again with an updated summary. Konsora will run every check again. ${after}`,
    "",
    `If you are sure a check cannot pass because of anything in this task's work (the check itself is wrong or impossible, or it depends on something outside the worktree), do not \`ask\` and do not change the check: call \`finish\` on ${taskId} with a summary that explains why. The task then goes to review with that check failing, and the human decides.`,
    "",
  ].join("\n");
}

/** A code fence longer than any run of backticks in `text`. */
function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const marks = "`".repeat(longest + 1);
  return `${marks}\n${text}\n${marks}`;
}

export type RebasePromptInput = {
  /** The run's branch (the conflicting run's, reused). */
  branch: string;
  /** The tip of `base_branch` to rebase onto (a full commit id). */
  onto: string;
  /** The files that conflict, as `git merge-tree` lists them. */
  files: readonly string[];
};

/**
 * The prompt of a rebase run: the task's branch no longer integrates into `base_branch`, and the
 * agent rebases it onto the current tip and resolves the conflicts. Deterministic: the same task,
 * branch, tip and files always give the same text (files are sorted).
 */
export function buildRebasePrompt(
  document: TasksDocument,
  taskId: string,
  input: RebasePromptInput,
): string {
  const task = indexTasks(document).get(taskId);
  if (!task) throw new RangeError(`Task ${taskId} does not exist`);
  const base = document.project.base_branch;
  const files = [...new Set(input.files)].sort();
  const checks = document.project.checks ?? [];
  return [
    `You are working on task ${task.id} of the project "${document.project.name}", planned with Konsora.`,
    "",
    section(`Task ${task.id}: ${task.title}`, task.desc?.trim() || "(no description)"),
    "",
    section(
      "Why you are here",
      [
        `The work on the branch \`${input.branch}\` is done, but it no longer integrates into \`${base}\`: \`${base}\` moved on and both change the same lines. The human asked you to rebase the branch and resolve the conflicts.`,
        "",
        files.length > 0
          ? ["Files that conflict:", ...files.map((file) => `- \`${file}\``)].join("\n")
          : "Git did not name the conflicting files; find them while rebasing.",
      ].join("\n"),
    ),
    "",
    section(
      "What to do",
      [
        `1. In this worktree, on \`${input.branch}\`, run \`git rebase ${input.onto}\` (the current tip of \`${base}\`).`,
        `2. Resolve each conflict keeping both intents: what ${task.id} does and what \`${base}\` changed since. Do not drop either side to make the conflict go away. \`git add\` each file and \`git rebase --continue\` until the rebase is complete.`,
        `3. Make sure the result still meets the task's acceptance criteria${checks.length > 0 ? ` and that the project checks pass (${checks.map((c) => `\`${c.run}\``).join(", ")})` : ""}.`,
        `4. Call \`finish\` on ${task.id} with a summary of how you resolved each conflict. Konsora then runs the checks again and the task goes back to review.`,
        "",
        `If you cannot resolve a conflict without a decision from the human, \`ask\` on ${task.id} and wait. If the rebase goes wrong, \`git rebase --abort\` and start again.`,
      ].join("\n"),
    ),
    "",
    section(
      "Rules",
      [
        `- Stay on \`${input.branch}\` and leave the rebase finished: never check out, reset, commit to, push or force-update \`${base}\`.`,
        "- Never push anything and never use `--force`: the rebase only rewrites your own branch, locally.",
        "- Do not create, edit or delete anything under `.konsora/`: the plan changes only through Konsora's tools.",
        toolGuidance(),
        "- You cannot approve tasks, accept work or mark anything done; the human reviews your result.",
      ].join("\n"),
    ),
    "",
  ].join("\n");
}

/**
 * How to use tools so the run does not stop for approvals the human may not be there to give:
 * files through the agent's own tools, and shell commands one at a time, naming those the
 * `default` profile allows without asking.
 */
function toolGuidance(): string {
  const allowed = DEFAULT_PROFILE_COMMANDS.map(({ command, prefix }) =>
    prefix ? `\`${command} …\`` : `\`${command}\``,
  ).join(", ");
  return `- Create, change and read files with your file-editing and file-reading tools, not with shell commands. Run shell commands one at a time, never chained with \`&&\`, \`;\` or pipes. You can run ${allowed} and the project's checks without asking; any other command may wait for the human's approval, so use it only when you need it.`;
}

/** How much of the reviewed diff the review prompt carries: its first characters. */
export const REVIEW_DIFF_MAX = 60_000;

export type ReviewPromptInput = {
  /** The run under review (its summary, checks, branch and commits). */
  run: Pick<Run, "id" | "branch" | "base_commit" | "head_commit" | "summary" | "checks">;
  /** Its `diff.patch`; `null` if there is none. */
  diff: string | null;
};

/**
 * The prompt of a review run (RUN-29): the task, its criteria, the reviewed run's summary, check
 * results and diff (at most `REVIEW_DIFF_MAX` characters), and how to leave the verdict with the
 * `review` tool, without changing anything. Deterministic: no times nor durations.
 */
export function buildReviewPrompt(
  document: TasksDocument,
  taskId: string,
  input: ReviewPromptInput,
): string {
  const task = indexTasks(document).get(taskId);
  if (!task) throw new RangeError(`Task ${taskId} does not exist`);
  const { run } = input;
  const criteria = task.acceptance?.length
    ? task.acceptance
        .map((ac) => `- ${ac.id}: ${ac.text}${ac.check ? `\n  Check: \`${ac.check}\`` : ""}`)
        .join("\n")
    : "(no acceptance criteria)";
  const checks = run.checks?.length
    ? run.checks
        .map((c) => {
          const how = checkPassed(c)
            ? "passed"
            : c.timed_out
              ? "ran out of time"
              : c.exit_code === null
                ? "was stopped"
                : `failed (exit ${c.exit_code})`;
          return `- ${c.id}: ${how}`;
        })
        .join("\n")
    : "No checks ran.";
  const diff = input.diff?.trim() ?? "";
  const shown =
    diff.length > REVIEW_DIFF_MAX
      ? `${fence(diff.slice(0, REVIEW_DIFF_MAX))}\n\nThe diff is longer: only its first part is shown. Read the rest with \`git diff\` in your worktree.`
      : diff
        ? fence(diff)
        : "The run changed no files.";
  const range =
    run.base_commit && run.head_commit
      ? ` (\`git diff ${run.base_commit}..${run.head_commit}\`)`
      : "";
  const allowed = READONLY_PROFILE_COMMANDS.map(({ command, prefix }) =>
    prefix ? `\`${command} …\`` : `\`${command}\``,
  ).join(", ");
  return [
    `You are reviewing the work of Konsora run ${run.id} on task ${task.id} of the project "${document.project.name}". Another agent did the work; you only review it.`,
    "",
    section(`Task ${task.id}: ${task.title}`, task.desc?.trim() || "(no description)"),
    "",
    section("Acceptance criteria", criteria),
    "",
    section("The agent's summary", run.summary ? quote(run.summary) : "(no summary)"),
    "",
    section("Checks", checks),
    "",
    section(`Changes${range}`, shown),
    "",
    section(
      "What to do",
      [
        `1. Read the changes in your worktree${run.branch ? `, on \`${run.branch}\`` : ""}, and judge whether they meet each acceptance criterion, are correct, and leave nothing important out.`,
        `2. Call the \`review\` tool on ${task.id} once, with your verdict: \`approve\` if you would accept the work as it is, or \`changes\` if you would ask for changes. In the text, give your reasons: what holds, and what is wrong or missing, with files and lines.`,
        "3. Then stop. The human decides: your review is advice.",
      ].join("\n"),
    ),
    "",
    section(
      "Rules",
      [
        "- This review is read-only: do not create, edit or delete any file, do not commit and do not run anything that writes. Such tools are denied.",
        `- You can read files with your file-reading tools and run ${allowed}. Run shell commands one at a time.`,
        "- You cannot note, ask, finish, accept or send back: only `review`.",
      ].join("\n"),
    ),
    "",
  ].join("\n");
}
