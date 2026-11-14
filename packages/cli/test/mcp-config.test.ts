import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { skillText } from "../src/skill.ts";
import { SLOW_TIMEOUT } from "./slow-timeout.ts";

const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

let home: string;
let project: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "konsora-home-"));
  project = mkdtempSync(join(tmpdir(), "konsora-cfg-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

/** Runs the real binary with a throwaway HOME, so any write to ~/.claude shows up. */
function konsora(args: string[]) {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
  };
  const r = spawnSync(process.execPath, [bin, ...args], { cwd: project, env, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

type Server = { type?: string; command: string; args: string[]; env: Record<string, string> };

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => !path.startsWith(".git/") && path !== ".git")
    .filter((path) => statSync(join(dir, path)).isFile())
    .sort();
}

describe("konsora mcp --print-config", { timeout: SLOW_TIMEOUT }, () => {
  it("prints valid JSON for Claude Code (.mcp.json) pointing to this project's konsora", () => {
    expect(konsora(["init"]).code).toBe(0);
    const r = konsora(["mcp", "--print-config", "claude"]);
    expect(r.code).toBe(0);
    const server = (JSON.parse(r.stdout) as { mcpServers: { konsora: Server } }).mcpServers.konsora;
    expect(server).toEqual({
      type: "stdio",
      command: process.execPath,
      args: [bin, "mcp", "--root", project],
      env: { KONSORA_AGENT: "claude" },
    });
    expect(existsSync(server.args[0] as string)).toBe(true);
    expect(r.stderr).toContain(".mcp.json");
  });

  it("the printed command starts a working server", async () => {
    expect(konsora(["init", "--name", "Demo"]).code).toBe(0);
    const config = JSON.parse(konsora(["mcp", "--print-config", "claude"]).stdout) as {
      mcpServers: { konsora: Server };
    };
    const server = config.mcpServers.konsora;
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: { ...server.env, PATH: process.env.PATH ?? "" },
      cwd: tmpdir(),
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    const result = (await client.callTool({ name: "status", arguments: {} })) as {
      content: { text: string }[];
    };
    expect(JSON.parse(result.content[0]?.text ?? "").project.name).toBe("Demo");
    await client.close();
  });

  it("rejects an unknown agent and a folder without a plan", () => {
    expect(konsora(["mcp", "--print-config", "cursor"]).code).toBe(2);
    const none = konsora(["mcp", "--print-config", "claude"]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("Run `konsora init`");
  });
});

describe("agent configuration", { timeout: SLOW_TIMEOUT }, () => {
  it("init writes the skill and .mcp.json in the project, never HOME; print-config writes nothing", () => {
    expect(konsora(["init"]).code).toBe(0);
    const before = files(project);
    expect(konsora(["mcp", "--print-config", "claude"]).code).toBe(0);
    expect(konsora(["skill"]).code).toBe(0);
    expect(files(project)).toEqual(before);
    expect(before).toEqual([".claude/skills/konsora/SKILL.md", ".konsora/tasks.json", ".mcp.json"]);
    expect(files(home)).toEqual([]);
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  it("adds konsora to an existing .mcp.json, keeps its servers, and refuses an invalid one", () => {
    const other = { mcpServers: { other: { command: "x" } }, extra: true };
    writeFileSync(join(project, ".mcp.json"), JSON.stringify(other));
    expect(konsora(["init"]).code).toBe(0);
    const config = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8"));
    expect(config.extra).toBe(true);
    expect(Object.keys(config.mcpServers)).toEqual(["other", "konsora"]);
    expect(config.mcpServers.konsora).toEqual({
      type: "stdio",
      command: "konsora",
      args: ["mcp"],
      env: { KONSORA_AGENT: "claude" },
    });
    writeFileSync(join(project, ".mcp.json"), "{ not json");
    const r = konsora(["skill"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not valid JSON");
    expect(readFileSync(join(project, ".mcp.json"), "utf8")).toBe("{ not json");
  });
});

describe("the protocol mentions the MCP tools", () => {
  it("the skill explains when to use the MCP tools and the planning session", async () => {
    const text = await skillText();
    expect(text).toContain("## MCP tools");
    expect(text).toContain("mcp__konsora__status");
    expect(text).toContain("prefer its tools over the shell commands");
    expect(text).toContain(".mcp.json");
    expect(text).toContain("In a planning session");
  });

  it("this repository's own skill matches the one Konsora installs", async () => {
    const repoSkill = fileURLToPath(
      new URL("../../../.claude/skills/konsora/SKILL.md", import.meta.url),
    );
    expect(readFileSync(repoSkill, "utf8")).toBe(await skillText());
  });
});
