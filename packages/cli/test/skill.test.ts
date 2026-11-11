import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, main } from "../src/main.ts";
import { SKILL_PATH, skillText } from "../src/skill.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "konsora-skill-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
    env: {},
  });
  return { code, stdout, stderr };
}

describe("agent protocol skill", () => {
  it("has Claude Code skill frontmatter and covers the protocol", async () => {
    const text = await skillText();
    expect(text).toMatch(/^---\nname: konsora\ndescription: .+\n---\n/);
    for (const command of [
      "status",
      "ready",
      "show",
      "start",
      "note",
      "ask",
      "finish",
      "batch",
      "--as",
    ]) {
      expect(text).toContain(command);
    }
    expect(text).toContain("never edit that file by hand");
  });

  it("init installs it; --no-claude skips it", async () => {
    const r = await run(["init"]);
    expect(r.stdout).toContain(`Installed the agent protocol skill at ${SKILL_PATH}.`);
    expect(readFileSync(join(dir, SKILL_PATH), "utf8")).toBe(await skillText());
    const other = mkdtempSync(join(tmpdir(), "konsora-skill-"));
    let out = "";
    await main(["init", "--no-claude"], {
      stdout: (s) => (out += s),
      stderr: () => {},
      cwd: other,
      env: {},
    });
    expect(existsSync(join(other, SKILL_PATH))).toBe(false);
    expect(out).not.toContain("Installed the agent protocol skill");
    rmSync(other, { recursive: true });
  });

  it("`konsora skill` never overwrites an existing skill and adds the MCP server once", async () => {
    await run(["init", "--no-claude"]);
    mkdirSync(join(dir, ".claude", "skills", "konsora"), { recursive: true });
    writeFileSync(join(dir, SKILL_PATH), "my own version");
    const first = await run(["skill"]);
    expect(first.code).toBe(EXIT.ok);
    expect(first.stdout).toContain("already exists; left it unchanged");
    expect(first.stdout).toContain("Created .mcp.json with the konsora MCP server");
    expect(readFileSync(join(dir, SKILL_PATH), "utf8")).toBe("my own version");
    const mcp = readFileSync(join(dir, ".mcp.json"), "utf8");
    const second = await run(["skill"]);
    expect(second.stdout).toContain(".mcp.json already has a konsora server.");
    expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toBe(mcp);
    const skillOnly = await run(["skill", "--no-mcp", "--json"]);
    expect(JSON.parse(skillOnly.stdout)).toEqual({ skill: "exists" });
  });
});
