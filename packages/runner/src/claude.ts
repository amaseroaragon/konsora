/**
 * Claude Code adapter (docs/arquitectura.md §5): a direct spawn of the user's `claude` in print
 * mode with stream-json in and out.
 *
 * - Never `--dangerously-*`, `--bare` (it would skip the subscription login) nor
 *   `bypassPermissions`. The `default` profile is `acceptEdits` plus an explicit `--allowedTools`
 *   list; anything else goes to Konsora's `permission` MCP tool, and so to the human.
 * - Only Konsora's MCP server (in run mode) is loaded (`--strict-mcp-config`): the agent sees
 *   the plan through it alone. Its config, with the run token, is a 0600 file in the run's
 *   private folder, never in the project, and is removed when the process ends.
 * - The child's environment is the user's minus every `KONSORA_*` variable (no daemon token).
 * - The prompt goes in as a stream-json user message and stdin stays open, so answers can follow
 *   in the same session; `claude` exits once its input is closed (`endInput`).
 */
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { createInterface } from "node:readline";
import {
  DEFAULT_PROFILE_COMMANDS,
  EffortSchema,
  READONLY_PROFILE,
  READONLY_PROFILE_COMMANDS,
} from "@konsora/core";
import {
  AdapterError,
  type AgentAdapter,
  type DetectResult,
  EventQueue,
  type ModelInfo,
  type RateLimitWindow,
  type RunEvent,
  type RunExit,
  type RunHandle,
  type RunIO,
  type RunSpec,
} from "./adapter.ts";
import { readClaudeUsage, UsageUnsupportedError } from "./claude-usage.ts";
import { agentEnv } from "./env.ts";
import { readVersion } from "./version.ts";

export const MCP_CONFIG_FILE = "claude-mcp.json";
export const PERMISSION_TOOL = "mcp__konsora__permission";
const KILL_GRACE_MS = 5000;

// ── Arguments and environment ────────────────────────────────────────────────

/** Tools the `default` profile allows without asking (docs/arquitectura.md, "Perfiles"). */
const DEFAULT_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "NotebookEdit",
  "TodoWrite",
  "mcp__konsora",
  // `native` commands get no rule: Claude Code allows them itself and a rule would skip its
  // check of their options (`rg --pre`, `sed -n 'w file'`).
  ...DEFAULT_PROFILE_COMMANDS.filter(({ native }) => !native).map(({ command, prefix }) =>
    prefix ? `Bash(${command}:*)` : `Bash(${command})`,
  ),
];

/**
 * The `readonly` profile (review runs, RUN-29): reading tools, Konsora's MCP and read-only git
 * commands. Every tool that writes files is disallowed outright, and any other command is denied
 * by the run's permission tool without asking the human.
 */
const READONLY_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "TodoWrite",
  "mcp__konsora",
  ...READONLY_PROFILE_COMMANDS.map(({ command, prefix }) =>
    prefix ? `Bash(${command}:*)` : `Bash(${command})`,
  ),
];

/** Tools a `readonly` run never gets (`--disallowedTools`). */
export const READONLY_DISALLOWED_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

const PROFILES = ["default", READONLY_PROFILE];

function profileOf(spec: Pick<RunSpec, "agent">): string {
  const profile = spec.agent.permissions ?? "default";
  if (!PROFILES.includes(profile)) {
    throw new AdapterError(
      "unsupported_profile",
      `Permission profile "${profile}" is not available for Claude; use ${PROFILES.join(" or ")}`,
    );
  }
  return profile;
}

/** `--allowedTools` for a permission profile: `default` or `readonly`. */
export function claudeAllowedTools(spec: Pick<RunSpec, "agent" | "checks">): string[] {
  if (profileOf(spec) === READONLY_PROFILE) return [...READONLY_TOOLS];
  const checks = (spec.checks ?? [])
    .map((check) => check.run.trim())
    // A rule cannot hold these; such checks still run, the agent just has to ask first.
    .filter((run) => run && !/[,()\n\r]/.test(run))
    .map((run) => `Bash(${run})`);
  return [...new Set([...DEFAULT_TOOLS, ...checks])];
}

