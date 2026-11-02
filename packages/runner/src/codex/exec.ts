/**
 * Codex's fallback (docs/arquitectura.md §5): `codex exec --json`, one turn per process, when
 * `codex app-server` is missing or does not speak the protocol Konsora was built for.
 *
 * - Same sandbox (`workspace-write`, no network) and the same MCP server in run mode, but no
 *   approvals: what the sandbox does not allow fails. No rate limits either.
 * - The prompt goes through stdin, never argv. The MCP server is configured with `-c` flags,
 *   which other local users can read in the process list, so it gets only the run's ids and
 *   paths: no run token nor daemon URL (they only serve Claude's `permission` tool).
 * - An answer cannot reach the live process (`acceptsInput: false`); it resumes the session with
 *   `codex exec resume <thread>` once the process has ended.
 */
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { isAbsolute, relative } from "node:path";
import { createInterface } from "node:readline";
import {
  EventQueue,
  type RunEvent,
  type RunExit,
  type RunHandle,
  type RunIO,
  type RunSpec,
} from "../adapter.ts";
import { clip, shellCommand } from "./normalize.ts";

/** Variables the exec MCP server does not get: they would show up in the process list. */
const SECRET_ENV = new Set(["KONSORA_RUN_TOKEN", "KONSORA_DAEMON_URL"]);

/** A TOML value for `-c key=value` (JSON strings and arrays of strings are valid TOML). */
function toml(value: string | readonly string[] | Record<string, string>): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
  const entries = Object.entries(value as Record<string, string>).map(
    ([key, v]) => `${JSON.stringify(key)} = ${JSON.stringify(v)}`,
  );
  return `{ ${entries.join(", ")} }`;
}

/** The MCP server's environment without what must not reach argv. */
export function execMcpEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !SECRET_ENV.has(key)));
}

