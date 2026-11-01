/** Helpers shared by the CLI commands: I/O, errors, plan discovery and loading. */
import type { Readable, Writable } from "node:stream";
import type { TasksDocument } from "@konsora/core";
import { readTasks, type StoreError, tasksPath } from "@konsora/core/store";
import { issuesText } from "./format.ts";
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
  readonly hint: string | undefined;
  constructor(message: string, hint?: string, exitCode: number = EXIT.failure) {
    super(message);
    this.hint = hint;
    this.exitCode = exitCode;
  }
}

export const VERSION = "0.0.0";

export function timestamp(io: Io): string {
  return (io.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function storeError(error: StoreError, root: string): never {
  switch (error.code) {
    case "missing":
      throw new CliError(
        `No plan at ${tasksPath(root)}.`,
        "Run `konsora init` in your project folder.",
      );
    case "invalid":
      throw new CliError(
        `The plan is invalid:\n${issuesText(error.issues ?? []).trimEnd()}`,
        "Fix the file (see `konsora check`); Konsora never overwrites an invalid plan.",
      );
    default:
      throw new CliError(error.message);
  }
}

export function locate(io: Io, explicit: string | undefined): string {
  const root = findRoot(io.cwd, explicit, io.env);
  if (!root) {
    throw new CliError(
      `No .konsora/ folder found in ${io.cwd} or its parents.`,
      "Run `konsora init` in your project folder, or pass --root <dir>.",
    );
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
