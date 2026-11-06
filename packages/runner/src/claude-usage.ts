/**
 * Claude Code's rate limits without a model request (DMN-06): `claude -p /usage` is a local
 * command (no turns, no cost) that prints the subscription's windows as text. Konsora runs it
 * with the user's own login, never reads credentials, and parses the text:
 *
 *   Current session: 2% used · resets Nov 7, 12:19am (UTC)
 *   Current week (all models): 83% used · resets Nov 7, 9:59am (UTC)
 *
 * `TZ=UTC` makes the reset times UTC. `--no-session-persistence` keeps the read out of the
 * user's session history, and `--strict-mcp-config` skips their MCP servers.
 * If the reply is not the local command (a version where `/usage` would reach the model), the
 * read is refused and the adapter stops trying.
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { RateLimitWindow } from "./adapter.ts";

export const USAGE_ARGS = [
  "-p",
  "/usage",
  "--output-format",
  "json",
  "--no-session-persistence",
  "--strict-mcp-config",
] as const;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const LINE =
  /^\s*Current (session|week)(?:\s*\(([^)]{1,60})\))?:\s*(\d{1,3}(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+(.+?))?\s*$/i;
const RESET =
  /^(?:([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s*)?(?:(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?\s*\((UTC|GMT|Etc\/UTC)\)$/i;

/** `session` → `five_hour`; `week` → `seven_day`, or `seven_day_<scope>` for a model's own. */
function windowName(kind: string, scope: string | undefined): string {
  if (kind.toLowerCase() === "session") return "five_hour";
  const slug = (scope ?? "")
    .toLowerCase()
    .replace(/\b(only|models?)\b/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return !slug || slug === "all" ? "seven_day" : `seven_day_${slug}`.slice(0, 40);
}

/** "Nov 7, 12:19am (UTC)" → Unix seconds (the next such moment around `now`). */
export function parseReset(text: string, now: Date): number | undefined {
  const match = RESET.exec(text.trim());
  if (!match) return undefined;
  const [, monthName, day, hour, minute, ampm] = match;
  if (!monthName && hour === undefined) return undefined;
  let h = hour !== undefined ? Number(hour) : 0;
  const m = minute !== undefined ? Number(minute) : 0;
  if (ampm) {
    if (h < 1 || h > 12) return undefined;
    h = (h % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0);
  }
  if (h > 23 || m > 59) return undefined;
  const year = now.getUTCFullYear();
  if (monthName) {
    const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
    const d = Number(day);
    if (month < 0 || d < 1 || d > 31) return undefined;
    let at = Date.UTC(year, month, d, h, m);
    // A reset is in the future; around New Year "Jan 2" means next year.
    if (at < now.getTime() - 86_400_000) at = Date.UTC(year + 1, month, d, h, m);
    return at / 1000;
  }
  let at = Date.UTC(year, now.getUTCMonth(), now.getUTCDate(), h, m);
  if (at < now.getTime()) at += 86_400_000;
  return at / 1000;
}

/** The windows in `/usage`'s text; empty if it has none (e.g. an API-key login). */
export function parseClaudeUsage(text: string, now: Date): RateLimitWindow[] {
  const windows: RateLimitWindow[] = [];
  for (const line of text.split("\n")) {
    const match = LINE.exec(line);
    if (!match) continue;
    const [, kind = "", scope, percent = "", reset] = match;
    const used = Number(percent);
    if (!Number.isFinite(used) || used > 100) continue;
    const name = windowName(kind, scope);
    if (windows.some((w) => w.window === name)) continue;
    const resets = reset ? parseReset(reset, now) : undefined;
    windows.push({
      window: name,
      utilization: used / 100,
      ...(resets !== undefined ? { resets_at: resets } : {}),
    });
  }
  return windows;
}

/** Runs `claude -p /usage` and parses it; rejects with the reason it could not. */
export function readClaudeUsage(
  command: string,
  prefix: readonly string[],
  env: NodeJS.ProcessEnv,
  options: { timeoutMs: number; now?: () => Date },
): Promise<RateLimitWindow[]> {
  return new Promise((resolve, reject) => {
    let out = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...prefix, ...USAGE_ARGS], {
        env: { ...env, TZ: "UTC" },
        cwd: tmpdir(),
        stdio: ["ignore", "pipe", "ignore"],
        timeout: options.timeoutMs,
      });
    } catch {
      reject(new Error("Claude Code could not be started; is it installed and on PATH?"));
      return;
    }
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (out.length < 256 * 1024) out += chunk;
    });
    child.on("error", () => reject(new Error("Claude Code is not installed or not on PATH")));
    child.on("close", (code, signal) => {
      if (signal) return reject(new Error("claude -p /usage did not answer in time"));
      let reply: unknown;
      try {
        reply = JSON.parse(out);
      } catch {
        return reject(new Error(`claude -p /usage exited with code ${code} and no JSON reply`));
      }
      const value = (typeof reply === "object" && reply !== null ? reply : {}) as Record<
        string,
        unknown
      >;
      if (value.local_command !== "usage" || value.num_turns !== 0) {
        return reject(new UsageUnsupportedError());
      }
      if (value.is_error === true || typeof value.result !== "string") {
        return reject(new Error("claude -p /usage reported an error"));
      }
      const windows = parseClaudeUsage(value.result, options.now?.() ?? new Date());
      if (windows.length === 0) {
        return reject(
          new Error("Claude Code's /usage shows no subscription windows (API-key login?)"),
        );
      }
      resolve(windows);
    });
  });
}

/** `/usage` is not a local command in this Claude Code: reading it could spend quota. */
export class UsageUnsupportedError extends Error {
  constructor() {
    super("This Claude Code does not answer /usage locally; Konsora will not ask it again");
    this.name = "UsageUnsupportedError";
  }
}
