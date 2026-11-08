/**
 * Agent write commands (CLI-02). Every command is one semantic op from @konsora/core applied
 * through the store (lock + validation + canonical atomic write).
 *
 * The CLI always acts as an agent: `--as` / KONSORA_AGENT name it (`agent:<name>`), and "human"
 * or "konsora" are refused. Human transitions (approve, accept, send back, reopen, YOLO, editing
 * approved work) are deliberately absent: they happen in the Konsora UI.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type Difficulty,
  DifficultySchema,
  type Op,
  type OpContext,
  type OpError,
  type TasksDocument,
  taskHash,
} from "@konsora/core";
import { mutate } from "@konsora/core/store";
import type { Command } from "commander";
import { z } from "zod";
import { showText, views } from "./format.ts";
import {
  CliError,
  EXIT,
  type Io,
  json,
  locate,
  runScope,
  storeError,
  timestamp,
} from "./shared.ts";

const AGENT_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** `--as claude` / KONSORA_AGENT=codex → `agent:claude`. Humans and the runner cannot be impersonated. */
export function agentActor(value: string | undefined): string {
  const raw = (value ?? "unknown")
    .trim()
    .toLowerCase()
    .replace(/^agent:/, "");
  if (raw === "human" || raw === "konsora") {
    throw new CliError(
      `The CLI always acts as an agent; "${raw}" is not allowed in --as.`,
      "Humans approve, accept and send back work in the Konsora UI.",
      EXIT.usage,
    );
  }
  if (!AGENT_NAME.test(raw)) {
    throw new CliError(
      `Invalid agent name "${value}".`,
      "Use lowercase letters, digits, dots, dashes or underscores, e.g. --as claude.",
      EXIT.usage,
    );
  }
  return `agent:${raw}`;
}

const HINTS: Partial<Record<OpError["code"], string>> = {
  forbidden:
    "Agents propose, start, note, ask and finish; humans approve, accept and edit approved work in the Konsora UI.",
  blocked: "Pick another task with `konsora ready`, or wait until its dependencies are done.",
  invalid_transition: "Check the task's state with `konsora show <id>`.",
  summary_required: "Pass --summary with what you did and how it meets the acceptance criteria.",
  out_of_scope:
    "Inside a Konsora run you may only act on the run's task (you can still propose new tasks).",
  has_dependents: "Remove the dependency from the dependent proposals first (`konsora undepend`).",
  not_found: "Use `konsora list` to see task ids and `konsora status` for groups.",
  unknown_template:
    "`konsora status` lists the project's templates; only the human defines them, in the Konsora UI.",
  conflict: "Someone changed the task meanwhile; read it again with `konsora show <id>` and retry.",
};

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

/** `--difficulty low|medium|high`; for edit, `none` removes it. */
function difficulty(value: string, allowNone: boolean): Difficulty | "none" {
  const lower = value.trim().toLowerCase();
  if (allowNone && lower === "none") return "none";
  const parsed = DifficultySchema.safeParse(lower);
  if (parsed.success) return parsed.data;
  throw new CliError(
    `Invalid difficulty "${value}".`,
    `Use low, medium or high${allowNone ? " (or none to remove it)" : ""}.`,
    EXIT.usage,
  );
}

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
        difficulty: DifficultySchema.optional().describe(
          "estimated difficulty: low, medium or high",
        ),
        template: z
          .string()
          .min(1)
          .optional()
          .describe("id of a project template the task starts from (see status)"),
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
      "See `konsora batch --help` for the JSON format.",
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
      ...(t.difficulty ? { difficulty: t.difficulty } : {}),
      ...(t.template ? { template: t.template.toLowerCase() } : {}),
    })),
  };
}

export type EditInput = {
  title?: string | undefined;
  desc?: string | undefined;
  acceptance?: string[] | undefined;
  labels?: string[] | undefined;
  group?: string | undefined;
  /** `none` removes it. */
  difficulty?: Difficulty | "none" | undefined;
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
    ...(input.difficulty !== undefined
      ? { difficulty: input.difficulty === "none" ? undefined : input.difficulty }
      : {}),
  };
  if (Object.keys(changes).length === 0)
    throw new CliError(
      "Nothing to change.",
      "Pass --title, --desc, --criterion, --labels, --group or --difficulty.",
      EXIT.usage,
    );
  return { op: "edit", task: id.toUpperCase(), changes };
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
  const scope = runScope(io.env);
  if (scope.task) ctx.runTask = scope.task;
  if (scope.run) ctx.run = scope.run;
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