export function claudeArgs(spec: RunSpec, mcpConfigPath: string): string[] {
  const { model, effort } = spec.agent;
  if (model.startsWith("-")) throw new AdapterError("invalid_spec", `Invalid model "${model}"`);
  if (spec.resume?.startsWith("-")) {
    throw new AdapterError("invalid_spec", "Invalid session id to resume");
  }
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
  ];
  if (effort) args.push("--effort", EffortSchema.parse(effort));
  const readonly = profileOf(spec) === READONLY_PROFILE;
  args.push(
    "--permission-mode",
    readonly ? "default" : "acceptEdits",
    "--allowedTools",
    claudeAllowedTools(spec).join(","),
    ...(readonly ? ["--disallowedTools", READONLY_DISALLOWED_TOOLS.join(",")] : []),
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigPath,
    "--permission-prompt-tool",
    PERMISSION_TOOL,
  );
  if (spec.resume) args.push("--resume", spec.resume);
  return args;
}

/** The user's environment without Konsora's own variables (tokens, run ids, roots). */
export function claudeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return agentEnv(env);
}

export function claudeMcpConfig(spec: RunSpec): string {
  return `${JSON.stringify(
    { mcpServers: { konsora: { type: "stdio", ...spec.mcp } } },
    null,
    2,
  )}\n`;
}

export function userMessage(text: string): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;
}

// ── Output normalization ─────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const SUMMARY_MAX = 200;

function clip(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
}

/**
 * Turns Claude Code's stream-json lines into `RunEvent`s. Stateful (pairs tool starts with their
 * results) and pure: it never throws on bad input, it reports it.
 */
export class ClaudeNormalizer {
  readonly #cwd: string;
  readonly #tools = new Map<string, { name: string; input: Json }>();
  /** The latest assistant text: final if a `result` follows it. */
  #pendingText: string | null = null;
  #session: string | undefined;
  #lastResult: { ok: boolean; text?: string } | null = null;
  #malformed = false;
  /** The API error just reported, so the `result` that repeats it is not reported twice. */
  #apiError: string | null = null;

  constructor(cwd: string) {
    this.#cwd = cwd;
  }

  get session(): string | undefined {
    return this.#session;
  }