export function codexExecArgs(spec: RunSpec): string[] {
  const { model, effort } = spec.agent;
  const config = [
    `mcp_servers.konsora.command=${toml(spec.mcp.command)}`,
    `mcp_servers.konsora.args=${toml(spec.mcp.args)}`,
    `mcp_servers.konsora.env=${toml(execMcpEnv(spec.mcp.env))}`,
    ...(effort ? [`model_reasoning_effort=${toml(effort)}`] : []),
    // Same sandbox as app-server (`codexSandboxPolicy`): no network whatever the user's config
    // says, plus the run's git paths so it can commit on its branch.
    "sandbox_workspace_write.network_access=false",
    ...(spec.gitWritePaths?.length
      ? [`sandbox_workspace_write.writable_roots=${toml(spec.gitWritePaths)}`]
      : []),
  ].flatMap((entry) => ["-c", entry]);
  if (spec.resume) {
    // `exec resume` has no -s/-C: the sandbox goes through config, the cwd is the process's.
    return [
      "exec",
      "resume",
      "--json",
      "-m",
      model,
      "-c",
      `sandbox_mode=${toml("workspace-write")}`,
      ...config,
      spec.resume,
      "-",
    ];
  }
  return ["exec", "--json", "-m", model, "-s", "workspace-write", "-C", spec.cwd, ...config, "-"];
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** `codex exec --json` lines → `RunEvent`s. Pure; never throws on bad input. */
export class CodexExecNormalizer {
  readonly #cwd: string;
  readonly #model: string;
  #thread: string | undefined;
  /** The latest agent message: final if the turn completes right after it. */
  #pendingText: string | null = null;
  #lastFinal: string | undefined;
  #lastTurnOk: boolean | null = null;
  #lastError: string | null = null;
  #malformed = false;

  constructor(cwd: string, model: string) {
    this.#cwd = cwd;
    this.#model = model;
  }

  get thread(): string | undefined {
    return this.#thread;
  }

  push(line: string): RunEvent[] {
    if (line.trim() === "") return [];
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      value = undefined;
    }
    if (!isObject(value) || typeof value.type !== "string") {
      this.#malformed = true;
      return [
        ...this.#flush(false),
        { t: "error", message: "Codex wrote a line that is not a JSON event", retryable: false },
      ];
    }
    switch (value.type) {
      case "thread.started": {
        const thread = str(value.thread_id);
        if (thread) this.#thread = thread;
        return [
          {
            t: "started",
            ...(thread ? { session: thread } : {}),
            model: this.#model,
            transport: "exec",
          },
        ];
      }
      case "item.started":
        return isObject(value.item) ? this.#itemStarted(value.item) : [];
      case "item.completed":
        return isObject(value.item) ? this.#itemCompleted(value.item) : [];
      case "error": {
        const message = str(value.message) ?? "Codex reported an error";
        this.#lastError = message;
        return [...this.#flush(false), { t: "error", message: clip(message), retryable: false }];
      }
      case "turn.completed":
        return this.#turnEnd(true, value);
      case "turn.failed":
        return this.#turnEnd(false, value);
      default:
        return [];
    }
  }

  end(exit: RunExit | null, stderrTail = ""): RunEvent[] {
    const events = this.#flush(false);
    const clean = exit !== null && exit.code === 0 && exit.signal === null;
    if (exit && !clean && this.#lastTurnOk !== false) {
      const how = exit.signal ? `was stopped by ${exit.signal}` : `exited with code ${exit.code}`;
      const tail = clip(stderrTail.replace(ANSI, ""));
      events.push({
        t: "error",
        message: `Codex ${how}${tail ? `: ${tail}` : ""}`,
        retryable: false,
      });
    } else if (exit && this.#lastTurnOk === null) {
      events.push({
        t: "error",
        message: "Codex ended without finishing a turn",
        retryable: false,
      });
    }
    const ok = clean && !this.#malformed && this.#lastTurnOk === true;
    const summary = this.#lastFinal;
    events.push({ t: "finished", ok, ...(summary ? { summary } : {}) });
    return events;
  }

  #flush(final: boolean): RunEvent[] {
    if (this.#pendingText === null) return [];
    const text = this.#pendingText;
    this.#pendingText = null;
    if (final) this.#lastFinal = text;
    return [{ t: "message", text, final }];
  }

  #relative(path: string): string {
    if (!isAbsolute(path)) return path;
    const rel = relative(this.#cwd, path);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
  }

  #tool(item: Json): { name: string; summary: string } | null {
    switch (item.type) {
      case "command_execution":
        return { name: "shell", summary: clip(shellCommand(str(item.command) ?? "")) || "shell" };
      case "file_change": {
        const changes = Array.isArray(item.changes) ? item.changes.filter(isObject) : [];
        const paths = changes.map((c) => this.#relative(str(c.path) ?? "")).filter(Boolean);
        return { name: "apply_patch", summary: clip(paths.join(", ")) || "apply_patch" };
      }
      case "mcp_tool_call": {
        const name = `mcp__${str(item.server) ?? "unknown"}__${str(item.tool) ?? "unknown"}`;
        return { name, summary: name };
      }
      case "web_search": {
        const query = str(item.query);
        return { name: "web_search", summary: query ? clip(query) : "web_search" };
      }
      default:
        return null;
    }
  }

  #itemStarted(item: Json): RunEvent[] {
    const tool = this.#tool(item);
    if (!tool) return [];
    const id = str(item.id);
    return [...this.#flush(false), { t: "tool", phase: "start", ...(id ? { id } : {}), ...tool }];
  }

  #itemCompleted(item: Json): RunEvent[] {
    if (item.type === "agent_message") {
      const text = str(item.text)?.trim();
      if (!text) return [];
      const events = this.#flush(false);
      this.#pendingText = text;
      return events;
    }
    if (item.type === "error") {
      const message = str(item.message);
      return message
        ? [
            ...this.#flush(false),
            { t: "error", message: `Codex warning: ${clip(message)}`, retryable: false },
          ]
        : [];
    }
    const tool = this.#tool(item);
    if (!tool) return [];
    const id = str(item.id);
    const status = str(item.status);
    let ok = status === "completed";
    let summary = tool.summary;
    const files: RunEvent[] = [];
    if (item.type === "command_execution") {
      const code = num(item.exit_code);
      ok = ok && (code === undefined || code === 0);
      const output = str(item.aggregated_output)?.trim();
      summary = output ? clip(output) : code !== undefined ? `exit ${code}` : (status ?? summary);
    } else if (item.type === "file_change" && ok) {
      const changes = Array.isArray(item.changes) ? item.changes.filter(isObject) : [];
      for (const change of changes) {
        const path = str(change.path);
        if (!path) continue;
        const kind = str(change.kind);
        files.push({
          t: "file",
          path: this.#relative(path),
          change: kind === "add" ? "add" : kind === "delete" ? "delete" : "modify",
        });
      }
    } else if (status && status !== "completed") {
      summary = status;
    }
    return [
      ...this.#flush(false),
      { t: "tool", phase: "end", ...(id ? { id } : {}), name: tool.name, summary, ok },
      ...files,
    ];
  }

  #turnEnd(ok: boolean, value: Json): RunEvent[] {
    const events = this.#flush(ok);
    const usage = isObject(value.usage) ? value.usage : null;
    if (usage) {
      const tokens = (key: string) => Math.max(0, Math.round(num(usage[key]) ?? 0));
      events.push({
        t: "usage",
        input_tokens: tokens("input_tokens"),
        output_tokens: tokens("output_tokens"),
        cache_read_tokens: tokens("cached_input_tokens"),
        cache_write_tokens: tokens("cache_write_input_tokens"),
        reasoning_tokens: tokens("reasoning_output_tokens"),
      });
    }
    if (!ok) {
      const error = isObject(value.error) ? str(value.error.message) : undefined;
      const message = error ?? "Codex turn failed";
      if (message !== this.#lastError)
        events.push({ t: "error", message: clip(message), retryable: false });
    }
    this.#lastError = null;
    this.#lastTurnOk = ok;
    events.push({ t: "turn_end", ok });
    return events;
  }
}

