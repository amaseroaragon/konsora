/**
 * Installs the Claude Code integration in a project (CLI-04): the agent protocol skill at
 * `.claude/skills/konsora/SKILL.md` and the `konsora` server in `.mcp.json`. Never overwrites:
 * the skill file is created only if missing, and `.mcp.json` only gains the `konsora` entry.
 */
import { constants } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { installMcpJson, MCP_JSON, type McpJsonInstall } from "./mcp-config.ts";
import { CliError, type Io, json, locate } from "./shared.ts";

export const SKILL_PATH = join(".claude", "skills", "konsora", "SKILL.md");

export function skillText(): Promise<string> {
  return readFile(new URL("../assets/SKILL.md", import.meta.url), "utf8");
}

export type SkillInstall = { skill: "created" | "exists"; mcp?: McpJsonInstall };

export async function installSkill(
  root: string,
  options: { mcp?: boolean } = {},
): Promise<SkillInstall> {
  const target = join(root, SKILL_PATH);
  await mkdir(join(root, ".claude", "skills", "konsora"), { recursive: true });
  let skill: SkillInstall["skill"] = "created";
  try {
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o644,
    );
    try {
      await handle.writeFile(await skillText(), "utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    skill = "exists";
  }
  const result: SkillInstall = { skill };
  if (options.mcp !== false) result.mcp = await installMcpJson(root);
  return result;
}

export function describeInstall(result: SkillInstall): string {
  const lines = [
    result.skill === "created"
      ? `Installed the agent protocol skill at ${SKILL_PATH}.`
      : `${SKILL_PATH} already exists; left it unchanged.`,
  ];
  if (result.mcp === "created")
    lines.push(`Created ${MCP_JSON} with the konsora MCP server (it runs \`konsora mcp\`).`);
  if (result.mcp === "added") lines.push(`Added the konsora MCP server to ${MCP_JSON}.`);
  if (result.mcp === "present") lines.push(`${MCP_JSON} already has a konsora server.`);
  if (result.mcp) lines.push("Restart Claude Code in this folder and approve the konsora server.");
  return `${lines.join("\n")}\n`;
}

export function registerSkill(program: Command, io: Io, rootOption: () => string | undefined) {
  program
    .command("skill")
    .description(
      "install the Claude Code integration: the protocol skill and the MCP server in .mcp.json (never overwrites)",
    )
    .option("--no-mcp", "only the skill, without touching .mcp.json")
    .option("--json", "machine-readable output")
    .action(async (opts: { mcp: boolean; json?: boolean }) => {
      const root = locate(io, rootOption());
      const result = await installSkill(root, { mcp: opts.mcp }).catch((error: Error) => {
        throw new CliError(`Could not install the integration: ${error.message}`);
      });
      if (opts.json) json(io, result);
      else io.stdout(describeInstall(result));
    });
}
