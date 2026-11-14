/**
 * Installs the Claude Code integration in a project (CLI-04): the agent protocol skill at
 * `.claude/skills/konsora/SKILL.md` and the `konsora` server in `.mcp.json`. Never overwrites:
 * the skill file is created only if missing, and `.mcp.json` only gains the `konsora` entry.
 *
 * The skill carries its protocol version (CLI-03, `<!-- konsora-skill-version: N -->`), and
 * `assets/skill-releases.json` records the sha256 of every published SKILL.md with its version
 * (0 for those from before the marker). An installed skill whose hash is there was not edited by
 * hand, so `konsora skill --update` may replace it; any other needs `--force`.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { type CodexInstall, describeCodex, installCodex } from "./codex.ts";
import { describeHooks, type HooksInstall, installHooks } from "./hooks.ts";
import { installMcpJson, MCP_JSON, type McpJsonInstall } from "./mcp-config.ts";
import { CliError, EXIT, type Io, json, locate } from "./shared.ts";

export const SKILL_PATH = join(".claude", "skills", "konsora", "SKILL.md");

export function skillText(): Promise<string> {
  return readFile(new URL("../assets/SKILL.md", import.meta.url), "utf8");
}

type SkillReleases = { current: number; known: Record<string, number> };

let releases: Promise<SkillReleases> | undefined;
function skillReleases(): Promise<SkillReleases> {
  releases ??= readFile(new URL("../assets/skill-releases.json", import.meta.url), "utf8").then(
    (text) => JSON.parse(text) as SkillReleases,
  );
  return releases;
}

const MARKER = /^<!-- konsora-skill-version: (\d+) -->$/m;

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The installed skill against the one of this checkout; absent when there is none. */
export type SkillState = {
  /** Its protocol version: its marker, else the release its hash matches, else 0. */
  installed: number;
  current: number;
  /** Its content is no published release: someone edited it by hand. */
  modified: boolean;
};

export async function skillState(root: string): Promise<SkillState | undefined> {
  const text = await readFile(join(root, SKILL_PATH), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (text === undefined) return undefined;
  const { current, known } = await skillReleases();
  const release = known[sha256(text)];
  const marker = text.match(MARKER)?.[1];
  return {
    installed: marker !== undefined ? Number(marker) : (release ?? 0),
    current,
    modified: release === undefined,
  };
}

export const isOutdated = (state: SkillState | undefined) =>
  state !== undefined && state.installed < state.current;

/** The status line about an outdated skill, with its hint (`konsora status`). */
export function outdatedText(state: SkillState): string {
  return (
    `\nThe agent protocol skill at ${SKILL_PATH} is older than this Konsora (v${state.installed}, current v${state.current}): agents follow an outdated protocol.\n` +
    (state.modified
      ? "Hint: it was edited by hand; review your changes, then replace it with `konsora skill --update --force`.\n"
      : "Hint: replace it with `konsora skill --update`.\n")
  );
}

export type SkillInstall = {
  skill: "created" | "exists" | "updated" | "current";
  mcp?: McpJsonInstall;
  /** With `exists`: the installed skill is older than this checkout's (CLI-03). */
  outdated?: true;
};

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
  if (skill === "exists" && isOutdated(await skillState(root))) result.outdated = true;
  if (options.mcp !== false) result.mcp = await installMcpJson(root);
  return result;
}

/**
 * `konsora skill --update` (CLI-03): replaces the installed skill with this checkout's when it is
 * a published release (or with `force`), and installs it when missing. The write is atomic.
 */
