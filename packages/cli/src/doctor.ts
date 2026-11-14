/**
 * `konsora doctor` (CLI-10): checks everything Konsora needs in this project and on this machine,
 * one line per check, each problem with how to fix it. Read-only: it writes nothing (the plan's
 * lock is inspected, never removed) and prints no token and no path outside the project.
 *
 * Statuses: `ok`; `warn`, something optional is missing or will fix itself (exit 0); `fail`,
 * something Konsora needs is broken (exit 1).
 */
import { accessSync, constants, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { inspectLock, readTasks, strayTempFiles } from "@konsora/core/store";
import type { Command } from "commander";
import { MCP_JSON } from "./mcp-config.ts";
import { findRoot } from "./project.ts";
import { CliError, EXIT, type Io, json } from "./shared.ts";
import { SKILL_PATH, skillState } from "./skill.ts";

/** The `engines.node` of the root package.json (a test keeps them equal). */
export const MIN_NODE = "22.18.0";

export type CheckStatus = "ok" | "warn" | "fail";
export type Check = { id: string; status: CheckStatus; message: string; hint?: string };

export type DoctorDeps = {
  /** The running Node's version (default: process.versions.node). */
  nodeVersion?: string;
  /** The daemon's state (default: read from the daemon's data dir and asked over HTTP). */
  daemon?: () => Promise<DaemonCheck>;
};

export type DaemonCheck =
  | { running: false }
  | { running: true; answers: false; pid: number }
  | { running: true; answers: true; version: string; stale: boolean };

const ok = (id: string, message: string): Check => ({ id, status: "ok", message });
const warn = (id: string, message: string, hint: string): Check => ({
  id,
  status: "warn",
  message,
  hint,
});
const fail = (id: string, message: string, hint: string): Check => ({
  id,
  status: "fail",
  message,
  hint,
});

function newerOrEqual(version: string, min: string): boolean {
  const a = version.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Whether an executable called `name` is on PATH (its location is never printed). */
export function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

async function readOptional(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

async function mcpCheck(root: string, env: NodeJS.ProcessEnv): Promise<Check> {
  let text: string | undefined;
  try {
    text = await readOptional(join(root, MCP_JSON));
  } catch {
    return fail("mcp", `${MCP_JSON} cannot be read.`, `Check the permissions of ${MCP_JSON}.`);
  }
  if (text === undefined)
    return warn(
      "mcp",
      `No ${MCP_JSON}: Claude Code sessions here do not get the konsora MCP tools.`,
      "Run `konsora skill` to add the server (skip this if you only use the CLI or another agent).",
    );
  let server: unknown;
  try {
    const parsed = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
    server = parsed?.mcpServers?.konsora;
  } catch {
    return fail(
      "mcp",
      `${MCP_JSON} is not valid JSON, so Claude Code ignores it.`,
      `Fix ${MCP_JSON} by hand; Konsora never overwrites it.`,
    );
  }
  if (!server)
    return warn(
      "mcp",
      `${MCP_JSON} has no konsora server.`,
      "Run `konsora skill` to add it (it leaves the other servers alone).",
    );
  const command = (server as { command?: unknown }).command;
  if (command === "konsora" && !onPath("konsora", env))
    return fail(
      "mcp",
      `${MCP_JSON} runs \`konsora mcp\`, but no \`konsora\` command is on PATH.`,
      "Install it with `npm run install:global` in the Konsora checkout.",
    );
  return ok("mcp", `${MCP_JSON} has the konsora server.`);
}

async function projectChecks(root: string, env: NodeJS.ProcessEnv): Promise<Check[]> {
  const checks: Check[] = [];
  const read = await readTasks(root);
  if (read.ok)
    checks.push(
      ok(
        "plan",
        `Plan valid: ${read.document.tasks.length} tasks in ${read.document.groups.length} groups (${read.document.schema}).`,
      ),
    );
  else if (read.error.code === "missing")
    checks.push(
      fail("plan", "No .konsora/tasks.json in this project.", "Run `konsora init` here."),
    );
  else if (read.error.issues?.some((issue) => issue.path === "/schema"))
    checks.push(
      fail(
        "plan",
        "The plan is in an older format, so it is read-only.",
        "Preview the conversion with `konsora migrate`, then apply it with `konsora migrate --write`.",
      ),
    );
  else
    checks.push(
      fail(
        "plan",
        `The plan is invalid (${read.error.issues?.length ?? 1} problem(s)), so it is read-only.`,
        "Run `konsora check` to see every problem; Konsora never overwrites an invalid plan.",
      ),
    );

  const lock = await inspectLock(root);
  if (lock.status === "none") checks.push(ok("lock", "No lock on the plan."));
  else if (lock.status === "held")
    checks.push(ok("lock", `A write is in progress (pid ${lock.pid}).`));
  else if (lock.status === "stale")
    checks.push(
      warn(
        "lock",
        `Orphan lock: its process (pid ${lock.pid}) is gone.`,
        "The next write removes it; nothing to do unless writes fail.",
      ),
    );
  else
    checks.push(
      fail(
        "lock",
        lock.status === "foreign"
          ? `The plan is locked from another machine (${lock.host}, pid ${lock.pid}); Konsora cannot tell whether it is alive, so writes wait and time out.`
          : "The plan's lock file is not one Konsora wrote, so writes wait and time out.",
        "If no write is running, delete .konsora/tasks.json.lock.",
      ),
    );

  const temps = await strayTempFiles(root);
  if (temps.length)
    checks.push(
      warn(
        "temp",
        `${temps.length} leftover temporary file(s) in .konsora/ from an interrupted write.`,
        "Delete them when no write is running; they are never read.",
      ),
    );

  const skill = await skillState(root).catch(() => "unreadable" as const);
  if (skill === "unreadable")
    checks.push(
      fail("skill", `${SKILL_PATH} cannot be read.`, `Check the permissions of ${SKILL_PATH}.`),
    );
  else if (!skill)
    checks.push(
      warn(
        "skill",
        `No agent protocol skill at ${SKILL_PATH}.`,
        "Run `konsora skill` (skip this if you do not use Claude Code here).",
      ),
    );
  else if (skill.installed < skill.current)
    checks.push(
      warn(
        "skill",
        `The skill is older than this Konsora (v${skill.installed}, current v${skill.current}).`,
        skill.modified
          ? "It was edited by hand: review your changes, then run `konsora skill --update --force`."
          : "Run `konsora skill --update`.",
      ),
    );
  else
    checks.push(
      ok(
        "skill",
        `Skill v${skill.installed} installed${skill.modified ? " (edited by hand)" : ""}.`,
      ),
    );

  checks.push(await mcpCheck(root, env));
  return checks;
}

/** Reads the daemon's state; the token is only used for the request, never returned. */
async function liveDaemon(env: NodeJS.ProcessEnv): Promise<DaemonCheck> {
  const lib = await import("@konsora/daemon");
  const info = await lib.findDaemon(lib.dataDir(env));
  if (!info) return { running: false };
  try {
    const response = await fetch(`${info.url}/api/health`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(2000),
    });
    const body = (await response.json()) as { version?: string };
    if (!response.ok || typeof body.version !== "string") throw new Error("bad answer");
    return { running: true, answers: true, version: body.version, stale: lib.daemonIsStale(info) };
  } catch {
    return { running: true, answers: false, pid: info.pid };
  }
}

function daemonCheck(state: DaemonCheck): Check {
  if (!state.running)
    return ok("daemon", "The daemon is not running (`konsora ui` starts it when you need it).");
  if (!state.answers)
    return fail(
      "daemon",
      `The daemon's process (pid ${state.pid}) is alive but does not answer.`,
      "Stop it with `konsora ui --stop` and start it again with `konsora ui`.",
    );
  if (state.stale)
    return warn(
      "daemon",
      `The daemon (version ${state.version}) runs code older than this checkout.`,
      "Run `konsora ui` (it restarts it) or `konsora ui --restart`.",
    );
  return ok("daemon", `The daemon is running, version ${state.version}.`);
}

export async function doctorChecks(
  io: Io,
  root: string | null,
  deps: DoctorDeps = {},
): Promise<Check[]> {
  const node = deps.nodeVersion ?? process.versions.node;
  const checks: Check[] = [
    newerOrEqual(node, MIN_NODE)
      ? ok("node", `Node ${node} (needs ${MIN_NODE} or newer).`)
      : fail(
          "node",
          `Node ${node} is too old: Konsora needs ${MIN_NODE} or newer to run TypeScript directly.`,
          `Install Node ${MIN_NODE} or newer (e.g. \`nvm install 22\`).`,
        ),
  ];
  if (root) checks.push(...(await projectChecks(root, io.env)));
  else
    checks.push(
      fail(
        "plan",
        "No .konsora/ folder here or in any parent folder.",
        "Run `konsora init` in your project folder, or pass --root <dir>.",
      ),
    );
  checks.push(
    onPath("claude", io.env)
      ? ok("claude", "`claude` is on PATH (the AI panel and `konsora plan` use it).")
      : warn(
          "claude",
          "No `claude` command on PATH: the AI panel and `konsora plan` will not work.",
          "Install Claude Code and log in with `claude` (skip this if you do not plan with AI).",
        ),
  );
  checks.push(daemonCheck(await (deps.daemon ?? (() => liveDaemon(io.env)))()));
  return checks;
}

const LABEL: Record<CheckStatus, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };

export function doctorText(checks: readonly Check[]): string {
  const width = Math.max(...checks.map((c) => c.id.length));
  const lines = checks.flatMap((c) => [
    `${LABEL[c.status]}  ${c.id.padEnd(width)}  ${c.message}`,
    ...(c.hint ? [`${"".padEnd(width + 8)}Hint: ${c.hint}`] : []),
  ]);
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const total = failed
    ? `${failed} problem(s) to fix${warned ? `, ${warned} warning(s)` : ""}.`
    : warned
      ? `Everything Konsora needs works; ${warned} warning(s).`
      : "Everything works.";
  return `${lines.join("\n")}\n\n${total}\n`;
}

export function registerDoctor(
  program: Command,
  io: Io,
  rootOption: () => string | undefined,
  deps: DoctorDeps = {},
) {
  program
    .command("doctor")
    .description(
      "check this project's Konsora setup: Node, plan, lock, skill, .mcp.json, claude and the daemon (writes nothing)",
    )
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      const checks = await doctorChecks(io, findRoot(io.cwd, rootOption(), io.env), deps);
      const ok = !checks.some((c) => c.status === "fail");
      if (opts.json) json(io, { ok, checks });
      else io.stdout(doctorText(checks));
      if (!ok) throw new CliError("", undefined, EXIT.failure);
    });
}
