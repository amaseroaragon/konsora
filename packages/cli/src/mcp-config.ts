/**
 * `konsora mcp --print-config claude|codex` (MCP-05): the snippet that connects a manual agent
 * session to this project's Konsora MCP server. It only prints: Konsora never writes the
 * user's agent configuration (~/.claude, ~/.codex) nor the project's (.mcp.json, .codex/).
 *
 * The server is this checkout's `bin.ts`, run by the Node that runs this command (absolute
 * paths, so it works even when the agent's PATH has no Node ≥ 22.18), with `--root` set to the
 * project and KONSORA_AGENT set to the agent for attribution.
 */
import { fileURLToPath } from "node:url";

export const CONFIG_TARGETS = ["claude", "codex"] as const;
export type ConfigTarget = (typeof CONFIG_TARGETS)[number];

export type ServerCommand = { command: string; args: string[]; env: Record<string, string> };

export function serverCommand(root: string, agent: ConfigTarget): ServerCommand {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL("./bin.ts", import.meta.url)), "mcp", "--root", root],
    env: { KONSORA_AGENT: agent },
  };
}

/** A TOML basic string: JSON's escapes (\" \\ \n \uXXXX…) are all valid TOML. */
const tomlString = (value: string) => JSON.stringify(value);

export function configSnippet(target: ConfigTarget, root: string): string {
  const server = serverCommand(root, target);
  if (target === "claude") {
    return `${JSON.stringify({ mcpServers: { konsora: { type: "stdio", ...server } } }, null, 2)}\n`;
  }
  const env = Object.entries(server.env)
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join(", ");
  return [
    "[mcp_servers.konsora]",
    `command = ${tomlString(server.command)}`,
    `args = [${server.args.map(tomlString).join(", ")}]`,
    `env = { ${env} }`,
    "",
  ].join("\n");
}

/** Where to paste it; printed on stderr so stdout stays a clean snippet. */
export function configHint(target: ConfigTarget): string {
  return target === "claude"
    ? "Paste this into .mcp.json at the project root (or merge its mcpServers entry), then restart Claude Code and approve the konsora server.\n"
    : "Paste this into ~/.codex/config.toml (or the project's .codex/config.toml if your Codex supports it), then restart Codex.\n";
}