  push(line: string): RunEvent[] {
    if (line.trim() === "") return [];
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      value = undefined;
    }
    if (!isObject(value)) {
      this.#malformed = true;
      return [
        ...this.#flush(false),
        {
          t: "error",
          message: "Claude Code wrote a line that is not a JSON object",
          retryable: false,
        },
      ];
    }
    const session = str(value.session_id);
    if (session) this.#session = session;
    switch (value.type) {
      case "system":
        return value.subtype === "init"
          ? [
              ...this.#flush(false),
              {
                t: "started",
                ...(session ? { session } : {}),
                model: str(value.model) ?? "unknown",
              },
            ]
          : [];
      case "assistant":
        return this.#assistant(value);
      case "user":
        return this.#user(value);
      case "rate_limit_event":
        return this.#rateLimit(value);
      case "result":
        return this.#result(value);
      default:
        return [];
    }
  }

  /**
   * Call once the process has exited (`null`: it never started). Returns the closing events,
   * ending with `finished`.
   */
  end(exit: RunExit | null, stderrTail = ""): RunEvent[] {
    const events = this.#flush(false);
    const clean = exit !== null && exit.code === 0 && exit.signal === null;
    if (exit && !clean) {
      const how = exit.signal ? `was stopped by ${exit.signal}` : `exited with code ${exit.code}`;
      const detail = stderrTail.trim() ? `: ${clip(stderrTail)}` : "";
      events.push({ t: "error", message: `Claude Code ${how}${detail}`, retryable: false });
    } else if (exit && !this.#lastResult) {
      events.push({ t: "error", message: "Claude Code ended without a result", retryable: false });
    }
    const ok = clean && !this.#malformed && this.#lastResult?.ok === true;
    const summary = this.#lastResult?.text;
    events.push({ t: "finished", ok, ...(summary ? { summary } : {}) });
    return events;
  }

  #flush(final: boolean): RunEvent[] {
    if (this.#pendingText === null) return [];
    const text = this.#pendingText;
    this.#pendingText = null;
    return [{ t: "message", text, final }];
  }

  #assistant(value: Json): RunEvent[] {
    const message = isObject(value.message) ? value.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    if (value.error !== undefined && value.error !== null) {
      const text = content
        .map((block) => (isObject(block) ? (str(block.text) ?? "") : ""))
        .join(" ")
        .trim();
      const status = num(value.api_error_status);
      const message = text || `Claude Code API error (${String(value.error)})`;
      this.#apiError = message;
      return [
        ...this.#flush(false),
        {
          t: "error",
          message,
          retryable: status === 429 || (status !== undefined && status >= 500),
        },
      ];
    }
    const events: RunEvent[] = [];
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === "text") {
        const text = str(block.text)?.trim();
        if (!text) continue;
        events.push(...this.#flush(false));
        this.#pendingText = text;
      } else if (block.type === "tool_use") {
        const id = str(block.id);
        const name = str(block.name) ?? "unknown";
        const input = isObject(block.input) ? block.input : {};
        if (id) this.#tools.set(id, { name, input });
        events.push(...this.#flush(false), {
          t: "tool",
          phase: "start",
          ...(id ? { id } : {}),
          name,
          summary: this.#describe(name, input),
        });
      }
    }
    return events;
  }

  #user(value: Json): RunEvent[] {
    const message = isObject(value.message) ? value.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    const events: RunEvent[] = [];
    for (const block of content) {
      if (!isObject(block) || block.type !== "tool_result") continue;
      const id = str(block.tool_use_id);
      const tool = id ? this.#tools.get(id) : undefined;
      const ok = block.is_error !== true;
      events.push(...this.#flush(false), {
        t: "tool",
        phase: "end",
        ...(id ? { id } : {}),
        name: tool?.name ?? "unknown",
        summary: clip(resultText(block.content)),
        ok,
      });
      if (ok && tool && FILE_TOOLS.has(tool.name)) {
        const path = str(tool.input.file_path) ?? str(tool.input.notebook_path);
        const result = isObject(value.tool_use_result) ? value.tool_use_result : {};
        if (path) {
          events.push({
            t: "file",
            path: this.#relative(path),
            change: tool.name === "Write" && result.type === "create" ? "add" : "modify",
          });
        }
      }
      if (id) this.#tools.delete(id);
    }
    return events;
  }

  #rateLimit(value: Json): RunEvent[] {
    const info = isObject(value.rate_limit_info) ? value.rate_limit_info : null;
    const status = info ? str(info.status) : undefined;
    if (!info || !status) return [];
    const window = str(info.rateLimitType);
    const resets = num(info.resetsAt);
    const windows: RateLimitWindow[] = [];
    const unified = isObject(info.unifiedWindows) ? info.unifiedWindows : {};
    for (const [name, raw] of Object.entries(unified)) {
      if (!isObject(raw) || !/^[a-z0-9_]{1,40}$/.test(name)) continue;
      const windowStatus = str(raw.status);
      const utilization = num(raw.utilization);
      const windowResets = num(raw.resetsAt);
      windows.push({
        window: name,
        ...(windowStatus ? { status: windowStatus } : {}),
        ...(utilization !== undefined && utilization >= 0 ? { utilization } : {}),
        ...(windowResets !== undefined ? { resets_at: windowResets } : {}),
      });
    }
    return [
      ...this.#flush(false),
      {
        t: "usage",
        rate_limits: {
          status,
          ...(window ? { window } : {}),
          ...(resets !== undefined ? { resets_at: resets } : {}),
          ...(windows.length > 0 ? { windows } : {}),
        },
      },
    ];
  }

  #result(value: Json): RunEvent[] {
    const ok = value.is_error !== true && value.subtype === "success";
    const text = str(value.result)?.trim();
    this.#lastResult = { ok, ...(text ? { text } : {}) };
    const events: RunEvent[] = ok ? this.#flush(true) : this.#flush(false);
    const usage = isObject(value.usage) ? value.usage : {};
    const input = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
      .map((key) => num(usage[key]) ?? 0)
      .reduce((a, b) => a + b, 0);
    const output = num(usage.output_tokens);
    const cacheRead = num(usage.cache_read_input_tokens);
    const cacheWrite = num(usage.cache_creation_input_tokens);
    const details = isObject(usage.output_tokens_details) ? usage.output_tokens_details : {};
    const reasoning = num(details.thinking_tokens);
    const cost = num(value.total_cost_usd);
    events.push({
      t: "usage",
      input_tokens: input,
      ...(output !== undefined ? { output_tokens: output } : {}),
      ...(cacheRead !== undefined ? { cache_read_tokens: cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cache_write_tokens: cacheWrite } : {}),
      ...(reasoning !== undefined ? { reasoning_tokens: reasoning } : {}),
      ...(cost !== undefined ? { cost_usd: cost } : {}),
    });
    const message = text || `Claude Code turn ended with ${str(value.subtype) ?? "an error"}`;
    if (!ok && message !== this.#apiError) {
      const status = num(value.api_error_status);
      events.push({
        t: "error",
        message,
        retryable: status === 429 || (status !== undefined && status >= 500),
      });
    }
    this.#apiError = null;
    events.push({ t: "turn_end", ok });
    return events;
  }

  #describe(name: string, input: Json): string {
    const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
    if (path) return this.#relative(path);
    const text =
      str(input.description) ?? str(input.command) ?? str(input.pattern) ?? str(input.query);
    return text ? clip(text) : name;
  }

  #relative(path: string): string {
    const rel = relative(this.#cwd, path);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isObject(part) ? (str(part.text) ?? "") : ""))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

// ── The adapter ──────────────────────────────────────────────────────────────

export type ClaudeAdapterOptions = {
  /** The executable. Default `claude` (from PATH). */
  command?: string;
  /** Arguments placed before Konsora's (tests run a fake `claude` through Node). */
  prefixArgs?: string[];
  /** The environment the child's is derived from. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** How long `kill()` waits after SIGTERM before SIGKILL. Default 5000 ms. */
  killGraceMs?: number;
  /** How long `claude -p /usage` may take. Default 20 s. */
  usageTimeoutMs?: number;
};

const USAGE_TIMEOUT_MS = 20_000;

const MODELS: ModelInfo[] = [
  { id: "opus", label: "Claude Opus", efforts: [...EffortSchema.options] },
  { id: "sonnet", label: "Claude Sonnet", efforts: [...EffortSchema.options] },
  { id: "haiku", label: "Claude Haiku", efforts: [...EffortSchema.options] },
];

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): AgentAdapter {
  const command = options.command ?? "claude";
  const prefix = options.prefixArgs ?? [];
  const baseEnv = options.env ?? process.env;
  // Once `/usage` turned out not to be local, it is never run again (it could spend quota).
  let usageUnsupported: UsageUnsupportedError | null = null;
  return {
    id: "claude",
    profiles: [...PROFILES],
    // Claude Code takes full model ids (claude-opus-5-5…) besides these aliases.
    openModels: true,
    detect: () => detectClaude(command, prefix, claudeEnv(baseEnv)),
    models: () => Promise.resolve(MODELS.map((m) => ({ ...m, efforts: [...m.efforts] }))),
    rateLimits: async () => {
      if (usageUnsupported) throw usageUnsupported;
      try {
        return await readClaudeUsage(command, prefix, claudeEnv(baseEnv), {
          timeoutMs: options.usageTimeoutMs ?? USAGE_TIMEOUT_MS,
        });
      } catch (error) {
        if (error instanceof UsageUnsupportedError) usageUnsupported = error;
        throw error;
      }
    },
    start: (spec, io) =>
      startClaude(
        command,
        prefix,
        claudeEnv(baseEnv),
        spec,
        io ?? {},
        options.killGraceMs ?? KILL_GRACE_MS,
      ),
  };
}

