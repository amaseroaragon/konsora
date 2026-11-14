/**
 * The Codex integration of a project (CLI-09), installed with `konsora init --agent codex` or
 * `konsora skill --agent codex`. Like the Claude Code one, it only adds and never overwrites:
 *
 * - The protocol goes in `AGENTS.md` at the project root (Codex reads it from the root down to
 *   the working folder), as a block between markers. The rest of the file is never touched, and
 *   a file that already has the block is left as it is.
 * - The `konsora` MCP server goes in the project's `.codex/config.toml`, as a
 *   `[mcp_servers.konsora]` table appended at the end. Codex loads that file only for projects
 *   the user trusts. Nothing is written in HOME (`~/.codex`).
 *
 * There is no TOML parser: appending a table is valid TOML, and the few layouts where it would
 * not be (an inline `mcp_servers = { … }`, an existing `konsora` table) are detected and refused
 * or left alone.
 */
import { constants } from "node:fs";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { serverCommand } from "./mcp-config.ts";
import { skillText } from "./skill.ts";

export const AGENTS_MD = "AGENTS.md";
export const CODEX_CONFIG = join(".codex", "config.toml");

const BEGIN = "<!-- konsora:begin (the Konsora protocol, added by `konsora init`) -->";
const END = "<!-- konsora:end -->";

export type FileInstall = "created" | "added" | "present";
export type CodexInstall = { agents: FileInstall; config: FileInstall };

/** The skill's protocol, without its Claude Code frontmatter and signed as Codex. */
export async function agentsBlock(): Promise<string> {
  const body = (await skillText())
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/^<!-- konsora-skill-version: \d+ -->\n/m, "")
    .replaceAll("--as claude", "--as codex")
    .replaceAll(
      "--as <your-name>` on every write (e.g. `--as codex`)",
      "--as codex` on every write",
    )
    .trim();
  return `${BEGIN}\n\n${body}\n\n${END}\n`;
}

const TOML_SERVER = /^\s*\[\s*mcp_servers\s*\.\s*(?:konsora|"konsora"|'konsora')\s*\]/m;
const TOML_INLINE = /^\s*mcp_servers\s*=/m;

/** A TOML string: JSON's escaping is valid for TOML basic strings. */
const str = (value: string) => JSON.stringify(value);

function serverToml(server: { command: string; args: string[]; env: Record<string, string> }) {
  return [
    "[mcp_servers.konsora]",
    `command = ${str(server.command)}`,
    `args = [${server.args.map(str).join(", ")}]`,
    "",
    "[mcp_servers.konsora.env]",
    ...Object.entries(server.env).map(([key, value]) => `${key} = ${str(value)}`),
    "",
  ].join("\n");
}

/** The portable entry for a project's `.codex/config.toml`: the global command. */
export const PROJECT_CODEX_SERVER = {
  command: "konsora",
  args: ["mcp"],
  env: { KONSORA_AGENT: "codex" },
};

/** `konsora mcp --print-config codex`: this checkout's server, with absolute paths. */
export function codexSnippet(root: string): string {
  return `# Konsora MCP server for Codex\n${serverToml({ ...serverCommand(root), env: { KONSORA_AGENT: "codex" } })}`;
}

export function codexHint(): string {
  return `Paste this into ${CODEX_CONFIG} at the project root (Codex loads it once you trust the project) or into ~/.codex/config.toml, then restart Codex. With the global command installed, \`konsora skill --agent codex\` adds a portable entry for you.\n`;
}

async function readOptional(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

async function writeAtomic(path: string, text: string) {
  const temp = `${path}.konsora-${process.pid}.tmp`;
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
}

/** Appends the protocol block to `AGENTS.md` (created if missing) unless it is already there. */
export async function installAgentsMd(root: string): Promise<FileInstall> {
  const path = join(root, AGENTS_MD);
  const text = await readOptional(path);
  if (text?.includes(BEGIN) || text?.includes(END)) return "present";
  const block = await agentsBlock();
  if (text === undefined || text.trim() === "") {
    await writeAtomic(path, block);
    return text === undefined ? "created" : "added";
  }
  await writeAtomic(path, `${text.replace(/\n*$/, "")}\n\n${block}`);
  return "added";
}

/** Appends the `konsora` server to `.codex/config.toml` (created if missing) unless present. */
export async function installCodexConfig(root: string): Promise<FileInstall> {
  const path = join(root, CODEX_CONFIG);
  const text = await readOptional(path);
  if (text !== undefined && TOML_SERVER.test(text)) return "present";
  if (text !== undefined && TOML_INLINE.test(text))
    throw new Error(
      `${CODEX_CONFIG} defines mcp_servers inline; left it unchanged (add the konsora server by hand)`,
    );
  const table = serverToml(PROJECT_CODEX_SERVER);
  await mkdir(join(root, ".codex"), { recursive: true });
  if (text === undefined || text.trim() === "") {
    await writeAtomic(path, table);
    return text === undefined ? "created" : "added";
  }
  await writeAtomic(path, `${text.replace(/\n*$/, "")}\n\n${table}`);
  return "added";
}

export async function installCodex(root: string): Promise<CodexInstall> {
  return { agents: await installAgentsMd(root), config: await installCodexConfig(root) };
}

export function describeCodex(result: CodexInstall): string {
  const lines = [
    {
      created: `Created ${AGENTS_MD} with the Konsora protocol for Codex.`,
      added: `Added the Konsora protocol to ${AGENTS_MD} (the rest of the file is unchanged).`,
      present: `${AGENTS_MD} already has the Konsora protocol; left it unchanged.`,
    }[result.agents],
    {
      created: `Created ${CODEX_CONFIG} with the konsora MCP server (it runs \`konsora mcp\`).`,
      added: `Added the konsora MCP server to ${CODEX_CONFIG}.`,
      present: `${CODEX_CONFIG} already has a konsora server.`,
    }[result.config],
  ];
  if (result.config !== "present")
    lines.push("Codex loads .codex/config.toml only once you trust this project; then restart it.");
  return `${lines.join("\n")}\n`;
}
