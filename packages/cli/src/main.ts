/**
 * `konsora` command-line interface (CLI-01: init and read commands).
 * `main()` is pure with respect to its `io`, so tests run it in-process.
 */
import { execFileSync } from "node:child_process";
import { basename, relative, resolve } from "node:path";
import { GroupIdSchema, type TaskState, type TasksDocument } from "@konsora/core";
import { initTasks, readTasks, tasksPath } from "@konsora/core/store";
import { Command, CommanderError, Option } from "commander";
import {
  issuesText,
  STATES,
  showText,
  statusText,
  type TaskView,
  taskTable,
  views,
} from "./format.ts";
import { registerMigrate } from "./migrate.ts";
import { CliError, EXIT, type Io, json, load, locate, VERSION } from "./shared.ts";
import { registerWriteCommands } from "./write.ts";

export { EXIT, type Io } from "./shared.ts";

function gitBranch(cwd: string): string | undefined {
  try {
    const name = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return name && name !== "HEAD" ? name : undefined;
  } catch {
    return undefined;
  }
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const program = new Command("konsora")
    .description(
      "Konsora: plan, launch and review coding-agent tasks stored in .konsora/tasks.json",
    )
    .version(VERSION)
    .option(
      "--root <dir>",
      "project folder (default: nearest ancestor with .konsora/, or $KONSORA_ROOT)",
    )
    .showHelpAfterError("(run `konsora --help` for usage)")
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .exitOverride();
  const root = () => program.opts<{ root?: string }>().root;

  program
    .command("init")
    .description("create .konsora/tasks.json in the current folder (never overwrites)")
    .option("--name <name>", "project name (default: folder name)")
    .option("--group <id>", "id of the first group, 1–6 uppercase letters/digits", "TASK")
    .option("--group-name <name>", "name of the first group", "Tasks")
    .option(
      "--base-branch <branch>",
      "branch accepted work is merged into (default: current git branch, else main)",
    )
    .option("--json", "print the created plan as JSON")
    .action(
      async (opts: {
        name?: string;
        group: string;
        groupName: string;
        baseBranch?: string;
        json?: boolean;
      }) => {
        const target = resolve(io.cwd, root() ?? ".");
        if (!GroupIdSchema.safeParse(opts.group).success) {
          throw new CliError(
            `Invalid group id "${opts.group}".`,
            "Use 1–6 uppercase letters or digits starting with a letter, e.g. CORE.",
            EXIT.usage,
          );
        }
        const doc: TasksDocument = {
          schema: "konsora/2",
          project: {
            name: opts.name ?? basename(target),
            base_branch: opts.baseBranch ?? gitBranch(target) ?? "main",
          },
          groups: [{ id: opts.group, name: opts.groupName }],
          seq: { [opts.group]: 0 },
          tasks: [],
        };
        const result = await initTasks(target, doc);
        if (!result.ok) {
          if (result.error.code === "exists")
            throw new CliError(
              result.error.message,
              "Use `konsora status` to see the existing plan.",
            );
          if (result.error.code === "invalid") {
            throw new CliError(
              `Cannot create the plan:\n${issuesText(result.error.issues ?? []).trimEnd()}`,
              undefined,
              EXIT.usage,
            );
          }
          throw new CliError(result.error.message);
        }
        if (opts.json) json(io, result.document);
        else {
          io.stdout(
            `Created ${relative(io.cwd, tasksPath(target)) || tasksPath(target)} (project "${doc.project.name}", base branch ${doc.project.base_branch}, group ${opts.group}).\n` +
              "Next: ask an agent to propose tasks, or add them with `konsora propose` (coming in CLI-02).\n",
          );
        }
      },
    );

  program
    .command("status")
    .description("summary: counts per state, what needs you, what is ready")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      const { root: dir, doc } = await load(io, root());
      const list = views(doc);
      if (opts.json) {
        const byState = Object.fromEntries(
          STATES.map((s) => [s, list.filter((t) => t.state === s).length]),
        );
        json(io, {
          project: doc.project,
          tasks: list.length,
          byState,
          ready: list.filter((t) => t.ready).map((t) => t.id),
          blocked: list.filter((t) => t.blocked).map((t) => t.id),
          waiting: list.filter((t) => t.waiting).map((t) => t.id),
          review: list.filter((t) => t.state === "review").map((t) => t.id),
          proposed: list.filter((t) => t.state === "proposed").map((t) => t.id),
        });
      } else {
        io.stdout(statusText(doc, relative(io.cwd, tasksPath(dir)) || tasksPath(dir)));
      }
    });

  const listCommand = (name: string, description: string, preset: (t: TaskView) => boolean) =>
    program
      .command(name)
      .description(description)
      .addOption(new Option("--state <state>", "only this state").choices(STATES))
      .option("--group <id>", "only this group")
      .option("--ready", "only tasks ready to start")
      .option("--blocked", "only blocked tasks")
      .option("--waiting", "only tasks waiting for an answer")
      .option("--json", "machine-readable output")
      .action(
        async (opts: {
          state?: TaskState;
          group?: string;
          ready?: boolean;
          blocked?: boolean;
          waiting?: boolean;
          json?: boolean;
        }) => {
          const { doc } = await load(io, root());
          if (opts.group && !doc.groups.some((g) => g.id === opts.group)) {
            throw new CliError(
              `Unknown group "${opts.group}".`,
              `Groups: ${doc.groups.map((g) => g.id).join(", ")}.`,
              EXIT.usage,
            );
          }
          const list = views(doc).filter(
            (t) =>
              preset(t) &&
              (!opts.state || t.state === opts.state) &&
              (!opts.group || t.group === opts.group) &&
              (!opts.ready || t.ready) &&
              (!opts.blocked || t.blocked) &&
              (!opts.waiting || t.waiting),
          );
          if (opts.json) json(io, list);
          else io.stdout(taskTable(list));
        },
      );

  listCommand("list", "list tasks in dependency order", () => true);
  listCommand(
    "ready",
    "tasks an agent can start now (todo with every dependency done)",
    (t) => t.ready,
  );
  listCommand("blocked", "todo tasks waiting on unfinished dependencies", (t) => t.blocked);

  program
    .command("show")
    .description("details of one task: deps, criteria, notes")
    .argument("<id>", "task id, e.g. CORE-01")
    .option("--json", "machine-readable output")
    .action(async (id: string, opts: { json?: boolean }) => {
      const { doc } = await load(io, root());
      const view = views(doc).find((t) => t.id === id.toUpperCase());
      if (!view)
        throw new CliError(`Task ${id} does not exist.`, "Use `konsora list` to see task ids.");
      if (opts.json) json(io, view);
      else io.stdout(showText(doc, view));
    });

  program
    .command("check")
    .description("validate .konsora/tasks.json (exit code 1 if invalid)")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      const dir = locate(io, root());
      const result = await readTasks(dir);
      if (result.ok) {
        if (opts.json)
          json(io, { ok: true, tasks: result.document.tasks.length, hash: result.hash });
        else
          io.stdout(
            `OK · ${result.document.tasks.length} tasks in ${result.document.groups.length} groups · ${result.hash.slice(0, 19)}\n`,
          );
        return;
      }
      if (opts.json) json(io, { ok: false, error: result.error });
      else
        io.stderr(
          `Invalid plan (${tasksPath(dir)}):\n${issuesText(result.error.issues ?? [{ path: "", code: result.error.code, message: result.error.message }])}`,
        );
      throw new CliError("", undefined, EXIT.failure);
    });

  registerWriteCommands(program, io, root);
  registerMigrate(program, io, root);

  try {
    await program.parseAsync([...argv], { from: "user" });
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version" ||
        error.code === "commander.help"
      ) {
        return EXIT.ok;
      }
      return EXIT.usage;
    }
    if (error instanceof CliError) {
      if (error.message)
        io.stderr(`Error: ${error.message}\n${error.hint ? `Hint: ${error.hint}\n` : ""}`);
      return error.exitCode;
    }
    io.stderr(`Error: unexpected failure: ${(error as Error).stack ?? error}\n`);
    return EXIT.failure;
  }
}
