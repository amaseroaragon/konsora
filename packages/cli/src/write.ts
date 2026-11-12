/**
 * Agent write commands (CLI-02). Every command is one semantic op from @konsora/core applied
 * through the store (lock + validation + canonical atomic write).
 *
 * The CLI always acts as an agent: `--as` / KONSORA_AGENT name it (`agent:<name>`), and "human"
 * or "konsora" are refused. Human actions (reopen, answer, changing finished work, deleting
 * started work) are deliberately absent: they happen in the UI.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type Op, type OpContext, type OpError, type TasksDocument, taskHash } from "@konsora/core";
import { mutate } from "@konsora/core/store";
import type { Command } from "commander";
import { z } from "zod";
import { showText, views } from "./format.ts";
import { HINTS, opHint } from "./hints.ts";
import {
  CliError,
  EXIT,
  type Io,
  json,
  locate,
  sessionScope,
  storeError,
  timestamp,
} from "./shared.ts";

const AGENT_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** `--as claude` / KONSORA_AGENT=claude → `agent:claude`. Humans and Konsora cannot be impersonated. */
export function agentActor(value: string | undefined): string {
  const raw = (value ?? "unknown")
    .trim()
    .toLowerCase()
    .replace(/^agent:/, "");
  if (raw === "human" || raw === "konsora") {
    throw new CliError(
      `The CLI always acts as an agent; "${raw}" is not allowed in --as.`,
      HINTS.notAgent,
      EXIT.usage,
    );
  }
  if (!AGENT_NAME.test(raw)) {
    throw new CliError(`Invalid agent name "${value}".`, HINTS.agentName, EXIT.usage);
  }
  return `agent:${raw}`;
}

type TextOptions = { message?: string; file?: string; stdin?: boolean };

/** Text from a positional argument, -m, --file or --stdin (exactly one). */
async function readText(
  io: Io,
  positional: string | undefined,
  opts: TextOptions,
  what: string,
): Promise<string> {
  const sources = [positional, opts.message, opts.file, opts.stdin ? "stdin" : undefined].filter(
    (v) => v !== undefined,
  );
  if (sources.length > 1)
    throw new CliError(
      `Give the ${what} only once (argument, -m, --file or --stdin).`,
      undefined,
      EXIT.usage,
    );
  if (opts.file) return readFile(resolve(io.cwd, opts.file), "utf8");
  if (opts.stdin) {
    if (!io.readStdin) throw new CliError("No standard input available.", undefined, EXIT.usage);
    return io.readStdin();
  }
  const text = positional ?? opts.message;
  if (text === undefined)
    throw new CliError(
      `Missing ${what}.`,
      "Pass it as an argument, with -m, --file <path> or --stdin.",
      EXIT.usage,
    );
  return text;
}

const list = (value: string) =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const collect = (value: string, previous: string[] = []) => [...previous, value];

export const BatchSchema = z.strictObject({
  groups: z.array(z.strictObject({ id: z.string(), name: z.string() })).optional(),
  tasks: z
    .array(
      z.strictObject({
        title: z.string().min(1),
        group: z.string(),
        desc: z.string().optional(),
        acceptance: z.array(z.string().min(1)).optional(),
        deps: z.array(z.string()).optional(),
        labels: z.array(z.string()).optional(),
        template: z
          .string()
          .min(1)
          .optional()
          .describe("id of a project template the task starts from (see status)"),
        idea: z
          .boolean()
          .optional()
          .describe("true creates it as an idea (proposed) instead of in todo"),
      }),
    )
    .min(1),
});

/** Turns the batch JSON (CLI stdin/file or MCP argument) into a `batch` op. */
export function batchOp(value: unknown): Op {
  const parsed = BatchSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new CliError(
      `Batch has the wrong shape at ${first?.path.join(".") || "(root)"}: ${first?.message}`,
      HINTS.batchShape,
      EXIT.usage,
    );
  }
  const batch = parsed.data;
  return {
    op: "batch",
    ...(batch.groups ? { groups: batch.groups } : {}),
    tasks: batch.tasks.map((t) => ({
      title: t.title,
      group: t.group,
      ...(t.desc ? { desc: t.desc } : {}),
      ...(t.acceptance ? { acceptance: t.acceptance } : {}),
      ...(t.deps ? { deps: t.deps } : {}),
      ...(t.labels ? { labels: t.labels } : {}),
      ...(t.template ? { template: t.template.toLowerCase() } : {}),
      ...(t.idea ? { idea: true } : {}),
    })),
  };
}

export type EditInput = {
  title?: string | undefined;
  desc?: string | undefined;
  acceptance?: string[] | undefined;
  labels?: string[] | undefined;
  group?: string | undefined;
};

