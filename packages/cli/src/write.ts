/**
 * Agent write commands (CLI-02). Every command is one semantic op from @konsora/core applied
 * through the store (lock + validation + canonical atomic write).
 *
 * The CLI always acts as an agent: `--as` / KONSORA_AGENT name it (`agent:<name>`), and "human"
 * or "konsora" are refused. Human actions (reopen, answer, changing finished work, deleting
 * started work, deleting or merging blocks) are deliberately absent: they happen in the UI.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DEFAULT_BASE_BRANCH,
  type Op,
  type OpContext,
  type OpError,
  type TasksDocument,
  taskHash,
} from "@konsora/core";
import { mutate } from "@konsora/core/store";
import type { Command } from "commander";
import { z } from "zod";
import { branchHint, showText, views } from "./format.ts";
import { HINTS, opHint } from "./hints.ts";
import {
  CliError,
  defaultBase,
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

const BlockInput = z.strictObject({
  id: z.string().min(1).describe("block id: lowercase letters, digits and dashes"),
  name: z.string().min(1),
  branch: z.string().min(1).optional().describe("git branch (default konsora/<id>)"),
  base: z.string().min(1).optional().describe("branch it merges into (default: current branch)"),
});

export const BatchSchema = z.strictObject({
  groups: z.array(z.strictObject({ id: z.string(), name: z.string() })).optional(),
  blocks: z
    .array(BlockInput)
    .optional()
    .describe(
      "blocks to create: dependent tasks worked on one branch, merged by the human at the end",
    ),
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
        block: z.string().min(1).optional().describe("block id (existing or in blocks)"),
        idea: z
          .boolean()
          .optional()
          .describe("true creates it as an idea (proposed) instead of in todo"),
      }),
    )
    .min(1),
});

/** Turns the batch JSON (CLI stdin/file or MCP argument) into a `batch` op; `base` fills blocks without one. */
export function batchOp(value: unknown, base: string = DEFAULT_BASE_BRANCH): Op {
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
    ...(batch.blocks
      ? {
          blocks: batch.blocks.map((b) => ({
            id: b.id.toLowerCase(),
            name: b.name,
            base: b.base ?? base,
            ...(b.branch ? { branch: b.branch } : {}),
          })),
        }
      : {}),
    tasks: batch.tasks.map((t) => ({
      title: t.title,
      group: t.group,
      ...(t.desc ? { desc: t.desc } : {}),
      ...(t.acceptance ? { acceptance: t.acceptance } : {}),
      ...(t.deps ? { deps: t.deps } : {}),
      ...(t.labels ? { labels: t.labels } : {}),
      ...(t.template ? { template: t.template.toLowerCase() } : {}),
      ...(t.block ? { block: t.block.toLowerCase() } : {}),
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
    .option("--block <id>", "put it in a block (see `konsora status`)")
    .option("--idea", "create it as an idea (proposed) instead of todo")
    .action(
      async (
        title: string,
        opts: {
          block?: string;
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
            ...(opts.block ? { block: opts.block.toLowerCase() } : {}),
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
      "create many tasks (in todo, or as ideas with idea: true) and blocks at once from JSON, all-or-nothing; deps may name earlier titles",
    )
    .option("--file <path>", "read the JSON from a file instead of standard input")
    .addHelpText(
      "after",
      '\nJSON: {"groups":[{"id":"API","name":"API"}],"blocks":[{"id":"cache","name":"Forecast cache"}],"tasks":[{"title":"…","group":"API","desc":"…","acceptance":["…"],"deps":["CORE-01","<earlier title>"],"labels":["…"],"template":"<template id>","block":"cache"},{"title":"…","group":"API","idea":true}]}\nA task with "idea": true is created as an idea (proposed); the rest go to todo.\nA block without branch uses konsora/<id>; without base, the current git branch.',
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
        batchOp(value, defaultBase(locate(io, rootOption()))),
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

  withAgent(program.command("add-block"))
    .description("create a block: dependent tasks worked on one git branch, merged at the end")
    .argument("<id>", "block id: lowercase letters, digits and dashes")
    .requiredOption("--name <name>", "what the block delivers")
    .option("--branch <branch>", "git branch (default konsora/<id>)")
    .option("--base <branch>", "branch it merges into (default: the current branch)")
    .action(
      async (
        id: string,
        opts: { name: string; branch?: string; base?: string; as?: string; json?: boolean },
      ) => {
        const base = opts.base ?? defaultBase(locate(io, rootOption()));
        await apply(
          {
            op: "add-block",
            id: id.toLowerCase(),
            name: opts.name,
            base,
            ...(opts.branch ? { branch: opts.branch } : {}),
          },
          opts,
          (doc) => {
            const block = doc.blocks?.find((b) => b.id === id.toLowerCase());
            return `Created block ${id.toLowerCase()} (branch ${block?.branch} → ${block?.base}).\nAdd tasks with \`konsora set-block <task> ${id.toLowerCase()}\` or \`propose --block\`.\n`;
          },
        );
      },
    );

  withAgent(program.command("edit-block"))
    .description("rename a block or change its branch or base (until it is merged)")
    .argument("<id>")
    .option("--name <name>")
    .option("--branch <branch>")
    .option("--base <branch>")
    .action(
      async (
        id: string,
        opts: { name?: string; branch?: string; base?: string; as?: string; json?: boolean },
      ) => {
        const changes = {
          ...(opts.name ? { name: opts.name } : {}),
          ...(opts.branch ? { branch: opts.branch } : {}),
          ...(opts.base ? { base: opts.base } : {}),
        };
        if (Object.keys(changes).length === 0)
          throw new CliError("Nothing to change.", "Pass --name, --branch or --base.", EXIT.usage);
        await apply(
          { op: "edit-block", block: id.toLowerCase(), changes },
          opts,
          () => `Updated block ${id.toLowerCase()}.\n`,
        );
      },
    );

  withAgent(program.command("set-block"))
    .description("put a task in a block, or take it out with `none`")
    .argument("<task>")
    .argument("<block>", "block id, or none")
    .action(async (task: string, block: string, opts: { as?: string; json?: boolean }) => {
      const target = block.toLowerCase() === "none" ? null : block.toLowerCase();
      await apply({ op: "set-block", task: task.toUpperCase(), block: target }, opts, () =>
        target
          ? `${task.toUpperCase()} is now in block ${target}.\n`
          : `${task.toUpperCase()} is no longer in a block.\n`,
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
        (doc) => {
          const hint = branchHint(doc, id.toUpperCase());
          return `Started ${id.toUpperCase()} (doing).\n${hint ? `${hint}\n` : ""}\n${showText(doc, views(doc).find((t) => t.id === id.toUpperCase()) as never)}`;
        },
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
        await apply({ op: "finish", task: id.toUpperCase(), summary }, opts, (doc) => {
          const hint = branchHint(doc, id.toUpperCase());
          return `Finished ${id.toUpperCase()}: done.\n${hint ? `Make sure your work is committed on that branch. ${hint}\n` : ""}`;
        });
      },
    );
}
