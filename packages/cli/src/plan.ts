/**
 * `konsora plan` (CLI-05): planning by interview. It opens an interactive session of the user's
 * own agent CLI (Claude Code or Codex) in the terminal, not a chat of Konsora's, with the
 * interview prompt from core and only Konsora's MCP server, in plan mode (KONSORA_PLAN=1): the
 * agent reads the plan and the code and can only propose tasks or revise its proposals. What
 * comes out are proposals the human approves or not.
 *
 * Konsora passes no permission-bypassing flag (never `--dangerously-*`): the agent asks the
 * user for whatever its own permission settings require.
 */
import { spawn } from "node:child_process";
import { buildPlanPrompt } from "@konsora/core";
import { type Command, Option } from "commander";
import { CONFIG_TARGETS, type ConfigTarget, serverCommand } from "./mcp-config.ts";
import { CliError, EXIT, type Io, load } from "./shared.ts";

/** Konsora's MCP tools the planning agent may call without asking (core still limits them). */
const PLAN_TOOLS = [
  "status",
  "list",
  "ready",
  "blocked",
  "show",
  "check",
  "propose",
  "batch",
  "edit",
  "withdraw",
].map((tool) => `mcp__konsora__${tool}`);

const toml = (value: string | readonly string[] | Record<string, string>): string => {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
  const entries = Object.entries(value as Record<string, string>).map(
    ([key, v]) => `${JSON.stringify(key)} = ${JSON.stringify(v)}`,
  );
  return `{ ${entries.join(", ")} }`;
};

export type PlanCommand = { command: ConfigTarget; args: string[] };

/** The agent CLI and its arguments for a planning session on the project at `root`. */
export function planCommand(
  agent: ConfigTarget,
  root: string,
  prompt: string,
  model?: string,
): PlanCommand {
  const base = serverCommand(root, agent);
  const server = { ...base, env: { ...base.env, KONSORA_PLAN: "1" } };
  if (agent === "claude") {
    const config = { mcpServers: { konsora: { type: "stdio", ...server } } };
    return {
      command: "claude",
      args: [
        ...(model ? ["--model", model] : []),
        // Only this server: a konsora server of the user's own config would not be in plan mode.
        "--strict-mcp-config",
        "--mcp-config",
        JSON.stringify(config),
        "--allowedTools",
        PLAN_TOOLS.join(","),
        prompt,
      ],
    };
  }
  return {
    command: "codex",
    args: [
      ...(model ? ["-m", model] : []),
      // Replaces any konsora server of the user's config with this one, in plan mode.
      "-c",
      `mcp_servers.konsora.command=${toml(server.command)}`,
      "-c",
      `mcp_servers.konsora.args=${toml(server.args)}`,
      "-c",
      `mcp_servers.konsora.env=${toml(server.env)}`,
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
            `Install it and log in with its own CLI, or choose the other agent with --agent ${command === "claude" ? "codex" : "claude"}.`,
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
    .addOption(
      new Option("--agent <agent>", "the agent CLI to open")
        .choices(CONFIG_TARGETS)
        .default("claude"),
    )
    .option("--model <id>", "model for the session (default: the agent CLI's own)")
    .action(async (goal: string | undefined, opts: { agent: ConfigTarget; model?: string }) => {
      const { root, doc } = await load(io, rootOption());
      const prompt = buildPlanPrompt(doc, goal ? { goal } : {});
      io.stderr(
        `Starting a planning session with ${opts.agent}. It can only propose tasks; approve them in Konsora.\n`,
      );
      const code = await runInteractive(
        io,
        root,
        planCommand(opts.agent, root, prompt, opts.model),
      );
      if (code !== 0)
        throw new CliError(`${opts.agent} exited with code ${code}.`, undefined, EXIT.failure);
    });
}
