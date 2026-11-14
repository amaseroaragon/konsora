import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENTS_MD, agentsBlock, CODEX_CONFIG } from "../src/codex.ts";
import { EXIT, main } from "../src/main.ts";
import { SKILL_PATH } from "../src/skill.ts";

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "konsora-codex-"));
  home = mkdtempSync(join(tmpdir(), "konsora-codex-home-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

async function run(args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await main(args, {
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
    cwd: dir,
    env: { HOME: home, CODEX_HOME: join(home, ".codex") },
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

const read = (path: string) => readFileSync(join(dir, path), "utf8");
const TABLE =
  '[mcp_servers.konsora]\ncommand = "konsora"\nargs = ["mcp"]\n\n[mcp_servers.konsora.env]\nKONSORA_AGENT = "codex"\n';

describe("init --agent codex", () => {
  it("adds the protocol to AGENTS.md without losing its content and registers the server", async () => {
    writeFileSync(join(dir, AGENTS_MD), "# My project\n\nUse pnpm.\n");
    const r = await run(["init", "--agent", "codex"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain(`Added the Konsora protocol to ${AGENTS_MD}`);
    expect(r.stdout).toContain(`Created ${CODEX_CONFIG} with the konsora MCP server`);
    expect(r.stdout).toContain("only once you trust this project");
    const agents = read(AGENTS_MD);
    expect(agents.startsWith("# My project\n\nUse pnpm.\n\n<!-- konsora:begin")).toBe(true);
    expect(agents.endsWith("<!-- konsora:end -->\n")).toBe(true);
    expect(agents).toContain("Pass `--as codex` on every write");
    expect(agents).not.toContain("--as claude");
    expect(agents).not.toMatch(/^name: konsora$/m);
    expect(read(CODEX_CONFIG)).toBe(TABLE);
    // Only the Codex integration, and nothing in HOME.
    expect(existsSync(join(dir, SKILL_PATH))).toBe(false);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    expect(existsSync(join(home, ".codex"))).toBe(false);
  });

  it("--agent claude --agent codex installs both; the default is still Claude Code alone", async () => {
    expect((await run(["init", "--agent", "claude", "--agent", "codex"])).code).toBe(EXIT.ok);
    for (const path of [SKILL_PATH, ".mcp.json", AGENTS_MD, CODEX_CONFIG])
      expect(existsSync(join(dir, path)), path).toBe(true);
    const other = mkdtempSync(join(tmpdir(), "konsora-codex-"));
    try {
      await main(["init"], { stdout: () => {}, stderr: () => {}, cwd: other, env: {} });
      expect(existsSync(join(other, AGENTS_MD))).toBe(false);
      expect(existsSync(join(other, ".codex"))).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("rejects an unknown agent, and --agent with --no-claude", async () => {
    let r = await run(["init", "--agent", "cursor"]);
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain('Unknown agent "cursor"');
    r = await run(["init", "--agent", "codex", "--no-claude"]);
    expect(r.code).toBe(EXIT.usage);
    r = await run(["init", "--agent", "codex", "--hooks"]);
    expect(r.code).toBe(EXIT.usage);
    expect(existsSync(join(dir, ".konsora"))).toBe(false);
  });
});

describe("skill --agent codex", () => {
  it("is idempotent and appends to an existing config without touching it", async () => {
    await run(["init", "--no-claude"]);
    mkdirSync(join(dir, ".codex"), { recursive: true });
    const own = 'model = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n';
    writeFileSync(join(dir, CODEX_CONFIG), own);
    const first = await run(["skill", "--agent", "codex", "--json"]);
    expect(first.json()).toEqual({ codex: { agents: "created", config: "added" } });
    expect(read(CODEX_CONFIG)).toBe(`${own}\n${TABLE}`);
    expect(read(AGENTS_MD)).toBe(await agentsBlock());

    const agents = read(AGENTS_MD);
    const config = read(CODEX_CONFIG);
    const again = await run(["skill", "--agent", "codex"]);
    expect(again.stdout).toContain(`${AGENTS_MD} already has the Konsora protocol`);
    expect(again.stdout).toContain(`${CODEX_CONFIG} already has a konsora server.`);
    expect(read(AGENTS_MD)).toBe(agents);
    expect(read(CODEX_CONFIG)).toBe(config);
  });

  it("leaves a config with an inline mcp_servers or its own konsora table alone", async () => {
    await run(["init", "--no-claude"]);
    mkdirSync(join(dir, ".codex"), { recursive: true });
    const inline = 'mcp_servers = { docs = { command = "docs" } }\n';
    writeFileSync(join(dir, CODEX_CONFIG), inline);
    const r = await run(["skill", "--agent", "codex"]);
    expect(r.code).toBe(EXIT.failure);
    expect(r.stderr).toContain("defines mcp_servers inline; left it unchanged");
    expect(read(CODEX_CONFIG)).toBe(inline);

    const mine = '[mcp_servers."konsora"]\ncommand = "/opt/konsora"\n';
    writeFileSync(join(dir, CODEX_CONFIG), mine);
    expect((await run(["skill", "--agent", "codex", "--json"])).json().codex.config).toBe(
      "present",
    );
    expect(read(CODEX_CONFIG)).toBe(mine);
  });

  it("--hooks and --update need the Claude Code integration", async () => {
    await run(["init", "--no-claude"]);
    expect((await run(["skill", "--agent", "codex", "--hooks"])).code).toBe(EXIT.usage);
    expect((await run(["skill", "--agent", "codex", "--update"])).code).toBe(EXIT.usage);
  });
});

describe("mcp --print-config codex", () => {
  it("prints a TOML table for this checkout's server and where to paste it", async () => {
    await run(["init", "--no-claude"]);
    const r = await run(["mcp", "--print-config", "codex"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toMatch(/^# Konsora MCP server for Codex\n\[mcp_servers\.konsora\]\n/);
    expect(r.stdout).toContain(`command = ${JSON.stringify(process.execPath)}`);
    expect(r.stdout).toMatch(/args = \[".+bin\.ts", "mcp", "--root", ".+"\]/);
    expect(r.stdout).toContain('[mcp_servers.konsora.env]\nKONSORA_AGENT = "codex"\n');
    expect(r.stderr).toContain(`Paste this into ${CODEX_CONFIG}`);
    expect(existsSync(join(dir, ".codex"))).toBe(false);
  });
});
