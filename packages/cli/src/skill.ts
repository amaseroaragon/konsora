/**
 * Installs the agent protocol skill (CLI-04). Never overwrites: the skill file is created only if
 * missing, and the AGENTS.md section is appended only when asked and only once (marker comment).
 */
import { constants } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { CliError, type Io, json, locate } from "./shared.ts";

export const SKILL_PATH = join(".claude", "skills", "konsora", "SKILL.md");
const MARKER = "<!-- konsora:protocol -->";

export const AGENTS_SNIPPET = `
${MARKER}
## Konsora

This project's plan lives in \`.konsora/tasks.json\`. Follow the Konsora protocol in \`${SKILL_PATH}\`: read and change the plan only with the \`konsora\` command (never edit the file by hand), pass \`--as <your-name>\` on writes, and remember that agents propose, start, note, ask and finish while only the human approves and accepts.
`;

export function skillText(): Promise<string> {
  return readFile(new URL("../assets/SKILL.md", import.meta.url), "utf8");
}

export type SkillInstall = { skill: "created" | "exists"; agentsMd?: "appended" | "present" };

export async function installSkill(
  root: string,
  options: { agentsMd?: boolean } = {},
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
  if (options.agentsMd) {
    const path = join(root, "AGENTS.md");
    const current = await readFile(path, "utf8").catch(() => "");
    if (current.includes(MARKER)) result.agentsMd = "present";
    else {
      const handle = await open(path, "a");
      try {
        await handle.writeFile(
          `${current && !current.endsWith("\n") ? "\n" : ""}${AGENTS_SNIPPET}`,
          "utf8",
        );
      } finally {
        await handle.close();
      }
      result.agentsMd = "appended";
    }
  }
  return result;
}

export function describeInstall(result: SkillInstall): string {
  const lines = [
    result.skill === "created"
      ? `Installed the agent protocol skill at ${SKILL_PATH}.`
      : `${SKILL_PATH} already exists; left it unchanged.`,
  ];
  if (result.agentsMd === "appended")
    lines.push("Appended the Konsora section to AGENTS.md (for Codex and other agents).");
  if (result.agentsMd === "present") lines.push("AGENTS.md already has the Konsora section.");
  if (!result.agentsMd)
    lines.push("Codex reads AGENTS.md: add the protocol there with `konsora skill --agents-md`.");
  return `${lines.join("\n")}\n`;
}

export function registerSkill(program: Command, io: Io, rootOption: () => string | undefined) {
  program
    .command("skill")
    .description("install the agent protocol skill in this project (never overwrites)")
    .option("--agents-md", "also append a short Konsora section to AGENTS.md (once)")
    .option("--json", "machine-readable output")
    .action(async (opts: { agentsMd?: boolean; json?: boolean }) => {
      const root = locate(io, rootOption());
      const result = await installSkill(root, { agentsMd: Boolean(opts.agentsMd) }).catch(
        (error: Error) => {
          throw new CliError(`Could not install the skill: ${error.message}`);
        },
      );
      if (opts.json) json(io, result);
      else io.stdout(describeInstall(result));
    });
}
