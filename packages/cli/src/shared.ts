/** Helpers shared by the CLI commands: I/O, errors, plan discovery and loading. */
import { execFileSync } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { DEFAULT_BASE_BRANCH, type TasksDocument } from "@konsora/core";
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

export type SessionScope = { plan?: boolean };

/**
 * A planning session (`konsora plan`, the UI's AI panel) starts its MCP server with
 * KONSORA_PLAN=1: the agent may then only propose tasks and revise or withdraw proposals.
 */
export function sessionScope(env: NodeJS.ProcessEnv): SessionScope {
  return env.KONSORA_PLAN === "1" ? { plan: true } : {};
}

export function locate(io: Io, explicit: string | undefined): string {
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

/** The branch checked out in `root`, the default base of a new block (`main` when unknown). */
export function defaultBase(root: string): string {
  try {
    const name = execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return name || DEFAULT_BASE_BRANCH;
  } catch {
    return DEFAULT_BASE_BRANCH;
  }
}
