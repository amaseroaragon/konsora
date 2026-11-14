/**
 * How agent sessions reach this project's Konsora MCP server.
 *
 * - `konsora init` (or `konsora skill`) adds a `konsora` entry to the project's `.mcp.json` that
 *   runs the global `konsora mcp` (installed with `npm run install:global`), so the file can be
 *   committed and works from any checkout. It never touches other entries, and never writes the
 *   user's own configuration (~/.claude).
 * - `konsora mcp --print-config claude` (or `codex`, as TOML, see codex.ts) only prints a snippet
 *   with absolute paths to this checkout's `bin.ts`, for a session without the global command.
 * - `konsora plan` and the UI's AI panel start the server with the absolute command too.
 */
import { constants } from "node:fs";
import { open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CONFIG_TARGETS = ["claude", "codex"] as const;
export type ConfigTarget = (typeof CONFIG_TARGETS)[number];

export type ServerCommand = { command: string; args: string[]; env: Record<string, string> };

/** This checkout's server, run by the Node running this command (works without a global PATH). */
export function serverCommand(root: string): ServerCommand {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL("./bin.ts", import.meta.url)), "mcp", "--root", root],
    env: { KONSORA_AGENT: "claude" },
  };
}

/** The portable entry for a project's `.mcp.json`: the global command, from the project folder. */
export const PROJECT_SERVER = {
  type: "stdio",
  command: "konsora",
  args: ["mcp"],
  env: { KONSORA_AGENT: "claude" },
} as const;

export function configSnippet(_target: ConfigTarget, root: string): string {
  return `${JSON.stringify({ mcpServers: { konsora: { type: "stdio", ...serverCommand(root) } } }, null, 2)}\n`;
}

/** Where to paste it; printed on stderr so stdout stays a clean snippet. */
export function configHint(_target: ConfigTarget): string {
  return "Paste this into .mcp.json at the project root (or merge its mcpServers entry), then restart Claude Code and approve the konsora server. With the global command installed, `konsora skill` adds a portable entry for you.\n";
}

export const MCP_JSON = ".mcp.json";

export type McpJsonInstall = "created" | "added" | "present";

/**
 * Adds the `konsora` server to the project's `.mcp.json`: creates the file if missing, adds the
 * entry if absent and leaves the file alone if it already has one. Refuses a file that is not a
 * JSON object, so a hand-written config is never overwritten. Writes atomically.
 */
export async function installMcpJson(root: string): Promise<McpJsonInstall> {
  const path = join(root, MCP_JSON);
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  let config: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
  if (text !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${MCP_JSON} is not valid JSON; add the konsora server by hand`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error(`${MCP_JSON} is not a JSON object; add the konsora server by hand`);
    config = parsed as typeof config;
    const servers = config.mcpServers;
    if (servers !== undefined && (typeof servers !== "object" || Array.isArray(servers)))
      throw new Error(`${MCP_JSON} has an invalid mcpServers; add the konsora server by hand`);
    if (servers && "konsora" in servers) return "present";
  }
  config.mcpServers = { ...(config.mcpServers ?? {}), konsora: PROJECT_SERVER };
  const temp = `${path}.konsora-${process.pid}.tmp`;
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
  try {
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  return text === undefined ? "created" : "added";
}
