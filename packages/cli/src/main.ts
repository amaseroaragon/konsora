/**
 * `konsora` command-line interface (CLI-01: init and read commands).
 * `main()` is pure with respect to its `io`, so tests run it in-process.
 */
import { basename, relative, resolve } from "node:path";
import { GroupIdSchema, SCHEMA_VERSION, type TaskState, type TasksDocument } from "@konsora/core";
import { initTasks, tasksPath } from "@konsora/core/store";
import { Command, CommanderError, Option } from "commander";
import { registerArchive } from "./archive.ts";
import { codexHint, codexSnippet, describeCodex, installCodex } from "./codex.ts";
import { registerDoctor } from "./doctor.ts";
import { registerExport } from "./export.ts";
import {
  issuesText,
  logText,
  STATES,
  showText,
  statusText,
  type TaskView,
  taskTable,
} from "./format.ts";
import { describeHooks, installHooks, registerHook } from "./hooks.ts";
import { serveStdio } from "./mcp.ts";
import { CONFIG_TARGETS, type ConfigTarget, configHint, configSnippet } from "./mcp-config.ts";
import { registerMigrate } from "./migrate.ts";
import { registerPlan } from "./plan.ts";
import {
  checkData,
  LIST_PRESETS,
  listData,
  logData,
  parseLimit,
  showAnyData,
  statusData,
  statusSkill,
} from "./read.ts";
import { CliError, EXIT, type Io, json, load, locate, staleHours, VERSION } from "./shared.ts";
import {
  type Agent,
  collectAgent,
  describeInstall,
  installSkill,
  isOutdated,
  outdatedText,
  registerSkill,
} from "./skill.ts";
import { registerUi } from "./ui.ts";
import { parseDifficulty, registerWriteCommands } from "./write.ts";

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
      "--agent <name>",
      "agent to integrate: claude (default: .claude/skills/konsora and .mcp.json) or codex (AGENTS.md and .codex/config.toml); repeat for both",
      collectAgent,
    )
    .option("--no-claude", "do not install any agent integration")
    .option(
      "--hooks",
      "also add the Claude Code hooks to .claude/settings.json (plan status at session start, reminder at stop)",
    )
    .option("--json", "print the created plan as JSON")
    .action(
      async (opts: {
        name?: string;
        group: string;
        groupName: string;
        agent?: Agent[];
        claude: boolean;
        hooks?: boolean;
        json?: boolean;
      }) => {
        const target = resolve(io.cwd, root() ?? ".");
        if (opts.agent && !opts.claude)
          throw new CliError(
            "--agent and --no-claude contradict each other.",
            "Drop one of the two options.",
            EXIT.usage,
          );
        const agents: Agent[] = opts.agent ?? (opts.claude ? ["claude"] : []);
        if (opts.hooks && !agents.includes("claude"))
          throw new CliError(
            "--hooks are part of the Claude Code integration, which this init skips.",
            "Add --agent claude, or drop --hooks.",
            EXIT.usage,
          );
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
        const skill = agents.includes("claude")
          ? await installSkill(target).catch((error: Error) => {
              throw new CliError(
                `Created the plan, but could not install the Claude Code integration: ${error.message}`,
                "Fix it and run `konsora skill`.",
              );
            })
          : undefined;
        const hooks = opts.hooks
          ? await installHooks(target).catch((error: Error) => {
              throw new CliError(
                `Created the plan, but could not add the hooks: ${error.message}`,
                "Fix it and run `konsora skill --hooks`.",
              );
            })
          : undefined;
        const codex = agents.includes("codex")
          ? await installCodex(target).catch((error: Error) => {
              throw new CliError(
                `Created the plan, but could not install the Codex integration: ${error.message}`,
                "Fix it and run `konsora skill --agent codex`.",
              );
            })
          : undefined;
        if (opts.json) json(io, result.document);
        else {
          io.stdout(
            `Created ${relative(io.cwd, tasksPath(target)) || tasksPath(target)} (project "${doc.project.name}", group ${opts.group}).\n` +
              (skill ? describeInstall(skill) : "") +
              (hooks ? describeHooks(hooks) : "") +
              (codex ? describeCodex(codex) : "") +
              "Next: open the board with `konsora ui`, and ask Claude to plan with you (or use `konsora plan`): its tasks go straight to the board, ready to work on.\n",
          );
        }
      },
    );

  program
    .command("status")
    .description("summary: counts per state, what needs you, what is ready")
    .option(
      "--stale-after <hours>",
      "a task in progress with no activity for longer counts as abandoned (default: $KONSORA_STALE_AFTER or 24)",
    )
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean; staleAfter?: string }) => {
      const check = { now: io.now?.() ?? new Date(), hours: staleHours(io.env, opts.staleAfter) };
      const { root: dir, doc } = await load(io, root());
      const skill = await statusSkill(dir);
      if (opts.json) {
        json(io, statusData(doc, check, skill));
      } else {
        io.stdout(
          statusText(doc, relative(io.cwd, tasksPath(dir)) || tasksPath(dir), check) +
            (skill && isOutdated(skill) ? outdatedText(skill) : ""),
        );
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
      .option(
        "--difficulty <level>",
        "only tasks of this difficulty: low, medium, high, or none",
        (value: string) => parseDifficulty(value, true),
      )
      .option("--label <label>", "only tasks with this label")
      .option(
        "--search <text>",
        "only tasks whose id, title or description contain every word (ignoring case)",
      )
      .option("--json", "machine-readable output")
      .action(
        async (opts: {
          label?: string;
          search?: string;
          state?: TaskState;
          group?: string;
          ready?: boolean;
          blocked?: boolean;
          waiting?: boolean;
          difficulty?: string;
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
    "tasks an agent can start now (todo with every dependency done), in priority order",
    LIST_PRESETS.ready,
  );
  listCommand("blocked", "todo tasks waiting on unfinished dependencies", LIST_PRESETS.blocked);

  program
    .command("show")
    .description("details of one task: deps, criteria, notes")
    .argument("<id>", "task id, e.g. CORE-01")
    .option("--json", "machine-readable output")
    .action(async (id: string, opts: { json?: boolean }) => {
      const { root: dir, doc } = await load(io, root());
      const view = await showAnyData(dir, doc, id);
      if (opts.json) json(io, view);
      else io.stdout(showText(doc, view));
    });

  program
    .command("log")
    .description("finished tasks, newest first: when, who closed it and its summary's first line")
    .option("--since <date>", "only tasks finished on or after this date (e.g. 2026-11-01)")
    .option("--limit <n>", "at most this many, the most recent", parseLimit)
    .option("--json", "machine-readable output (core's completionLog entries)")
    .action(async (opts: { since?: string; limit?: number; json?: boolean }) => {
      const { root: dir, doc } = await load(io, root());
      const entries = await logData(dir, doc, opts);
      if (opts.json) json(io, entries);
      else io.stdout(logText(entries));
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
        const codex = opts.printConfig === "codex";
        io.stdout(codex ? codexSnippet(dir) : configSnippet(opts.printConfig, dir));
        io.stderr(codex ? codexHint() : configHint(opts.printConfig));
        return;
      }
      await serveStdio(io, root());
    });

  registerWriteCommands(program, io, root);
  registerMigrate(program, io, root);
  registerArchive(program, io, root);
  registerPlan(program, io, root);
  registerSkill(program, io, root);
  registerUi(program, io, root);
  registerHook(program, io, root);
  registerDoctor(program, io, root);
  registerExport(program, io, root);

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