async function detectClaude(
  command: string,
  prefix: string[],
  env: NodeJS.ProcessEnv,
): Promise<DetectResult> {
  const version = await readVersion(command, [...prefix, "--version"], env);
  return version ? { installed: true, version, authenticated: "unknown" } : { installed: false };
}

function startClaude(
  command: string,
  prefix: string[],
  env: NodeJS.ProcessEnv,
  spec: RunSpec,
  io: RunIO,
  killGraceMs: number,
): RunHandle {
  const queue = new EventQueue<RunEvent>();
  const normalizer = new ClaudeNormalizer(spec.cwd);
  const configPath = join(spec.privateDir, MCP_CONFIG_FILE);
  let child: ChildProcess | null = null;
  let inputOpen = true;
  let stderrTail = "";
  let exitedResolve: (exit: RunExit) => void = () => undefined;
  const exited = new Promise<RunExit>((resolve) => {
    exitedResolve = resolve;
  });
  let closed = false;

  /** `exit` null: the process never started (`failure` says why). */
  const finish = async (exit: RunExit | null, failure?: string) => {
    if (closed) return;
    closed = true;
    // The run token's file goes first, so it is gone by the time anyone sees `finished`.
    await rm(configPath, { force: true }).catch(() => undefined);
    if (failure) queue.push({ t: "error", message: failure, retryable: false });
    for (const event of normalizer.end(exit, stderrTail)) queue.push(event);
    queue.close();
    exitedResolve(exit ?? { code: null, signal: null });
  };
  const failEarly = (message: string) => void finish(null, message);

  const write = (text: string) => {
    if (!child?.stdin || !inputOpen || child.stdin.destroyed) return;
    child.stdin.write(text);
  };

  void (async () => {
    let args: string[];
    try {
      args = claudeArgs(spec, configPath);
      await mkdir(spec.privateDir, { recursive: true, mode: 0o700 });
      await writeFile(configPath, claudeMcpConfig(spec), { mode: 0o600 });
    } catch (error) {
      failEarly(
        error instanceof AdapterError ? error.message : "Could not prepare the Claude Code run",
      );
      return;
    }
    try {
      child = nodeSpawn(command, [...prefix, ...args], {
        cwd: spec.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true, // its own process group, so kill() reaches every descendant
      });
    } catch {
      failEarly("Claude Code could not be started; is it installed and on PATH?");
      return;
    }
    const proc = child;
    proc.on("error", (error: NodeJS.ErrnoException) => {
      const message =
        error.code === "ENOENT"
          ? "Claude Code is not installed or not on PATH"
          : "Claude Code could not be started";
      failEarly(message);
    });
    proc.stdin?.on("error", () => {
      inputOpen = false; // EPIPE: the process is gone; its exit reports why
    });
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
    write(userMessage(spec.prompt));
  })();

  const signalGroup = (signal: NodeJS.Signals) => {
    const pid = child?.pid;
    if (pid === undefined || closed) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // already gone
    }
  };

  return {
    events: queue,
    exited,
    send: (text) => write(userMessage(text)),
    endInput: () => {
      if (child?.stdin && inputOpen) child.stdin.end();
      inputOpen = false;
    },
    interrupt: async () => {
      if (child?.pid !== undefined && !closed) {
        try {
          process.kill(child.pid, "SIGINT");
        } catch {
          // already gone
        }
      }
    },
    kill: async () => {
      if (closed) return;
      signalGroup("SIGTERM");
      const timer = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), killGraceMs).unref(),
      );
      if ((await Promise.race([exited, timer])) === "timeout") signalGroup("SIGKILL");
      await exited;
    },
    sessionId: () => normalizer.session,
  };
}
