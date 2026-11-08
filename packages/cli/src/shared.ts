/** Helpers shared by the CLI commands: I/O, errors, plan discovery and loading. */
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { TasksDocument } from "@konsora/core";
import { readTasks, type StoreError, tasksPath } from "@konsora/core/store";
import { issuesText } from "./format.ts";
import { type Channel, HINTS, type Hint } from "./hints.ts";
import { findRoot } from "./project.ts";

export type Io = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Reads all of standard input (for --stdin and batch). */
  readStdin?: () => Promise<string>;
  /** Injected clock for reproducible output in tests. */
  now?: () => Date;
  /** Streams for `konsora mcp` (default: the process's stdin and stdout). */
  stdio?: { stdin: Readable; stdout: Writable };
};

export const EXIT = { ok: 0, failure: 1, usage: 2 } as const;

export class CliError extends Error {
  readonly exitCode: number;
  /** A plain string is the same on every channel; a `Hint` is worded for each one. */
  readonly #hint: string | Hint | undefined;
  constructor(message: string, hint?: string | Hint, exitCode: number = EXIT.failure) {
    super(message);
    this.#hint = hint;
    this.exitCode = exitCode;
  }
  /** The hint as the CLI words it. */
  get hint(): string | undefined {
    return this.hintFor("cli");
  }
  hintFor(channel: Channel): string | undefined {
    return typeof this.#hint === "string" ? this.#hint : this.#hint?.[channel];
  }
}

export const VERSION = "0.0.0";

export function timestamp(io: Io): string {
  return (io.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function storeError(error: StoreError, root: string): never {
  switch (error.code) {
    case "missing":
      throw new CliError(`No plan at ${tasksPath(root)}.`, HINTS.noPlan);
    case "invalid":
      throw new CliError(
        `The plan is invalid:\n${issuesText(error.issues ?? []).trimEnd()}`,
        HINTS.invalidPlan,
      );
    default:
      throw new CliError(error.message);
  }
}

export type RunScope = { task?: string; run?: string; plan?: boolean; review?: boolean };

/**
 * Inside a Konsora run the runner sets KONSORA_TASK (KONSORA_RUN_TASK is accepted as an alias)
 * and KONSORA_RUN: an agent may then only work on that task, and its notes carry the run id.
 * In a planning session KONSORA_PLAN=1 limits the agent to proposals.
 */
export function runScope(env: NodeJS.ProcessEnv): RunScope {
  const task = env.KONSORA_TASK?.trim().toUpperCase() || undefined;
  const alias = env.KONSORA_RUN_TASK?.trim().toUpperCase() || undefined;
  if (task && alias && task !== alias) {
    throw new CliError(
      `KONSORA_TASK (${task}) and KONSORA_RUN_TASK (${alias}) name different tasks.`,
      "Set only KONSORA_TASK.",
      EXIT.usage,
    );
  }
  const scope: RunScope = {};
  const runTask = task ?? alias;
  if (runTask) scope.task = runTask;
  if (env.KONSORA_RUN?.trim()) scope.run = env.KONSORA_RUN.trim();
  // `konsora plan` starts its MCP server with KONSORA_PLAN=1: proposals only (CLI-05).
  if (env.KONSORA_PLAN === "1") scope.plan = true;
  // A review run (RUN-29) starts its MCP server with KONSORA_REVIEW=1: review notes only.
  if (env.KONSORA_REVIEW === "1") scope.review = true;
  return scope;
}

export function locate(io: Io, explicit: string | undefined): string {
  const project = io.env.KONSORA_PROJECT;
  if (project && explicit && resolve(io.cwd, explicit) !== resolve(io.cwd, project)) {
    throw new CliError(
      "--root points to a different plan than KONSORA_PROJECT.",
      HINTS.rootMismatch,
      EXIT.usage,
    );
  }
  const root = findRoot(io.cwd, explicit, io.env);
  if (!root) {
    throw new CliError(`No .konsora/ folder found in ${io.cwd} or its parents.`, HINTS.noProject);
  }
  return root;
}

export async function load(
  io: Io,
  explicit: string | undefined,
): Promise<{ root: string; doc: TasksDocument }> {
  const root = locate(io, explicit);
  const result = await readTasks(root);
  if (!result.ok) storeError(result.error, root);
  return { root, doc: (result as { document: TasksDocument }).document };
}

export function json(io: Io, value: unknown) {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}
