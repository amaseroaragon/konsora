/**
 * The brief a human pastes into an agent's session to have it work one task (UI-28). Konsora
 * runs no agent: this is only text for the clipboard, in English like the rest of the agents'
 * channel.
 */
import type { Task } from "./schema.ts";

/** Whether a task can be handed to an agent: ready to start, or already in progress. */
export function canBrief(task: Pick<Task, "state">, flags: { ready: boolean }): boolean {
  return task.state === "doing" || (task.state === "todo" && flags.ready);
}

export function agentBrief(task: Pick<Task, "id" | "title" | "state">): string {
  const first =
    task.state === "doing"
      ? `Resume task ${task.id} of this project's Konsora plan ("${task.title}"); it is already in progress.`
      : `Work on task ${task.id} of this project's Konsora plan ("${task.title}").`;
  return [
    first,
    `Read it first with \`konsora show ${task.id}\` (or the show tool of Konsora's MCP server): its description, acceptance criteria and notes.`,
    task.state === "doing"
      ? "Then carry on, following the Konsora skill: note progress, ask if a decision is the human's, and finish it with a summary, evidence per criterion and your commits."
      : `Then follow the Konsora skill: start it, note progress, ask if a decision is the human's, and finish it with a summary, evidence per criterion and your commits.`,
  ].join("\n");
}
