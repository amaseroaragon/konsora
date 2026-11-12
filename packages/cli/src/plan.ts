/**
 * `konsora plan` (CLI-05): planning by interview. It opens an interactive session of the user's
 * own Claude Code in the terminal, not a chat of Konsora's, with the
 * interview prompt from core and only Konsora's MCP server, in plan mode (KONSORA_PLAN=1): the
 * agent reads the plan and the code and can only create, revise or delete unstarted tasks and
 * set up blocks; it starts nothing.
 *
 * Konsora passes no permission-bypassing flag (never `--dangerously-*`): the agent asks the
 * user for whatever its own permission settings require.
 */
import { spawn } from "node:child_process";
import { buildPlanPrompt, PLAN_TOOLS } from "@konsora/core";
import type { Command } from "commander";
import { serverCommand } from "./mcp-config.ts";
import { CliError, EXIT, type Io, load } from "./shared.ts";

export type PlanCommand = { command: "claude"; args: string[] };

/** The agent CLI and its arguments for a planning session on the project at `root`. */
export function planCommand(root: string, prompt: string, model?: string): PlanCommand {
  const base = serverCommand(root);
  const server = { ...base, env: { ...base.env, KONSORA_PLAN: "1" } };
  const config = { mcpServers: { konsora: { type: "stdio", ...server } } };
  return {
    command: "claude",
    args: [
      ...(model ? ["--model", model] : []),
      // Only this server: a konsora server of the user's own config would not be in plan mode.
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify(config),
      // One argument with `=`: `--allowedTools` takes several values, and as two arguments
      // it would swallow the prompt that follows (the session would open without it).
      `--allowedTools=${PLAN_TOOLS.join(",")}`,
      prompt,
    ],
  };
}

/** Runs the agent CLI attached to this terminal and resolves with its exit code. */
function runInteractive(io: Io, cwd: string, { command, args }: PlanCommand): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: io.env, stdio: "inherit" });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new CliError(
            `${command} is not installed or not on PATH.`,
            "Install Claude Code and log in with it, then run `konsora plan` again.",
          ),
        );
      } else reject(new CliError(`Could not start ${command}: ${error.message}`));
    });
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

export function registerPlan(program: Command, io: Io, rootOption: () => string | undefined) {
  program
    .command("plan")
    .description(
      "plan by interview: open your agent CLI with an interview prompt; it ends by proposing tasks",
    )
    .argument("[goal]", "what you want to plan, to start the interview from")
    .option("--model <id>", "model for the session (default: Claude Code's own)")
    .action(async (goal: string | undefined, opts: { model?: string }) => {
      const { root, doc } = await load(io, rootOption());
      const prompt = buildPlanPrompt(doc, goal ? { goal } : {});
      io.stderr(
        "Starting a planning session with Claude Code. It can only plan: create, revise or delete unstarted tasks and set up blocks.\n",
      );
      const code = await runInteractive(io, root, planCommand(root, prompt, opts.model));
      if (code !== 0)
        throw new CliError(`claude exited with code ${code}.`, undefined, EXIT.failure);
    });
}