/** Runs one `codex exec` turn (or `exec resume`) with the prompt on stdin. */
export function startCodexExec(
  command: string,
  prefix: string[],
  env: NodeJS.ProcessEnv,
  spec: RunSpec,
  io: RunIO,
  killGraceMs: number,
): RunHandle {
  const queue = new EventQueue<RunEvent>();
  const normalizer = new CodexExecNormalizer(spec.cwd, spec.agent.model);
  let child: ChildProcess | null = null;
  let stderrTail = "";
  let closed = false;
  let exitedResolve: (exit: RunExit) => void = () => undefined;
  const exited = new Promise<RunExit>((resolve) => {
    exitedResolve = resolve;
  });
  const finish = (exit: RunExit | null, failure?: string) => {
    if (closed) return;
    closed = true;
    if (failure) queue.push({ t: "error", message: failure, retryable: false });
    for (const event of normalizer.end(exit, stderrTail)) queue.push(event);
    queue.close();
    exitedResolve(exit ?? { code: null, signal: null });
  };

  try {
    child = nodeSpawn(command, [...prefix, ...codexExecArgs(spec)], {
      cwd: spec.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // its own process group, so kill() reaches every descendant
    });
  } catch {
    queueMicrotask(() => finish(null, "Codex could not be started; is it installed and on PATH?"));
  }
  const proc = child;
  if (proc) {
    proc.on("error", (error: NodeJS.ErrnoException) => {
      finish(
        null,
        error.code === "ENOENT"
          ? "Codex is not installed or not on PATH"
          : "Codex could not be started",
      );
    });
    proc.stdin?.on("error", () => undefined); // EPIPE: the exit says why
    proc.stdin?.end(spec.prompt);
    proc.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });
    const lines = proc.stdout ? createInterface({ input: proc.stdout, crlfDelay: Infinity }) : null;
    lines?.on("line", (line) => {
      io.raw?.(line);
      for (const event of normalizer.push(line)) queue.push(event);
    });
    const stdoutDone = lines
      ? new Promise<void>((resolve) => lines.once("close", () => resolve()))
      : Promise.resolve();
    proc.on("close", (code, signal) => {
      void stdoutDone.then(() => finish({ code, signal }));
    });
  }

  const signal = (name: NodeJS.Signals, group: boolean) => {
    const pid = child?.pid;
    if (pid === undefined || closed) return;
    try {
      process.kill(group ? -pid : pid, name);
    } catch {
      // already gone
    }
  };
  return {
    events: queue,
    exited,
    acceptsInput: false,
    send: () => undefined, // never called: acceptsInput is false
    endInput: () => undefined, // its input is closed already
    interrupt: async () => signal("SIGINT", false),
    kill: async () => {
      if (closed) return;
      signal("SIGTERM", true);
      const timer = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), killGraceMs).unref(),
      );
      if ((await Promise.race([exited, timer])) === "timeout") signal("SIGKILL", true);
      await exited;
    },
    sessionId: () => normalizer.thread,
  };
}
