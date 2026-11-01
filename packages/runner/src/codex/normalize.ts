/**
 * Turns `codex app-server` notifications into `RunEvent`s (docs/arquitectura.md §5, Codex).
 * Stateful (turns, usage totals, the last rate-limit snapshot) and pure: it never throws on bad
 * input, it reports it. The adapter feeds it the server's notifications and tells it about the
 * replies to its own requests (`threadStarted`, `requestFailed`).
 */
import { isAbsolute, relative } from "node:path";
import type { RateLimitWindow, RunEvent, RunExit } from "../adapter.ts";
import type { ServerNotification, v2 } from "./protocol/index.ts";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const SUMMARY_MAX = 200;
/** Terminal colour codes: Codex logs to stderr in colour. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export function clip(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
}

/** `/bin/bash -lc 'cat notes.txt'` → `cat notes.txt`: the wrapper Codex adds says nothing. */
export function shellCommand(command: string): string {
  const match = /^\/bin\/(?:ba|z)?sh -l?c (?:'([\s\S]*)'|"([\s\S]*)")$/.exec(command.trim());
  return match ? (match[1] ?? (match[2] as string).replace(/\\(["\\$`])/g, "$1")) : command;
}

/** The window's name from its length: Codex reports minutes, not names. */
function windowName(minutes: number | undefined, fallback: string): string {
  if (minutes === 300) return "five_hour";
  if (minutes === 10080) return "seven_day";
  if (minutes !== undefined && Number.isInteger(minutes) && minutes > 0)
    return `window_${minutes}m`;
  return fallback;
}

type Usage = Pick<
  v2.TokenUsageBreakdown,
  | "inputTokens"
  | "cachedInputTokens"
  | "cacheWriteInputTokens"
  | "outputTokens"
  | "reasoningOutputTokens"
>;
const ZERO: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

export class CodexNormalizer {
  readonly #cwd: string;
  #thread: string | undefined;
  #turn: string | undefined;
  /** The thread's cumulative usage, and what was already reported at the end of earlier turns. */
  #total: Usage = ZERO;
  #reported: Usage = ZERO;
  #lastLimits = "";
  #lastFinal: string | undefined;
  #lastTurnOk: boolean | null = null;
  /** The last `error` notification, so the failed turn that repeats it is not reported twice. */
  #lastError: string | null = null;
  #malformed = false;
  #failed = false;
  /** The paths of each file change in progress, for its approval request. */
  readonly #filePaths = new Map<string, string[]>();

  constructor(cwd: string) {
    this.#cwd = cwd;
  }

  get thread(): string | undefined {
    return this.#thread;
  }

  /** The turn in progress, if any. */
  get turn(): string | undefined {
    return this.#turn;
  }

  /** The reply to `thread/start` or `thread/resume`. */
  threadStarted(result: unknown): RunEvent[] {
    const value = isObject(result) ? result : {};
    const thread = isObject(value.thread) ? str(value.thread.id) : undefined;
    if (!thread) return this.requestFailed("Codex did not return a thread");
    this.#thread = thread;
    return [{ t: "started", session: thread, model: str(value.model) ?? "unknown" }];
  }

  /** The reply to `turn/start`: the turn is known before `turn/started` arrives. */
  turnStarted(result: unknown): void {
    const turn = isObject(result) && isObject(result.turn) ? str(result.turn.id) : undefined;
    if (turn) this.#turn = turn;
  }

  /** A request of Konsora's failed: the run cannot go on. */
  requestFailed(message: string): RunEvent[] {
    this.#failed = true;
    return [{ t: "error", message, retryable: false }];
  }

  /** A line that is not JSON-RPC. */
  malformed(): RunEvent[] {
    this.#malformed = true;
    return [
      { t: "error", message: "Codex wrote a line that is not a JSON object", retryable: false },
    ];
  }

  notification(message: ServerNotification | { method: string; params?: unknown }): RunEvent[] {
    const params = isObject(message.params) ? message.params : {};
    switch (message.method) {
      case "turn/started": {
        const turn = isObject(params.turn) ? str(params.turn.id) : undefined;
        if (turn) this.#turn = turn;
        return [];
      }
      case "item/started":
        return isObject(params.item) ? this.#itemStarted(params.item) : [];
      case "item/completed":
        return isObject(params.item) ? this.#itemCompleted(params.item) : [];
      case "thread/tokenUsage/updated":
        this.#tokenUsage(params);
        return [];
      case "account/rateLimits/updated":
        return this.#rateLimits(params);
      case "error":
        return this.#error(params);
      case "turn/completed":
        return this.#turnCompleted(params);
      case "configWarning":
      case "warning": {
        const text = str(params.summary) ?? str(params.message);
        return text
          ? [{ t: "error", message: `Codex warning: ${clip(text)}`, retryable: false }]
          : [];
      }
      default:
        return [];
    }
  }

  /** Call once the process has exited (`null`: it never started). Ends with `finished`. */
  end(exit: RunExit | null, stderrTail = ""): RunEvent[] {
    const events: RunEvent[] = [];
    const clean = exit !== null && exit.code === 0 && exit.signal === null;
    if (exit && !clean) {
      const how = exit.signal ? `was stopped by ${exit.signal}` : `exited with code ${exit.code}`;
      const tail = clip(stderrTail.replace(ANSI, ""));
      events.push({
        t: "error",
        message: `Codex ${how}${tail ? `: ${tail}` : ""}`,
        retryable: false,
      });
    } else if (exit && this.#lastTurnOk === null && !this.#failed) {
      events.push({
        t: "error",
        message: "Codex ended without finishing a turn",
        retryable: false,
      });
    }
    const ok = clean && !this.#malformed && !this.#failed && this.#lastTurnOk === true;
    const summary = this.#lastFinal;
    events.push({ t: "finished", ok, ...(summary ? { summary } : {}) });
    return events;
  }

  #relative(path: string): string {
    if (!isAbsolute(path)) return path;
    const rel = relative(this.#cwd, path);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
  }

  #tool(item: Json): { name: string; summary: string } | null {
    switch (item.type) {
      case "commandExecution":
        return { name: "shell", summary: clip(shellCommand(str(item.command) ?? "")) || "shell" };
      case "fileChange": {
        const changes = Array.isArray(item.changes) ? item.changes.filter(isObject) : [];
        const paths = changes.map((c) => this.#relative(str(c.path) ?? "")).filter(Boolean);
        return { name: "apply_patch", summary: clip(paths.join(", ")) || "apply_patch" };
      }
      case "mcpToolCall": {
        const name = `mcp__${str(item.server) ?? "unknown"}__${str(item.tool) ?? "unknown"}`;
        return { name, summary: name };
      }
      case "dynamicToolCall": {
        const name = str(item.tool) ?? str(item.name) ?? "tool";
        return { name, summary: name };
      }
      case "webSearch": {
        const query = str(item.query);
        return { name: "web_search", summary: query ? clip(query) : "web_search" };
      }
      default:
        return null;
    }
  }

  /** The worktree-relative paths of a file change that started, if known. */
  filePaths(itemId: string): string[] {
    return [...(this.#filePaths.get(itemId) ?? [])];
  }

  #itemStarted(item: Json): RunEvent[] {
    const tool = this.#tool(item);
    if (!tool) return [];
    const id = str(item.id);
    if (id && item.type === "fileChange") {
      const changes = Array.isArray(item.changes) ? item.changes.filter(isObject) : [];
      this.#filePaths.set(
        id,
        changes.map((c) => this.#relative(str(c.path) ?? "")).filter(Boolean),
      );
    }
    return [{ t: "tool", phase: "start", ...(id ? { id } : {}), ...tool }];
  }

  #itemCompleted(item: Json): RunEvent[] {
    if (item.type === "agentMessage") {
      const text = str(item.text)?.trim();
      if (!text) return [];
      const final = item.phase === "final_answer";
      if (final) this.#lastFinal = text;
      return [{ t: "message", text, final }];
    }
    const tool = this.#tool(item);
    if (!tool) return [];
    const id = str(item.id);
    if (id) this.#filePaths.delete(id);
    const status = str(item.status);
    const events: RunEvent[] = [];
    let ok = status === "completed";
    let summary = tool.summary;
    if (item.type === "commandExecution") {
      const code = num(item.exitCode);
      ok = ok && (code === undefined || code === 0);
      const output = str(item.aggregatedOutput)?.trim();
      summary =
        status === "declined"
          ? "declined"
          : output
            ? clip(output)
            : code !== undefined
              ? `exit ${code}`
              : (status ?? summary);
    } else if (item.type === "fileChange" && ok) {
      const changes = Array.isArray(item.changes) ? item.changes.filter(isObject) : [];
      for (const change of changes) {
        const path = str(change.path);
        const kind = isObject(change.kind) ? str(change.kind.type) : undefined;
        if (!path) continue;
        const movedTo = isObject(change.kind) ? str(change.kind.move_path) : undefined;
        if (kind === "update" && movedTo) {
          events.push({ t: "file", path: this.#relative(path), change: "delete" });
          events.push({ t: "file", path: this.#relative(movedTo), change: "add" });
        } else {
          const kindMap = { add: "add", delete: "delete" } as const;
          const change = kind === "add" || kind === "delete" ? kindMap[kind] : "modify";
          events.push({ t: "file", path: this.#relative(path), change });
        }
      }
    } else if (status && status !== "completed") {
      summary = status;
    }
    return [
      { t: "tool", phase: "end", ...(id ? { id } : {}), name: tool.name, summary, ok },
      ...events,
    ];
  }

  #tokenUsage(params: Json): void {
    const usage = isObject(params.tokenUsage) ? params.tokenUsage : {};
    const total = isObject(usage.total) ? usage.total : null;
    if (!total) return;
    const read = (key: keyof Usage) => Math.max(0, Math.round(num(total[key]) ?? 0));
    this.#total = {
      inputTokens: read("inputTokens"),
      cachedInputTokens: read("cachedInputTokens"),
      cacheWriteInputTokens: read("cacheWriteInputTokens"),
      outputTokens: read("outputTokens"),
      reasoningOutputTokens: read("reasoningOutputTokens"),
    };
  }

  /** The turn's usage: the growth of the thread's totals since the last turn ended. */
  #turnUsage(): RunEvent[] {
    const total = this.#total;
    const before = this.#reported;
    const delta = (key: keyof Usage) => Math.max(0, total[key] - before[key]);
    this.#reported = total;
    return [
      {
        t: "usage",
        input_tokens: delta("inputTokens"),
        output_tokens: delta("outputTokens"),
        cache_read_tokens: delta("cachedInputTokens"),
        cache_write_tokens: delta("cacheWriteInputTokens"),
        reasoning_tokens: delta("reasoningOutputTokens"),
      },
    ];
  }

  #rateLimits(params: Json): RunEvent[] {
    const snapshot = isObject(params.rateLimits) ? params.rateLimits : null;
    if (!snapshot) return [];
    const windows: RateLimitWindow[] = [];
    for (const [slot, fallback] of [
      ["primary", "primary"],
      ["secondary", "secondary"],
    ] as const) {
      const raw = snapshot[slot];
      if (!isObject(raw)) continue;
      const used = num(raw.usedPercent);
      const resets = num(raw.resetsAt);
      windows.push({
        window: windowName(num(raw.windowDurationMins), fallback),
        ...(used !== undefined && used >= 0 ? { utilization: used / 100 } : {}),
        ...(resets !== undefined ? { resets_at: resets } : {}),
      });
    }
    if (windows.length === 0) return [];
    const reached = str(snapshot.rateLimitReachedType);
    const status = reached ? "rejected" : "allowed";
    for (const window of windows) window.status = status;
    // Codex repeats the snapshot after every request; only changes are worth an event.
    // Its `resetsAt` jitters by a second between snapshots, so it is compared to the minute.
    const key = JSON.stringify([
      status,
      windows.map((w) => [w.window, w.utilization, Math.round((w.resets_at ?? 0) / 60)]),
    ]);
    if (key === this.#lastLimits) return [];
    this.#lastLimits = key;
    return [{ t: "usage", rate_limits: { status, windows } }];
  }

  #error(params: Json): RunEvent[] {
    const error = isObject(params.error) ? params.error : {};
    const message = str(error.message) ?? "Codex reported an error";
    const retryable = params.willRetry === true;
    if (!retryable) this.#lastError = message;
    return [{ t: "error", message: clip(message), retryable }];
  }

  #turnCompleted(params: Json): RunEvent[] {
    const turn = isObject(params.turn) ? params.turn : {};
    const status = str(turn.status);
    const ok = status === "completed";
    const events = this.#turnUsage();
    if (status === "failed") {
      const error = isObject(turn.error) ? str(turn.error.message) : undefined;
      const message = error ?? "Codex turn failed";
      if (message !== this.#lastError)
        events.push({ t: "error", message: clip(message), retryable: false });
    }
    this.#lastError = null;
    this.#lastTurnOk = ok;
    this.#turn = undefined;
    events.push({ t: "turn_end", ok });
    return events;
  }
}