/** The actionable hint for a rule refusal, if there is one. */
export function opHint(error: OpError): string | undefined {
  return HINTS[error.code];
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
    .description("propose a new task (it waits for human approval)")
    .argument("<title>", "short imperative title")
    .requiredOption("--group <id>", "group id, e.g. CORE")
    .option("--desc <text>", "what the task achieves and why (markdown)")
    .option("--criterion <text>", "acceptance criterion; repeat for several", collect)
    .option("--deps <ids>", "comma-separated task ids it depends on", list)
    .option("--labels <labels>", "comma-separated labels", list)
    .option("--difficulty <level>", "estimated difficulty: low, medium or high", (v) =>
      difficulty(v, false),
    )
    .option(
      "--template <id>",
      "start from a project template (see `konsora status`); explicit values complete or replace it",
    )
    .action(
      async (
        title: string,
        opts: {
          group: string;
          desc?: string;
          criterion?: string[];
          deps?: string[];
          labels?: string[];
          difficulty?: Difficulty;
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
            ...(opts.difficulty ? { difficulty: opts.difficulty } : {}),
            ...(opts.template ? { template: opts.template.toLowerCase() } : {}),
          },
          opts,
          (_doc, created) =>
            `Proposed ${created[0]}: ${title}\nIt is waiting for human approval.\n`,
        );
      },
    );

  withAgent(program.command("batch"))
    .description(
      "propose many tasks at once from JSON (all-or-nothing); deps may name earlier titles",
    )
    .option("--file <path>", "read the JSON from a file instead of standard input")
    .addHelpText(
      "after",
      '\nJSON: {"groups":[{"id":"API","name":"API"}],"tasks":[{"title":"…","group":"API","desc":"…","acceptance":["…"],"deps":["CORE-01","<earlier title>"],"labels":["…"],"difficulty":"medium","template":"<template id>"}]}',
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
          `Proposed ${created.length} task(s):\n${created
            .map((id) => `  ${id.padEnd(9)} ${doc.tasks.find((t) => t.id === id)?.title}`)
            .join("\n")}\nThey are waiting for human approval.\n`,
      );
    });

  withAgent(program.command("edit"))
    .description("revise a proposal (approved tasks can only be changed by a human)")
    .argument("<id>")
    .option("--title <text>")
    .option("--desc <text>")
    .option("--criterion <text>", "replace the acceptance criteria; repeat for several", collect)
    .option("--labels <labels>", "replace labels (comma-separated)", list)
    .option("--group <id>", "move to another group (the id does not change)")
    .option("--difficulty <level>", "low, medium or high; none removes it", (v) =>
      difficulty(v, true),
    )
    .action(
      async (
        id: string,
        opts: {
          title?: string;
          desc?: string;
          criterion?: string[];
          labels?: string[];
          group?: string;
          difficulty?: Difficulty | "none";
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

  withAgent(program.command("withdraw"))
    .description("delete one of the proposals (only while it is still a proposal)")
    .argument("<id>")
    .action(async (id: string, opts: { as?: string; json?: boolean }) => {
      await apply(
        { op: "withdraw", task: id.toUpperCase() },
        opts,
        () => `Withdrew ${id.toUpperCase()}.\n`,
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
    .description("remove a dependency from a proposal")
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
    .description("finish a task you are doing (doing → review) with a summary for the reviewer")
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
        await apply({ op: "finish", task: id.toUpperCase(), summary }, opts, (doc) => {
          const state = doc.tasks.find((t) => t.id === id.toUpperCase())?.state;
          return state === "done"
            ? `Finished ${id.toUpperCase()}: done (part of a YOLO chain, no review needed).\n`
            : state === "doing"
              ? `Finished ${id.toUpperCase()}: Konsora now runs the checks. Stop here.\n`
              : `Finished ${id.toUpperCase()}: waiting for human review. Stop here.\n`;
        });
      },
    );
}
