/**
 * Claude Code hooks for a project (CLI-08), installed only on request (`konsora init --hooks`,
 * `konsora skill --hooks`) into the project's `.claude/settings.json`:
 *
 * - `SessionStart` runs `konsora hook session-start`, whose stdout Claude Code adds to the
 *   session's context: the plan's status, so every session starts knowing it.
 * - `Stop` runs `konsora hook stop`: when the agent ends a turn with a task of its own in progress
 *   and no question pending, it hands the agent a reminder to note, pause or finish it
 *   (`additionalContext`, which Claude Code shows as hook feedback and the agent answers once).
 *   With `stop_hook_active` (already continuing for this hook) it says nothing, so it never loops.
 *
 * Both only read the plan: they write nothing and run no agent. A missing or invalid plan never
 * breaks the session: the hook says so (session start) or stays quiet (stop), and exits 0.
 */
import { constants } from "node:fs";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join, relative } from "node:path";
import { startedBy } from "@konsora/core";
import { readTasks, tasksPath } from "@konsora/core/store";
import type { Command } from "commander";
import { statusText, views } from "./format.ts";
import { findRoot } from "./project.ts";
import { statusSkill } from "./read.ts";
import { type Io, staleHours } from "./shared.ts";
import { isOutdated, outdatedText } from "./skill.ts";

export const SETTINGS_JSON = join(".claude", "settings.json");

export const HOOK_EVENTS = ["session-start", "stop"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** The Claude Code event and the command of each Konsora hook. */
const HOOKS: Record<HookEvent, { event: "SessionStart" | "Stop"; command: string }> = {
  "session-start": { event: "SessionStart", command: "konsora hook session-start" },
  stop: { event: "Stop", command: "konsora hook stop" },
};

export type HooksInstall = "created" | "added" | "present";

type HookGroup = { matcher?: string; hooks?: { type?: string; command?: string }[] };
type Settings = Record<string, unknown> & { hooks?: Record<string, unknown> };

/**
 * Adds the Konsora hooks to `.claude/settings.json`: creates the file if missing and adds each
 * hook that is not there yet, leaving every other key and hook as it was. Refuses a file that is
 * not a JSON object (or whose `hooks` is malformed), so a hand-written file is never overwritten.
 * Writes atomically.
 */
export async function installHooks(root: string): Promise<HooksInstall> {
  const path = join(root, SETTINGS_JSON);
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const refuse = (why: string) =>
    new Error(`${SETTINGS_JSON} ${why}; left it unchanged (add the Konsora hooks by hand)`);
  let settings: Settings = {};
  if (text !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw refuse("is not valid JSON");
    }
    if (!isObject(parsed)) throw refuse("is not a JSON object");
    settings = parsed as Settings;
    if (settings.hooks !== undefined && !isObject(settings.hooks))
      throw refuse("has an invalid hooks key");
  }
  const hooks: Record<string, unknown> = { ...(settings.hooks ?? {}) };
  let added = false;
  for (const { event, command } of Object.values(HOOKS)) {
    const groups = hooks[event] ?? [];
    if (!Array.isArray(groups)) throw refuse(`has an invalid hooks.${event}`);
    const present = (groups as HookGroup[]).some(
      (group) =>
        isObject(group) &&
        Array.isArray(group.hooks) &&
        group.hooks.some((hook) => isObject(hook) && hook.command === command),
    );
    if (present) continue;
    hooks[event] = [...groups, { hooks: [{ type: "command", command, timeout: 30 }] }];
    added = true;
  }
  if (!added) return "present";
  settings.hooks = hooks;
  await mkdir(join(root, ".claude"), { recursive: true });
  const temp = `${path}.konsora-${process.pid}.tmp`;
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
  try {
    await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  return text === undefined ? "created" : "added";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function describeHooks(result: HooksInstall): string {
  if (result === "present") return `${SETTINGS_JSON} already has the Konsora hooks.\n`;
  return `${result === "created" ? "Created" : "Updated"} ${SETTINGS_JSON} with the Konsora hooks: the plan's status at session start, and a reminder when a turn ends with your task in progress.\n`;
}

/** What `konsora hook session-start` prints: Claude Code adds it to the session's context. */
async function sessionStart(io: Io, root: string | undefined): Promise<string> {
  if (!root) return "";
  const read = await readTasks(root);
  if (!read.ok)
    return read.error.code === "missing"
      ? ""
      : "Konsora: this project's plan (.konsora/tasks.json) is invalid, so it is read-only. Run `konsora check` to see why and tell the human.\n";
  const check = { now: io.now?.() ?? new Date(), hours: staleHours(io.env) };
  const skill = await statusSkill(root);
  return (
    "This project plans and tracks its work in Konsora: follow the konsora skill, read and change the plan only with the `konsora` command or the konsora MCP tools, and take work with `konsora next`. The plan now:\n\n" +
    statusText(read.document, relative(root, tasksPath(root)), check) +
    (skill && isOutdated(skill) ? outdatedText(skill) : "")
  );
}

/** What `konsora hook stop` prints: a one-time reminder for the agent, or nothing. */
async function stop(io: Io, root: string | undefined): Promise<string> {
  const input = parseInput(io.readStdin ? await io.readStdin() : "");
  if (!root || input.stop_hook_active === true) return "";
  const read = await readTasks(root);
  if (!read.ok) return "";
  const agent = `agent:${io.env.KONSORA_AGENT || "claude"}`;
  const mine = views(read.document).filter(
    (t) => t.state === "doing" && !t.waiting && startedBy(t)?.by === agent,
  );
  if (mine.length === 0) return "";
  const list = mine.map((t) => `${t.id} (${t.title})`).join(", ");
  const reminder =
    `Konsora reminder: ${list} ${mine.length === 1 ? "is" : "are"} in progress under your name. ` +
    "If you worked on it in this session, keep the plan current before you stop: finish it with a summary and evidence if it is done and verified (`konsora finish`), add a note of where it stands or pause it if you stop midway (`konsora note`, `konsora pause`), or ask the human if you need a decision (`konsora ask`). " +
    "If you did not work on it in this session, or it is already up to date, nothing is needed: just end your turn.";
  // Feedback for the agent (it reads it and goes on once), not an error for the human.
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: reminder } })}\n`;
}

function parseInput(text: string): { stop_hook_active?: unknown } {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : {};
  } catch {
    return {};
  }
}

export function registerHook(program: Command, io: Io, rootOption: () => string | undefined) {
  program
    .command("hook")
    .description(
      "run a Konsora hook for Claude Code (session-start, stop); read-only, installed with `konsora skill --hooks`",
    )
    .argument("<event>", HOOK_EVENTS.join(" or "))
    .action(async (event: string) => {
      if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
        io.stderr(`Unknown hook "${event}"; use ${HOOK_EVENTS.join(" or ")}.\n`);
        return;
      }
      // The project: --root, else the nearest .konsora/ above the folder Claude Code started in.
      const from = io.env.CLAUDE_PROJECT_DIR || io.cwd;
      let out = "";
      try {
        const root = findRoot(from, rootOption(), io.env) ?? undefined;
        out = event === "stop" ? await stop(io, root) : await sessionStart(io, root);
      } catch {
        // A hook never breaks the session.
        out = "";
      }
      io.stdout(out);
    });
}