/** Builds an `edit` op for a proposal; the acceptance criteria are replaced as ac1, ac2, … */
export function editOp(id: string, input: EditInput): Op {
  const changes = {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.desc !== undefined ? { desc: input.desc } : {}),
    ...(input.acceptance
      ? { acceptance: input.acceptance.map((text, i) => ({ id: `ac${i + 1}`, text })) }
      : {}),
    ...(input.labels ? { labels: input.labels } : {}),
    ...(input.group ? { group: input.group.toUpperCase() } : {}),
  };
  if (Object.keys(changes).length === 0)
    throw new CliError("Nothing to change.", HINTS.nothingToChange, EXIT.usage);
  return { op: "edit", task: id.toUpperCase(), changes };
}

export type MoveInput = {
  before?: string | undefined;
  after?: string | undefined;
  top?: boolean | undefined;
};

/** Builds a `move` op: exactly one of before, after or top. */
export function moveOp(id: string, input: MoveInput): Extract<Op, { op: "move" }> {
  const given = [input.before, input.after, input.top ? "top" : undefined].filter(
    (place) => place !== undefined,
  );
  if (given.length !== 1)
    throw new CliError("Say where to move it, once.", HINTS.movePlace, EXIT.usage);
  return {
    op: "move",
    task: id.toUpperCase(),
    ...(input.before ? { before: input.before.toUpperCase() } : {}),
    ...(input.after ? { after: input.after.toUpperCase() } : {}),
    ...(input.top ? { top: true } : {}),
  };
}

export function describeMove(op: Extract<Op, { op: "move" }>): string {
  if (op.before) return `before ${op.before}`;
  if (op.after) return `after ${op.after}`;
  return "to the top";
}

export type WriteOutcome =
  | { ok: true; document: TasksDocument; created: string[]; changed: string[] }
  | { ok: false; error: OpError };

/**
 * Applies one agent op to the plan through the store (lock, validation, atomic write).
 * Store problems (no plan, invalid plan) throw a CliError; refusals by the rules come back
 * as `{ ok: false }` so each surface can report them its own way.
 */
export async function runOp(
  io: Io,
  explicitRoot: string | undefined,
  op: Op,
  actor: string,
): Promise<WriteOutcome> {
  const root = locate(io, explicitRoot);
  const ctx: OpContext = { actor, at: timestamp(io) };
  if (sessionScope(io.env).plan) ctx.plan = true;
  const result = await mutate(root, op, ctx);
  if (result.ok)
    return {
      ok: true,
      document: result.document,
      created: result.created,
      changed: result.changed,
    };
  if (result.source === "store") storeError(result.error, root);
  return { ok: false, error: result.error as OpError };
}

/** The `--json` value for a successful write: ids plus every affected task with its hash. */
export function writeJson(outcome: Extract<WriteOutcome, { ok: true }>) {
  const affected = [
    ...outcome.created,
    ...outcome.changed.filter((id) => !outcome.created.includes(id)),
  ];
  return {
    ok: true,
    created: outcome.created,
    changed: outcome.changed,
    tasks: views(outcome.document)
      .filter((t) => affected.includes(t.id))
      .map((t) => ({ ...t, hash: taskHash(t) })),
  };
}

