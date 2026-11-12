/**
 * `konsora` command-line interface (CLI-01: init and read commands).
 * `main()` is pure with respect to its `io`, so tests run it in-process.
 */
import { basename, relative, resolve } from "node:path";
import { GroupIdSchema, SCHEMA_VERSION, type TaskState, type TasksDocument } from "@konsora/core";
import { initTasks, tasksPath } from "@konsora/core/store";
import { Command, CommanderError, Option } from "commander";
import { issuesText, STATES, showText, statusText, type TaskView, taskTable } from "./format.ts";
import { serveStdio } from "./mcp.ts";
import { CONFIG_TARGETS, type ConfigTarget, configHint, configSnippet } from "./mcp-config.ts";
import { registerMigrate } from "./migrate.ts";
import { registerPlan } from "./plan.ts";
import { checkData, LIST_PRESETS, listData, showData, statusData } from "./read.ts";
import { CliError, EXIT, type Io, json, load, locate, VERSION } from "./shared.ts";
import { describeInstall, installSkill, registerSkill } from "./skill.ts";
import { registerUi } from "./ui.ts";
import { registerWriteCommands } from "./write.ts";

export { EXIT, type Io } from "./shared.ts";

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const program = new Command("konsora")
    .description(
      "Konsora: a task board for coding agents, stored in .konsora/tasks.json and shown in `konsora ui`",
    )
    .version(VERSION)
    .option(
      "--root <dir>",
      "project folder (default: $KONSORA_ROOT, or nearest ancestor with .konsora/)",
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
      "--no-claude",
      "do not install the Claude Code integration (.claude/skills/konsora and .mcp.json)",
    )
    .option("--json", "print the created plan as JSON")
    .action(
      async (opts: {
        name?: string;
        group: string;
        groupName: string;
        claude: boolean;
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
          schema: SCHEMA_VERSION,
          project: { name: opts.name ?? basename(target) },
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
        const skill = opts.claude
          ? await installSkill(target).catch((error: Error) => {
              throw new CliError(
                `Created the plan, but could not install the Claude Code integration: ${error.message}`,
                "Fix it and run `konsora skill`.",
              );
            })
          : undefined;
        if (opts.json) json(io, result.document);
        else {
          io.stdout(
            `Created ${relative(io.cwd, tasksPath(target)) || tasksPath(target)} (project "${doc.project.name}", group ${opts.group}).\n` +
              (skill ? describeInstall(skill) : "") +
              "Next: open the board with `konsora ui`, and ask Claude to plan with you (or use `konsora plan`): its tasks go straight to the board, ready to work on.\n",
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
      if (opts.json) {
        json(io, statusData(doc));
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
          const list = listData(doc, opts, preset);
          if (opts.json) json(io, list);
          else io.stdout(taskTable(list));
        },
      );

  listCommand("list", "list tasks in dependency order", LIST_PRESETS.list);
  listCommand(
    "ready",
    "tasks an agent can start now (todo with every dependency done)",
    LIST_PRESETS.ready,
  );
  listCommand("blocked", "todo tasks waiting on unfinished dependencies", LIST_PRESETS.blocked);

  program
    .command("show")
    .description("details of one task: deps, criteria, notes")
    .argument("<id>", "task id, e.g. CORE-01")
    .option("--json", "machine-readable output")
    .action(async (id: string, opts: { json?: boolean }) => {
      const { doc } = await load(io, root());
      const view = showData(doc, id);
      if (opts.json) json(io, view);
      else io.stdout(showText(doc, view));
    });

  program
    .command("check")
    .description("validate .konsora/tasks.json (exit code 1 if invalid)")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      const dir = locate(io, root());
      const result = await checkData(dir);
      if (opts.json) json(io, result);
      else if (result.ok)
        io.stdout(
          `OK · ${result.tasks} tasks in ${result.groups} groups · ${result.hash.slice(0, 19)}\n`,
        );
      else
        io.stderr(
          `Invalid plan (${tasksPath(dir)}):\n${issuesText(result.error.issues ?? [{ path: "", code: result.error.code, message: result.error.message }])}`,
        );
      if (!result.ok) throw new CliError("", undefined, EXIT.failure);
    });

  program
    .command("mcp")
    .description("run the Konsora MCP server over stdio (read and agent tools, for agent sessions)")
    .addOption(
      new Option(
        "--print-config <agent>",
        "print the snippet that connects this project's server to an agent (writes nothing)",
      ).choices(CONFIG_TARGETS),
    )
    .action(async (opts: { printConfig?: ConfigTarget }) => {
      if (opts.printConfig) {
        const dir = locate(io, root());
        io.stdout(configSnippet(opts.printConfig, dir));
        io.stderr(configHint(opts.printConfig));
        return;
      }
      await serveStdio(io, root());
    });

  registerWriteCommands(program, io, root);
  registerMigrate(program, io, root);
  registerPlan(program, io, root);
  registerSkill(program, io, root);
  registerUi(program, io, root);

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
