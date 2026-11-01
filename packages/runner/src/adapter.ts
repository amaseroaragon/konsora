/**
 * The contract between the runner and an agent CLI (docs/arquitectura.md §5): an adapter starts
 * one run and turns the provider's output into normalized `RunEvent`s.
 */
import type { AgentSpec, Check, Provider } from "@konsora/core";

export type RateLimitWindow = {
  /** e.g. "five_hour", "seven_day". */
  window: string;
  status?: string;
  /** Fraction of the window already used (0.68 = 68 %). */
  utilization?: number;
  /** Unix seconds. */
  resets_at?: number;
};

export type RateLimits = {
  /** The overall status, from the window that limits the account now. */
  status: string;
  /** The window `status` refers to, e.g. "five_hour". */
  window?: string;
  /** Unix seconds. */
  resets_at?: number;
  /** Every window the provider reported, with its own utilization and reset. */
  windows?: RateLimitWindow[];
};

export type RunEvent =
  | { t: "started"; session?: string; model: string }
  | { t: "message"; text: string; final: boolean }
  | {
      t: "tool";
      phase: "start" | "end";
      /** Pairs a tool's start with its end. */
      id?: string;
      name: string;
      summary: string;
      ok?: boolean;
    }
  | { t: "file"; path: string; change: "add" | "modify" | "delete" }
  | { t: "permission"; id: string; tool: string; detail: string }
  | {
      t: "usage";
      /** Every input token, cache included. */
      input_tokens?: number;
      output_tokens?: number;
      /** Part of `input_tokens` read from the prompt cache. */
      cache_read_tokens?: number;
      /** Part of `input_tokens` written to the prompt cache. */
      cache_write_tokens?: number;
      /** Part of `output_tokens` spent reasoning. */
      reasoning_tokens?: number;
      cost_usd?: number;
      rate_limits?: RateLimits;
    }
  | { t: "error"; message: string; retryable: boolean }
  /** The agent ended a turn and waits for input (more messages, or `endInput`). */
  | { t: "turn_end"; ok: boolean }
  | { t: "finished"; ok: boolean; summary?: string };

/** Konsora's MCP server in run mode, as the agent must launch it. */
export type McpServerSpec = { command: string; args: string[]; env: Record<string, string> };

export type RunSpec = {
  /** The run's prompt (`buildRunPrompt`), sent as the first user message. */
  prompt: string;
  /** The run's worktree. */
  cwd: string;
  agent: AgentSpec;
  /** The project's checks: the `default` profile lets the agent run them. */
  checks?: readonly Check[];
  /** Konsora's MCP server in run mode (with KONSORA_PROJECT/RUN/TASK and the run token). */
  mcp: McpServerSpec;
  /**
   * A private folder outside the project for this run's files (e.g. the MCP config, which holds
   * the run token). Created 0700; the adapter removes its own files when the run ends.
   */
  privateDir: string;
  /** Resume this provider session instead of starting a new one. */
  resume?: string;
};

export type RunIO = {
  /** Every raw line the provider writes, for `raw.jsonl`. */
  raw?: (line: string) => void;
};

export type RunExit = { code: number | null; signal: string | null };

export interface RunHandle {
  /** Normalized events; always ends with exactly one `finished`. */
  readonly events: AsyncIterable<RunEvent>;
  /** Resolves when the process has exited and `finished` was emitted. */
  readonly exited: Promise<RunExit>;
  /** Sends another user message (e.g. the human's answer to `ask`) in the same session. */
  send(text: string): void;
  /** Closes the agent's input: it ends after the current turn. */
  endInput(): void;
  /** Ends the current turn in an orderly way; the session is kept. */
  interrupt(): Promise<void>;
  /** SIGTERM to the process group, then SIGKILL after 5 s. */
  kill(): Promise<void>;
  /** The provider's session id once known, to resume later. */
  sessionId(): string | undefined;
}

export type DetectResult = {
  installed: boolean;
  version?: string;
  /** Konsora never reads credentials, so it usually cannot tell. */
  authenticated?: boolean | "unknown";
  /** The version Konsora's protocol types were generated for, when the adapter has them. */
  expected_version?: string;
  /** `false` when `version` is not `expected_version`: it still runs, with `warning`. */
  version_matches?: boolean;
  /** Something the human should know, without blocking runs. */
  warning?: string;
};

export type ModelInfo = { id: string; label: string; efforts: string[] };

export interface AgentAdapter {
  readonly id: Provider;
  detect(): Promise<DetectResult>;
  models(): Promise<ModelInfo[]>;
  start(spec: RunSpec, io?: RunIO): RunHandle;
}

export class AdapterError extends Error {
  readonly code: "unsupported_profile" | "invalid_spec";
  constructor(code: AdapterError["code"], message: string) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
  }
}

/** A minimal async queue: push events, iterate them once. */
export class EventQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #waiting: ((result: IteratorResult<T>) => void) | null = null;
  #closed = false;

  push(item: T): void {
    if (this.#closed) return;
    if (this.#waiting) {
      const resolve = this.#waiting;
      this.#waiting = null;
      resolve({ value: item, done: false });
    } else {
      this.#items.push(item);
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#waiting) {
      const resolve = this.#waiting;
      this.#waiting = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
    };
  }
}