export function registerWriteCommands(
  program: Command,
  io: Io,
  rootOption: () => string | undefined,
) {
  const withAgent = (command: Command) =>
    command
      .option("--as <agent>", "agent name for attribution (default: $KONSORA_AGENT or unknown)")
      .option("--json", "machine-readable output");

  const withText = (command: Command) =>
    command
      .option("-m, --message <text>", "text inline")
      .option("--file <path>", "read the text from a file (multi-line or non-ASCII text)")
      .option("--stdin", "read the text from standard input");

  /** Runs one op and prints the affected task (or the error with a hint). */
  async function apply(
    op: Op,
    opts: { as?: string; json?: boolean },
    describe: (doc: TasksDocument, created: string[]) => string,
  ) {
    const outcome = await runOp(io, rootOption(), op, agentActor(opts.as ?? io.env.KONSORA_AGENT));
    if (!outcome.ok) {
      if (opts.json) {
        json(io, { ok: false, error: outcome.error });
        throw new CliError("", undefined, EXIT.failure);
      }
      throw new CliError(outcome.error.message, opHint(outcome.error));
    }
    if (opts.json) json(io, writeJson(outcome));
    else io.stdout(describe(outcome.document, outcome.created));
  }

  withAgent(program.command("propose"))
    .description("create a task in todo (or, with --idea, as an idea to promote later)")
    .argument("<title>", "short imperative title")
    .requiredOption("--group <id>", "group id, e.g. CORE")
    .option("--desc <text>", "what the task achieves and why (markdown)")
    .option("--criterion <text>", "acceptance criterion; repeat for several", collect)
    .option("--deps <ids>", "comma-separated task ids it depends on", list)
    .option("--labels <labels>", "comma-separated labels", list)
    .option(
      "--template <id>",
      "start from a project template (see `konsora status`); explicit values complete or replace it",
    )
    .option("--idea", "create it as an idea (proposed) instead of todo")
    .action(
      async (
        title: string,
        opts: {
          idea?: boolean;
          group: string;
          desc?: string;
          criterion?: string[];
          deps?: string[];
          labels?: string[];
          template?: string;
          as?: string;
          json?: boolean;
        },
      ) => {
        await apply(
          {
            op: "propose",
            title,
            group: opts.group.toUpperCase(),
            ...(opts.desc ? { desc: opts.desc } : {}),
            ...(opts.criterion ? { acceptance: opts.criterion } : {}),
            ...(opts.deps ? { deps: opts.deps.map((d) => d.toUpperCase()) } : {}),
            ...(opts.labels ? { labels: opts.labels } : {}),
            ...(opts.template ? { template: opts.template.toLowerCase() } : {}),
            ...(opts.idea ? { state: "proposed" as const } : {}),
          },
          opts,
          (_doc, created) =>
            opts.idea
              ? `Created idea ${created[0]}: ${title}\nPromote it to todo with \`konsora promote ${created[0]}\`.\n`
              : `Created ${created[0]}: ${title} (todo).\n`,
        );
      },
    );

  withAgent(program.command("batch"))
    .description(
      "create many tasks (in todo, or as ideas with idea: true) at once from JSON, all-or-nothing; deps may name earlier titles",
    )
    .option("--file <path>", "read the JSON from a file instead of standard input")
    .addHelpText(
      "after",
      '\nJSON: {"groups":[{"id":"API","name":"API"}],"tasks":[{"title":"…","group":"API","desc":"…","acceptance":["…"],"deps":["CORE-01","<earlier title>"],"labels":["…"],"template":"<template id>"},{"title":"…","group":"API","idea":true}]}\nA task with "idea": true is created as an idea (proposed); the rest go to todo.',
    )
    .action(async (opts: { file?: string; as?: string; json?: boolean }) => {
      const text = await readText(
        io,
        undefined,
        opts.file ? { file: opts.file } : { stdin: true },
        "batch JSON",
      );
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (error) {
        throw new CliError(
          `Batch is not valid JSON: ${(error as Error).message}`,
          undefined,
          EXIT.usage,
        );
      }
      await apply(
        batchOp(value),
        opts,
        (doc, created) =>
          `Created ${created.length} task(s):\n${created
            .map((id) => `  ${id.padEnd(9)} ${doc.tasks.find((t) => t.id === id)?.title}`)
            .join("\n")}\n`,
      );
    });

  withAgent(program.command("edit"))
    .description("revise a task that is not done (finished work can only be changed by a human)")
    .argument("<id>")
    .option("--title <text>")
    .option("--desc <text>")
    .option("--criterion <text>", "replace the acceptance criteria; repeat for several", collect)
    .option("--labels <labels>", "replace labels (comma-separated)", list)
    .option("--group <id>", "move to another group (the id does not change)")
    .action(
      async (
        id: string,
        opts: {
          title?: string;
          desc?: string;
          criterion?: string[];
          labels?: string[];
          group?: string;
          as?: string;
          json?: boolean;
        },
      ) => {
        await apply(
          editOp(id, { ...opts, acceptance: opts.criterion }),
          opts,
          () => `Updated ${id.toUpperCase()}.\n`,
        );
      },
    );

  withAgent(program.command("move"))
    .description(
      "reorder a task that is not done: before or after another one, or first of all (the order is what `konsora ready` follows)",
    )
    .argument("<id>")
    .option("--before <id>", "place it right before this task")
    .option("--after <id>", "place it right after this task")
    .option("--top", "place it first of all")
    .action(
      async (
        id: string,
        opts: { before?: string; after?: string; top?: boolean; as?: string; json?: boolean },
      ) => {
        const op = moveOp(id, opts);
        await apply(op, opts, () => `Moved ${id.toUpperCase()} ${describeMove(op)}.\n`);
      },
    );

  withAgent(program.command("delete"))
    .description("delete a task nobody started (tasks depending on it lose that dependency)")
    .argument("<id>")
    .action(async (id: string, opts: { as?: string; json?: boolean }) => {
      await apply(
        { op: "delete", task: id.toUpperCase() },
        opts,
        () => `Deleted ${id.toUpperCase()}.\n`,
      );
    });

  withAgent(program.command("promote"))
    .description("turn an idea (proposed) into work to do (todo)")
    .argument("<id>")
    .action(async (id: string, opts: { as?: string; json?: boolean }) => {
      await apply(
        { op: "promote", task: id.toUpperCase() },
        opts,
        () => `Promoted ${id.toUpperCase()} to todo.\n`,
      );
    });

  withAgent(program.command("depend"))
    .description("make <id> depend on <on> (rejected if it would create a cycle)")
    .argument("<id>")
    .argument("<on>")
    .action(async (id: string, on: string, opts: { as?: string; json?: boolean }) => {
      await apply(
        { op: "depend", task: id.toUpperCase(), on: on.toUpperCase() },
        opts,
        () => `${id.toUpperCase()} now depends on ${on.toUpperCase()}.\n`,
      );
    });

  withAgent(program.command("undepend"))
    .description("remove a dependency from a task that is not done")
    .argument("<id>")
    .argument("<on>")
    .action(async (id: string, on: string, opts: { as?: string; json?: boolean }) => {
      await apply(
        { op: "undepend", task: id.toUpperCase(), on: on.toUpperCase() },
        opts,
        () => `${id.toUpperCase()} no longer depends on ${on.toUpperCase()}.\n`,
      );
    });

  withText(withAgent(program.command("start")))
    .description("start a ready task (todo → doing); optionally note your plan")
    .argument("<id>")
    .action(async (id: string, opts: TextOptions & { as?: string; json?: boolean }) => {
      const plan =
        opts.message || opts.file || opts.stdin
          ? await readText(io, undefined, opts, "plan")
          : undefined;
      await apply(
        { op: "start", task: id.toUpperCase(), ...(plan ? { text: plan } : {}) },
        opts,
        (doc) =>
          `Started ${id.toUpperCase()} (doing).\n\n${showText(doc, views(doc).find((t) => t.id === id.toUpperCase()) as never)}`,
      );
    });

  withText(withAgent(program.command("pause")))
    .description("stop working on a task for now (doing → todo); optionally say why")
    .argument("<id>")
    .action(async (id: string, opts: TextOptions & { as?: string; json?: boolean }) => {
      const why =
        opts.message || opts.file || opts.stdin
          ? await readText(io, undefined, opts, "note")
          : undefined;
      await apply(
        { op: "pause", task: id.toUpperCase(), ...(why ? { text: why } : {}) },
        opts,
        () => `Paused ${id.toUpperCase()} (todo).\n`,
      );
    });

  withText(withAgent(program.command("note")))
    .description("add a progress note to a task")
    .argument("<id>")
    .argument("[text]")
    .action(
      async (
        id: string,
        text: string | undefined,
        opts: TextOptions & { as?: string; json?: boolean },
      ) => {
        const body = await readText(io, text, opts, "note text");
        await apply(
          { op: "note", task: id.toUpperCase(), text: body },
          opts,
          () => `Noted on ${id.toUpperCase()}.\n`,
        );
      },
    );

  withText(withAgent(program.command("ask")))
    .description("ask the human a question about a task you are doing; then stop and wait")
    .argument("<id>")
    .argument("[question]")
    .action(
      async (
        id: string,
        question: string | undefined,
        opts: TextOptions & { as?: string; json?: boolean },
      ) => {
        const body = await readText(io, question, opts, "question");
        await apply(
          { op: "ask", task: id.toUpperCase(), text: body },
          opts,
          () => `Asked on ${id.toUpperCase()}. Stop here and wait for the human's answer.\n`,
        );
      },
    );

  withAgent(program.command("finish"))
    .description("finish a task you are doing (doing → done) with a summary of what you did")
    .argument("<id>")
    .option("--summary <text>", "what you did and how it meets the acceptance criteria")
    .option("--summary-file <path>", "read the summary from a file")
    .option("--stdin", "read the summary from standard input")
    .action(
      async (
        id: string,
        opts: {
          summary?: string;
          summaryFile?: string;
          stdin?: boolean;
          as?: string;
          json?: boolean;
        },
      ) => {
        const summary = await readText(
          io,
          undefined,
          {
            ...(opts.summary !== undefined ? { message: opts.summary } : {}),
            ...(opts.summaryFile ? { file: opts.summaryFile } : {}),
            ...(opts.stdin ? { stdin: true } : {}),
          },
          "summary (--summary)",
        );
        await apply(
          { op: "finish", task: id.toUpperCase(), summary },
          opts,
          () => `Finished ${id.toUpperCase()}: done.\n`,
        );
      },
    );
}
