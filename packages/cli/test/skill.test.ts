import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, main } from "../src/main.ts";
import { SKILL_PATH, sha256, skillState, skillText } from "../src/skill.ts";

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
    expect(first.stdout).toContain(
      "already exists and is older than this Konsora; left it unchanged (replace it with `konsora skill --update`)",
    );
    expect(first.stdout).toContain("Created .mcp.json with the konsora MCP server");
    expect(readFileSync(join(dir, SKILL_PATH), "utf8")).toBe("my own version");
    const mcp = readFileSync(join(dir, ".mcp.json"), "utf8");
    const second = await run(["skill"]);
    expect(second.stdout).toContain(".mcp.json already has a konsora server.");
    expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toBe(mcp);
    const skillOnly = await run(["skill", "--no-mcp", "--json"]);
    expect(JSON.parse(skillOnly.stdout)).toEqual({ skill: "exists", outdated: true });
  });
});

describe("skill versions (CLI-03)", () => {
  const releases = JSON.parse(
    readFileSync(new URL("../assets/skill-releases.json", import.meta.url), "utf8"),
  ) as { current: number; known: Record<string, number> };
  const skillFile = () => join(dir, SKILL_PATH);
  /** A published skill from before the version marker (its hash is a v0 release). */
  const legacy = () =>
    execFileSync("git", ["show", "f3ab62f:packages/cli/assets/SKILL.md"], {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      encoding: "utf8",
    });
  const install = (text: string) => {
    mkdirSync(join(dir, ".claude", "skills", "konsora"), { recursive: true });
    writeFileSync(skillFile(), text);
  };

  it("the asset carries the current version, and its hash is recorded for it", async () => {
    const text = await skillText();
    expect(text).toContain(`<!-- konsora-skill-version: ${releases.current} -->`);
    expect(
      releases.known[sha256(text)],
      "SKILL.md changed: bump `current` in assets/skill-releases.json and record its sha256",
    ).toBe(releases.current);
    expect(legacy()).not.toContain("konsora-skill-version");
    expect(releases.known[sha256(legacy())]).toBe(0);
  });

  it("status warns with a hint when the installed skill is older, and not when it is current", async () => {
    await run(["init"]);
    let status = await run(["status"]);
    expect(status.stdout).not.toContain("older than this Konsora");
    expect(JSON.parse((await run(["status", "--json"])).stdout)).not.toHaveProperty(
      "skillOutdated",
    );

    install(legacy());
    status = await run(["status"]);
    expect(status.stdout).toContain(
      `The agent protocol skill at ${SKILL_PATH} is older than this Konsora (v0, current v${releases.current})`,
    );
    expect(status.stdout).toContain("Hint: replace it with `konsora skill --update`.");
    expect(JSON.parse((await run(["status", "--json"])).stdout).skillOutdated).toEqual({
      installed: 0,
      current: releases.current,
      modified: false,
    });

    install(`${legacy()}\nMy own rule.\n`);
    status = await run(["status"]);
    expect(status.stdout).toContain("it was edited by hand");
    expect(status.stdout).toContain("`konsora skill --update --force`");
  });

  it("--update replaces an unedited older skill, and says when it is already current", async () => {
    await run(["init", "--no-claude"]);
    install(legacy());
    const r = await run(["skill", "--update", "--no-mcp"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain(`Updated the agent protocol skill at ${SKILL_PATH}`);
    expect(readFileSync(skillFile(), "utf8")).toBe(await skillText());
    expect(await skillState(dir)).toEqual({
      installed: releases.current,
      current: releases.current,
      modified: false,
    });
    const again = await run(["skill", "--update", "--json"]);
    expect(JSON.parse(again.stdout)).toEqual({ skill: "current", mcp: "created" });
    expect(readdirSync(join(dir, ".claude", "skills", "konsora"))).toEqual(["SKILL.md"]);
  });

  it("--update refuses a skill edited by hand unless --force", async () => {
    await run(["init", "--no-claude"]);
    const edited = `${legacy()}\nMy own rule.\n`;
    install(edited);
    const refused = await run(["skill", "--update"]);
    expect(refused.code).toBe(EXIT.failure);
    expect(refused.stderr).toContain(`${SKILL_PATH} was edited by hand`);
    expect(refused.stderr).toContain("Hint: Review your changes");
    expect(readFileSync(skillFile(), "utf8")).toBe(edited);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);

    // An edited current skill is still an edit: it is not replaced without --force either.
    install(`${await skillText()}\nMine.\n`);
    expect((await run(["skill", "--update"])).code).toBe(EXIT.failure);

    const forced = await run(["skill", "--update", "--force", "--no-mcp"]);
    expect(forced.code).toBe(EXIT.ok);
    expect(readFileSync(skillFile(), "utf8")).toBe(await skillText());
    expect((await run(["skill", "--force"])).code).toBe(EXIT.usage);
  });

  it("--update installs a missing skill; without --update nothing is overwritten", async () => {
    await run(["init", "--no-claude"]);
    expect(JSON.parse((await run(["skill", "--update", "--no-mcp", "--json"])).stdout)).toEqual({
      skill: "created",
    });
    install(legacy());
    expect((await run(["skill"])).code).toBe(EXIT.ok);
    expect(readFileSync(skillFile(), "utf8")).toBe(legacy());
    expect((await run(["init"])).code).toBe(EXIT.failure);
    expect(readFileSync(skillFile(), "utf8")).toBe(legacy());
  });
});
