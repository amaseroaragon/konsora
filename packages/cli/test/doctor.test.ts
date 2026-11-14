import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Check, type DoctorDeps, doctorChecks, MIN_NODE } from "../src/doctor.ts";
import { EXIT, main } from "../src/main.ts";
import type { Io } from "../src/shared.ts";
import { SKILL_PATH } from "../src/skill.ts";

let dir: string;
let bin: string;
let data: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "konsora-doctor-"));
  bin = mkdtempSync(join(tmpdir(), "konsora-doctor-bin-"));
  data = mkdtempSync(join(tmpdir(), "konsora-doctor-data-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
});
afterEach(() => {
  for (const d of [dir, bin, data]) rmSync(d, { recursive: true, force: true });
});

const fakeCommand = (name: string) => {
  writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, name), 0o755);
};
const env = (): NodeJS.ProcessEnv => ({ PATH: bin, KONSORA_DATA_DIR: data });

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
    env: env(),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

const io = (): Io => ({ stdout: () => {}, stderr: () => {}, cwd: dir, env: env() });
const byId = (checks: Check[]) => Object.fromEntries(checks.map((c) => [c.id, c]));
const checks = async (deps: DoctorDeps = {}) =>
  byId(await doctorChecks(io(), dir, { daemon: async () => ({ running: false }), ...deps }));