export async function updateSkill(
  root: string,
  options: { mcp?: boolean; force?: boolean } = {},
): Promise<SkillInstall> {
  const state = await skillState(root);
  if (!state) return installSkill(root, options);
  let skill: SkillInstall["skill"] = "current";
  if (state.modified && !options.force)
    throw new CliError(
      `${SKILL_PATH} was edited by hand (v${state.installed}, current v${state.current}); left it unchanged.`,
      "Review your changes (they would be lost), then run `konsora skill --update --force` to replace it.",
    );
  if (state.modified || state.installed < state.current) {
    const target = join(root, SKILL_PATH);
    const temp = `${target}.${process.pid}.tmp`;
    try {
      await writeFile(temp, await skillText(), { encoding: "utf8", mode: 0o644 });
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
    skill = "updated";
  }
  const result: SkillInstall = { skill };
  if (options.mcp !== false) result.mcp = await installMcpJson(root);
  return result;
}

export function describeInstall(result: SkillInstall): string {
  const lines = [
    {
      created: `Installed the agent protocol skill at ${SKILL_PATH}.`,
      exists: result.outdated
        ? `${SKILL_PATH} already exists and is older than this Konsora; left it unchanged (replace it with \`konsora skill --update\`).`
        : `${SKILL_PATH} already exists; left it unchanged.`,
      updated: `Updated the agent protocol skill at ${SKILL_PATH} to the current protocol.`,
      current: `${SKILL_PATH} is already the current protocol; left it unchanged.`,
    }[result.skill],
  ];
  if (result.mcp === "created")
    lines.push(`Created ${MCP_JSON} with the konsora MCP server (it runs \`konsora mcp\`).`);
  if (result.mcp === "added") lines.push(`Added the konsora MCP server to ${MCP_JSON}.`);
  if (result.mcp === "present") lines.push(`${MCP_JSON} already has a konsora server.`);
  if (result.mcp) lines.push("Restart Claude Code in this folder and approve the konsora server.");
  return `${lines.join("\n")}\n`;
}

export const AGENTS = ["claude", "codex"] as const;
export type Agent = (typeof AGENTS)[number];

/** `--agent` (repeatable): the agents to integrate, each once. */
export function collectAgent(value: string, previous: Agent[] = []): Agent[] {
  if (!(AGENTS as readonly string[]).includes(value))
    throw new CliError(
      `Unknown agent "${value}".`,
      `Use ${AGENTS.join(" or ")}, e.g. --agent codex.`,
      EXIT.usage,
    );
  return previous.includes(value as Agent) ? previous : [...previous, value as Agent];
}

export function registerSkill(program: Command, io: Io, rootOption: () => string | undefined) {
  program
    .command("skill")
    .description(
      "install the agent integration: for Claude Code the protocol skill and the MCP server in .mcp.json, for Codex AGENTS.md and .codex/config.toml (never overwrites, except the skill with --update)",
    )
    .option(
      "--agent <name>",
      "agent to integrate: claude (default) or codex; repeat for both",
      collectAgent,
    )
    .option("--no-mcp", "only the skill, without touching .mcp.json")
    .option(
      "--update",
      "replace an older skill with the current protocol (only if not edited by hand)",
    )
    .option("--force", "with --update: replace it even if it was edited by hand")
    .option(
      "--hooks",
      "also add the Claude Code hooks to .claude/settings.json (plan status at session start, reminder at stop)",
    )
    .option("--json", "machine-readable output")
    .action(
      async (opts: {
        agent?: Agent[];
        mcp: boolean;
        update?: boolean;
        force?: boolean;
        hooks?: boolean;
        json?: boolean;
      }) => {
        const agents = opts.agent ?? ["claude"];
        if (opts.force && !opts.update)
          throw new CliError(
            "--force only goes with --update.",
            "Run `konsora skill --update --force`.",
            EXIT.usage,
          );
        if ((opts.hooks || opts.update) && !agents.includes("claude"))
          throw new CliError(
            "--hooks and --update are for the Claude Code integration.",
            "Add --agent claude, or drop them.",
            EXIT.usage,
          );
        const root = locate(io, rootOption());
        const fail = (what: string) => (error: Error) => {
          if (error instanceof CliError) throw error;
          throw new CliError(`Could not install ${what}: ${error.message}`);
        };
        const result: Partial<SkillInstall> & { hooks?: HooksInstall; codex?: CodexInstall } = {};
        let text = "";
        if (agents.includes("claude")) {
          const install = opts.update
            ? updateSkill(root, { mcp: opts.mcp, force: Boolean(opts.force) })
            : installSkill(root, { mcp: opts.mcp });
          Object.assign(result, await install.catch(fail("the integration")));
          text += describeInstall(result as SkillInstall);
          if (opts.hooks) {
            result.hooks = await installHooks(root).catch(fail("the hooks"));
            text += describeHooks(result.hooks);
          }
        }
        if (agents.includes("codex")) {
          result.codex = await installCodex(root).catch(fail("the Codex integration"));
          text += describeCodex(result.codex);
        }
        if (opts.json) json(io, result);
        else io.stdout(text);
      },
    );
}
