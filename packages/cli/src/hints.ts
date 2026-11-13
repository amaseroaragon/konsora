/**
 * Every hint the CLI and the MCP server give with an error (MCP-07). The rules behind an error
 * are shared; only the wording of the hint depends on the channel: the CLI names commands and
 * `--options`, the MCP names its tools and their parameters.
 */
import type { OpError } from "@konsora/core";

export type Hint = { cli: string; mcp: string };
export type Channel = keyof Hint;

/** Hints for the refusals of core's semantic ops. */
export const OP_HINTS: Partial<Record<OpError["code"], Hint>> = {
  forbidden: {
    cli: "Agents create, start, note, ask and finish tasks, and edit or delete unfinished ones; humans reopen and change finished work in the Konsora UI.",
    mcp: "Agents create, start, note, ask and finish tasks, and edit or delete unfinished ones; humans reopen and change finished work in the Konsora UI.",
  },
  blocked: {
    cli: "Pick another task with `konsora ready`, or wait until its dependencies are done.",
    mcp: "Pick another task with the ready tool, or wait until its dependencies are done.",
  },
  invalid_transition: {
    cli: "Check the task's state with `konsora show <id>`.",
    mcp: "Check the task's state with the show tool.",
  },
  summary_required: {
    cli: "Pass --summary with what you did and how it meets the acceptance criteria.",
    mcp: "Pass summary with what you did and how it meets the acceptance criteria.",
  },
  out_of_scope: {
    cli: "In a planning session you may only create tasks, and revise or delete tasks nobody started.",
    mcp: "In a planning session you may only create tasks, and revise or delete tasks nobody started.",
  },
  not_found: {
    cli: "Use `konsora list` to see task ids and `konsora status` for groups.",
    mcp: "Use the list tool to see task ids and the status tool for groups.",
  },
  unknown_template: {
    cli: "`konsora status` lists the project's templates; only the human defines them, in the Konsora UI.",
    mcp: "The status tool lists the project's templates (project.templates); only the human defines them, in the Konsora UI.",
  },
  in_use: {
    cli: "Delete those tasks or leave the group: a task keeps its id (and its group prefix) when moved with `konsora edit <id> --group`.",
    mcp: "Delete those tasks or leave the group: a task keeps its id (and its group prefix) when moved with the edit tool.",
  },
  conflict: {
    cli: "Someone changed the task meanwhile; read it again with `konsora show <id>` and retry.",
    mcp: "Someone changed the task meanwhile; read it again with the show tool and retry.",
  },
};

/** Hints for the CLI's own errors that the MCP tools can also hit. */
export const HINTS = {
  noPlan: {
    cli: "Run `konsora init` in your project folder.",
    mcp: "Ask the human to initialize Konsora in the project folder.",
  },
  oldSchema: {
    cli: "The plan is in an older format: preview the conversion with `konsora migrate`, then apply it with `konsora migrate --write`.",
    mcp: "The plan is in an older format; ask the human to convert it (Konsora's migrate command) before going on.",
  },
  invalidPlan: {
    cli: "Fix the file (see `konsora check`); Konsora never overwrites an invalid plan.",
    mcp: "Fix the file (the check tool lists every problem); Konsora never overwrites an invalid plan.",
  },
  noProject: {
    cli: "Run `konsora init` in your project folder, or pass --root <dir>.",
    mcp: "Start the server from the project folder, or set KONSORA_ROOT to it; the human initializes Konsora there first.",
  },
  unknownTask: {
    cli: "Use `konsora list` to see task ids.",
    mcp: "Use the list tool to see task ids.",
  },
  batchShape: {
    cli: "See `konsora batch --help` for the JSON format.",
    mcp: "The batch tool's input schema describes the format.",
  },
  nothingToChange: {
    cli: "Pass --title, --desc, --criterion, --labels, --group or --difficulty.",
    mcp: "Pass title, desc, acceptance, labels, group or difficulty.",
  },
  movePlace: {
    cli: "Pass exactly one of --before <id>, --after <id> or --top.",
    mcp: "Pass exactly one of before, after or top.",
  },
  notAgent: {
    cli: "Human actions (reopen, answer) happen in the Konsora UI.",
    mcp: "Human actions (reopen, answer) happen in the Konsora UI; set KONSORA_AGENT to the agent's name.",
  },
  agentName: {
    cli: "Use lowercase letters, digits, dots, dashes or underscores, e.g. --as claude.",
    mcp: "Set KONSORA_AGENT to lowercase letters, digits, dots, dashes or underscores, e.g. claude.",
  },
} as const satisfies Record<string, Hint>;

/** The hint for a rule refusal on `channel`, if there is one. */
export function opHint(error: Pick<OpError, "code">, channel: Channel = "cli"): string | undefined {
  return OP_HINTS[error.code]?.[channel];
}