/** Every file under `root` with its content and mtime, to prove nothing was written. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[path] = `${statSync(path).mtimeMs}:${readFileSync(path, "base64")}`;
    }
  };
  walk(root);
  return out;
}

describe("konsora doctor", () => {
  it("checks everything with one line each and passes on a healthy project", async () => {
    await run(["init"]);
    fakeCommand("claude");
    fakeCommand("konsora");
    const r = await run(["doctor"]);
    expect(r.code).toBe(EXIT.ok);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines.slice(0, 7).map((l) => l.split(/\s+/).slice(0, 2).join(" "))).toEqual([
      "ok node",
      "ok plan",
      "ok lock",
      "ok skill",
      "ok mcp",
      "ok claude",
      "ok daemon",
    ]);
    expect(r.stdout).toContain("The daemon is not running");
    expect(lines.at(-1)).toBe("Everything works.");
    const json = (await run(["doctor", "--json"])).json();
    expect(json.ok).toBe(true);
    expect(json.checks.map((c: Check) => c.id)).toEqual([
      "node",
      "plan",
      "lock",
      "skill",
      "mcp",
      "claude",
      "daemon",
    ]);
  });

  it("fails with a hint per problem and a non-zero exit code", async () => {
    await run(["init"]);
    writeFileSync(join(dir, ".konsora", "tasks.json"), "{ broken");
    writeFileSync(join(dir, ".mcp.json"), "{ nope");
    const r = await run(["doctor"]);
    expect(r.code).toBe(EXIT.failure);
    expect(r.stdout).toMatch(/^FAIL {2}plan +The plan is invalid/m);
    expect(r.stdout).toContain("Hint: Run `konsora check`");
    expect(r.stdout).toMatch(/^FAIL {2}mcp +\.mcp\.json is not valid JSON/m);
    expect(r.stdout).toMatch(/^warn {2}claude +No `claude` command on PATH/m);
    expect(r.stdout).toContain("2 problem(s) to fix, 1 warning(s).");
    for (const line of r.stdout.split("\n").filter((l) => /^(FAIL|warn)/.test(l))) {
      const next = r.stdout.split("\n")[r.stdout.split("\n").indexOf(line) + 1];
      expect(next, line).toMatch(/^\s+Hint: /);
    }
    const json = await run(["doctor", "--json"]);
    expect(json.code).toBe(EXIT.failure);
    expect(json.json().ok).toBe(false);
  });

  it("without a project still checks the machine and fails on the plan", async () => {
    const r = await run(["doctor"]);
    expect(r.code).toBe(EXIT.failure);
    expect(r.stdout).toMatch(/^FAIL {2}plan +No \.konsora\/ folder/m);
    expect(r.stdout).toMatch(/^ok {4}node/m);
    expect(r.stdout).toMatch(/daemon/);
  });

  it("checks the Node version, the skill's version and the MCP entry", async () => {
    await run(["init"]);
    expect((await checks({ nodeVersion: "22.17.9" })).node?.status).toBe("fail");
    expect((await checks({ nodeVersion: "24.0.0" })).node?.status).toBe("ok");

    let c = await checks();
    // The .mcp.json entry runs the global `konsora`, which is not on this PATH.
    expect(c.mcp).toMatchObject({
      status: "fail",
      hint: expect.stringContaining("install:global"),
    });
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
    expect((await checks()).mcp?.status).toBe("warn");

    writeFileSync(join(dir, SKILL_PATH), "my own protocol");
    c = await checks();
    expect(c.skill).toMatchObject({
      status: "warn",
      hint: expect.stringContaining("--update --force"),
    });
    rmSync(join(dir, SKILL_PATH));
    expect((await checks()).skill?.status).toBe("warn");
  });

  it("tells an orphan lock from a live one, another machine's and a foreign file", async () => {
    await run(["init", "--no-claude"]);
    const lock = join(dir, ".konsora", "tasks.json.lock");
    const at = "2026-11-14T10:00:00Z";
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), at }));
    expect((await checks()).lock).toMatchObject({ status: "ok" });
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 - 7, host: hostname(), at }));
    expect((await checks()).lock).toMatchObject({
      status: "warn",
      message: expect.stringContaining("Orphan lock"),
    });
    writeFileSync(lock, JSON.stringify({ pid: 12, host: "other-box", at }));
    expect((await checks()).lock).toMatchObject({ status: "fail" });
    writeFileSync(lock, "garbage");
    expect((await checks()).lock).toMatchObject({
      status: "fail",
      hint: expect.stringContaining("delete .konsora/tasks.json.lock"),
    });
    writeFileSync(join(dir, ".konsora", ".tasks.json.123.tmp"), "{}");
    expect((await checks()).temp?.status).toBe("warn");
  });

  it("reports the daemon's state and version", async () => {
    await run(["init", "--no-claude"]);
    const daemon = (state: Awaited<ReturnType<NonNullable<DoctorDeps["daemon"]>>>) =>
      checks({ daemon: async () => state });
    expect(
      (await daemon({ running: true, answers: true, version: "1.2.3", stale: false })).daemon,
    ).toMatchObject({ status: "ok", message: "The daemon is running, version 1.2.3." });
    expect(
      (await daemon({ running: true, answers: true, version: "1.2.3", stale: true })).daemon,
    ).toMatchObject({ status: "warn", hint: expect.stringContaining("konsora ui") });
    expect((await daemon({ running: true, answers: false, pid: 42 })).daemon).toMatchObject({
      status: "fail",
      hint: expect.stringContaining("konsora ui --stop"),
    });
  });

  it("writes nothing and prints no path outside the project", async () => {
    await run(["init"]);
    const lock = join(dir, ".konsora", "tasks.json.lock");
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 - 7, host: hostname(), at: "x" }));
    const before = { project: snapshot(dir), data: snapshot(data) };
    const r = await run(["doctor"]);
    const json = await run(["doctor", "--json"]);
    expect({ project: snapshot(dir), data: snapshot(data) }).toEqual(before);
    for (const out of [r.stdout, json.stdout, r.stderr]) {
      expect(out).not.toContain(dir);
      expect(out).not.toContain(bin);
      expect(out).not.toContain(data);
      expect(out).not.toContain(tmpdir());
    }
  });

  it("MIN_NODE matches the engines of the root package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    expect(pkg.engines.node).toBe(`>=${MIN_NODE}`);
  });
});

describe("inspectLock", () => {
  it("reports none without a lock file", async () => {
    mkdirSync(join(dir, ".konsora"));
    const { inspectLock } = await import("@konsora/core/store");
    expect(await inspectLock(dir)).toEqual({ status: "none" });
  });
});
