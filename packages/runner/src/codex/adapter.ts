/**
 * Codex adapter (docs/arquitectura.md §5): `codex app-server` over stdio, JSON-RPC without the
 * `jsonrpc` header, one JSON object per line.
 *
 * - `initialize` (clientInfo konsora) → `thread/start` (or `thread/resume`) with the worktree as
 *   cwd, sandbox `workspace-write` (no network) and approvals `on-request`, plus Konsora's MCP
 *   server in run mode through `config` → `turn/start` with the prompt. Each `send()` is another
 *   turn in the same thread; `interrupt()` is `turn/interrupt`.
 * - Never `danger-full-access`, `approvalPolicy: never` nor
 *   `--dangerously-bypass-approvals-and-sandbox`.
 * - The run's MCP variables (with the run token) travel only inside `config`, over stdin; they are
 *   never written to disk nor put in the child's environment, which is the user's minus every
 *   `KONSORA_*` variable.
 * - The server's approval requests (commands and file changes outside the sandbox) become
 *   `permission` events; `answerPermission` replies with the human's decision. If the process
 *   ends first, nothing is sent. Other requests are declined.
 */
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  AdapterError,
  type AgentAdapter,
  EventQueue,
  type ModelInfo,
  type PermissionDecision,
  type RateLimitWindow,
  type RunEvent,
  type RunExit,
  type RunHandle,
  type RunIO,
  type RunSpec,
} from "../adapter.ts";
import { agentEnv } from "../env.ts";
import { detectCodex } from "./detect.ts";
import { startCodexExec } from "./exec.ts";
import { CodexNormalizer, clip, codexRateLimits, shellCommand } from "./normalize.ts";
import type { InitializeParams, InitializeResponse, v2 } from "./protocol/index.ts";

const KILL_GRACE_MS = 5000;
const REQUEST_TIMEOUT_MS = 60_000;
const CLIENT_VERSION = "0.0.0";

// ── Parameters ───────────────────────────────────────────────────────────────

export const CODEX_SANDBOX = "workspace-write" satisfies v2.SandboxMode;
export const CODEX_APPROVAL_POLICY = "on-request" satisfies v2.AskForApproval;

export function codexInitializeParams(): InitializeParams {
  return {
    clientInfo: { name: "konsora", title: "Konsora", version: CLIENT_VERSION },
    capabilities: { experimentalApi: false, requestAttestation: false },
  };
}

function checkProfile(spec: RunSpec): void {
  const profile = spec.agent.permissions ?? "default";
  if (profile !== "default") {
    throw new AdapterError(
      "unsupported_profile",
      `Permission profile "${profile}" is not available for Codex yet; use "default"`,
    );
  }
  if (!spec.agent.model.trim()) throw new AdapterError("invalid_spec", "A Codex model is required");
}

/** `thread/start`, or `thread/resume` when the spec resumes a thread. */
export function codexThreadParams(
  spec: RunSpec,
):
  | { method: "thread/start"; params: v2.ThreadStartParams }
  | { method: "thread/resume"; params: v2.ThreadResumeParams } {
  checkProfile(spec);
  const common: v2.ThreadStartParams = {
    model: spec.agent.model,
    cwd: spec.cwd,
    sandbox: CODEX_SANDBOX,
    approvalPolicy: CODEX_APPROVAL_POLICY,
    config: {
      mcp_servers: {
        konsora: { command: spec.mcp.command, args: [...spec.mcp.args], env: { ...spec.mcp.env } },
      },
    },
  };
  return spec.resume
    ? { method: "thread/resume", params: { threadId: spec.resume, ...common } }
    : { method: "thread/start", params: common };
}

/**
 * The `default` profile's sandbox, spelled out on every turn so the user's own Codex config cannot
 * widen it: `workspace-write` over the worktree plus the run's git paths (so it can commit on its
 * branch without asking), no network, and Codex's usual temporary folders.
 */
export function codexSandboxPolicy(spec: RunSpec): v2.SandboxPolicy {
  return {
    type: "workspaceWrite",
    writableRoots: [...(spec.gitWritePaths ?? [])],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

export function codexTurnParams(thread: string, text: string, spec: RunSpec): v2.TurnStartParams {
  return {
    threadId: thread,
    input: [{ type: "text", text, text_elements: [] }],
    sandboxPolicy: codexSandboxPolicy(spec),
    ...(spec.agent.effort ? { effort: spec.agent.effort } : {}),
  };
}

// ── JSON-RPC over stdio ──────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
type RequestId = string | number;

type Peer = {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  respond(id: RequestId, result: unknown): void;
  fail(id: RequestId, code: number, message: string): void;
  /** Rejects every pending request (the process is gone). */
  close(reason: string): void;
};

class RpcError extends Error {}

function createPeer(write: (line: string) => void): Peer & { reply(message: Json): boolean } {
  let next = 0;
  const pending = new Map<
    RequestId,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }
  >();
  const settle = (id: RequestId) => {
    const entry = pending.get(id);
    if (entry?.timer) clearTimeout(entry.timer);
    pending.delete(id);
    return entry;
  };
  return {
    request(method, params, timeoutMs) {
      const id = next++;
      return new Promise((resolve, reject) => {
        const entry: { resolve: typeof resolve; reject: typeof reject; timer?: NodeJS.Timeout } = {
          resolve,
          reject,
        };
        if (timeoutMs !== undefined) {
          entry.timer = setTimeout(() => {
            settle(id);
            reject(new RpcError(`Codex did not answer ${method} in time`));
          }, timeoutMs);
          entry.timer.unref();
        }
        pending.set(id, entry);
        write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    notify(method, params) {
      write(`${JSON.stringify(params === undefined ? { method } : { method, params })}\n`);
    },
    respond(id, result) {
      write(`${JSON.stringify({ id, result })}\n`);
    },
    fail(id, code, message) {
      write(`${JSON.stringify({ id, error: { code, message } })}\n`);
    },
    close(reason) {
      for (const id of [...pending.keys()]) settle(id)?.reject(new RpcError(reason));
    },
    /** A reply to one of our requests; false if it is not one. */
    reply(message) {
      const id = message.id;
      if ((typeof id !== "number" && typeof id !== "string") || "method" in message) return false;
      const entry = settle(id);
      if (!entry) return true; // late reply to a request that timed out
      if (isObject(message.error)) {
        const text = typeof message.error.message === "string" ? message.error.message : "error";
        entry.reject(new RpcError(text));
      } else {
        entry.resolve(message.result);
      }
      return true;
    },
  };
}

/** Spawns `codex app-server` in its own process group. */
function spawnAppServer(
  command: string,
  prefix: string[],
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
): ChildProcess {
  return nodeSpawn(command, [...prefix, "app-server"], {
    ...(cwd ? { cwd } : {}),
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true, // its own process group, so kill() reaches every descendant
  });
}

// ── The adapter ──────────────────────────────────────────────────────────────

export type CodexAdapterOptions = {
  /** The executable. Default `codex` (from PATH). */
  command?: string;
  /** Arguments placed before Konsora's (tests run a fake `codex` through Node). */
  prefixArgs?: string[];
  /** The environment the child's is derived from. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** How long `kill()` waits after SIGTERM before SIGKILL. Default 5000 ms. */
  killGraceMs?: number;
  /** How long setup requests (initialize, thread, model list) may take. Default 60 s. */
  requestTimeoutMs?: number;
  /**
   * `auto` (default) uses `app-server` when it answers `initialize` as expected, else `exec`.
   * The first check is kept for the adapter's life.
   */
  transport?: "auto" | "app-server" | "exec";
};

type Choice = { transport: "app-server" } | { transport: "exec"; reason: string };

export function createCodexAdapter(options: CodexAdapterOptions = {}): AgentAdapter {
  const command = options.command ?? "codex";
  const prefix = options.prefixArgs ?? [];
  const env = agentEnv(options.env ?? process.env);
  const timeout = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const killGrace = options.killGraceMs ?? KILL_GRACE_MS;
  let choice: Promise<Choice> | null = null;
  const choose = (): Promise<Choice> => {
    const forced = options.transport ?? "auto";
    if (forced === "app-server") return Promise.resolve({ transport: "app-server" });
    if (forced === "exec") return Promise.resolve({ transport: "exec", reason: "configured" });
    choice ??= probeAppServer(command, prefix, env, timeout).then((probe) =>
      probe.ok ? { transport: "app-server" } : { transport: "exec", reason: probe.reason },
    );
    return choice;
  };
  return {
    id: "codex",
    profiles: ["default"],
    detect: async () => {
      const found = await detectCodex({ command, prefixArgs: prefix, env });
      if (!found.installed) return found;
      const chosen = await choose();
      if (chosen.transport === "app-server") return { ...found, transport: "app-server" };
      const fallback = `codex app-server is not usable (${chosen.reason}); runs use codex exec, without approvals or rate limits.`;
      return {
        ...found,
        transport: "exec",
        warning: found.warning ? `${found.warning} ${fallback}` : fallback,
      };
    },
    models: () => listCodexModels(command, prefix, env, timeout),
    rateLimits: () => readCodexRateLimits(command, prefix, env, timeout),
    start: (spec, io) =>
      deferredHandle(
        choose().then((chosen) =>
          chosen.transport === "exec"
            ? startCodexExec(command, prefix, env, spec, io ?? {}, killGrace)
            : startCodex(command, prefix, env, spec, io ?? {}, killGrace, timeout),
        ),
      ),
  };
}

/** A handle for one that is still being chosen: it forwards everything once it exists. */
function deferredHandle(pending: Promise<RunHandle>): RunHandle {
  let inner: RunHandle | null = null;
  const ready = pending.then((handle) => {
    inner = handle;
    return handle;
  });
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        yield* (await ready).events;
      },
    },
    exited: ready.then((handle) => handle.exited),
    get acceptsInput() {
      return inner?.acceptsInput ?? true;
    },
    send: (text) => void ready.then((handle) => handle.send(text)),
    endInput: () => void ready.then((handle) => handle.endInput()),
    interrupt: () => ready.then((handle) => handle.interrupt()),
    kill: () => ready.then((handle) => handle.kill()),
    sessionId: () => inner?.sessionId(),
    answerPermission: (id, decision) => inner?.answerPermission?.(id, decision),
  };
}

/** Konsora's view of `model/list`: the visible models with the efforts each one supports. */
export function codexModels(models: readonly v2.Model[]): ModelInfo[] {
  return models
    .filter((model) => !model.hidden)
    .map((model) => ({
      id: model.id,
      label: model.displayName || model.id,
      efforts: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
    }));
}

/**
 * A short `app-server` session: `initialize`, then `use`. Rejects with the reason it failed
 * (not installed, exited, no reply in time, an error reply…); the process is always closed.
 */
async function appServerSession<T>(
  command: string,
  prefix: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  use: (peer: Peer, initialized: unknown) => Promise<T>,
): Promise<T> {
  let child: ChildProcess;
  try {
    child = spawnAppServer(command, prefix, env, undefined);
  } catch {
    throw new Error("Codex could not be started; is it installed and on PATH?");
  }
  const peer = createPeer((line) => {
    if (child.stdin && !child.stdin.destroyed) child.stdin.write(line);
  });
  child.stdin?.on("error", () => undefined);
  child.stderr?.resume();
  const lines = child.stdout ? createInterface({ input: child.stdout, crlfDelay: Infinity }) : null;
  lines?.on("line", (line) => {
    try {
      const message: unknown = JSON.parse(line);
      if (isObject(message)) {
        if (peer.reply(message)) return;
        if ("id" in message && typeof message.method === "string") {
          peer.fail(message.id as RequestId, -32601, "Konsora does not handle this request");
        }
      }
    } catch {
      // not JSON: ignored here; a run reports it
    }
  });
  const gone = new Promise<never>((_, reject) => {
    child.on("error", () => reject(new Error("Codex is not installed or not on PATH")));
    child.on("close", (code) => {
      peer.close("Codex exited");
      reject(new Error(`codex app-server exited${code !== null ? ` with code ${code}` : ""}`));
    });
  });
  gone.catch(() => undefined);
  try {
    const run = async () => {
      const initialized = await peer.request("initialize", codexInitializeParams(), timeoutMs);
      peer.notify("initialized");
      return use(peer, initialized);
    };
    return await Promise.race([run(), gone]);
  } finally {
    child.stdin?.end();
    const pid = child.pid;
    setTimeout(() => {
      if (pid !== undefined && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    }, 2000).unref();
  }
}

async function listCodexModels(
  command: string,
  prefix: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ModelInfo[]> {
  try {
    return await appServerSession(command, prefix, env, timeoutMs, async (peer) => {
      const all: v2.Model[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const params: v2.ModelListParams = cursor ? { cursor } : {};
        const result = (await peer.request(
          "model/list",
          params,
          timeoutMs,
        )) as v2.ModelListResponse;
        if (!isObject(result) || !Array.isArray(result.data)) {
          throw new Error("bad model/list reply");
        }
        all.push(...result.data);
        cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
        if (!cursor) break;
      }
      return codexModels(all);
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Could not list Codex models: ${reason}`);
  }
}

/**
 * The account's rate limits from `account/rateLimits/read`: a read of the usage the backend
 * already counted, with no model request (no quota is spent).
 */
export async function readCodexRateLimits(
  command: string,
  prefix: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<RateLimitWindow[]> {
  try {
    return await appServerSession(command, prefix, env, timeoutMs, async (peer) => {
      const params: v2.GetAccountRateLimitsParams = { excludeResetCreditDetails: true };
      const result = (await peer.request("account/rateLimits/read", params, timeoutMs)) as
        | v2.GetAccountRateLimitsResponse
        | undefined;
      if (!isObject(result)) throw new Error("bad account/rateLimits/read reply");
      const byId = isObject(result.rateLimitsByLimitId) ? result.rateLimitsByLimitId : {};
      const limits = codexRateLimits(byId.codex ?? result.rateLimits);
      if (!limits) throw new Error("the reply has no rate-limit windows");
      return limits.windows;
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Could not read Codex rate limits: ${reason}`);
  }
}

/**
 * Whether `codex app-server` is there and speaks Konsora's protocol: an `initialize` whose reply
 * has the shape of the generated types. A version mismatch alone does not count (it warns).
 */
export async function probeAppServer(
  command: string,
  prefix: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await appServerSession(command, prefix, env, timeoutMs, async (_peer, initialized) => {
      const reply = initialized as Partial<InitializeResponse> | null;
      if (!isObject(reply) || typeof reply.userAgent !== "string") {
        throw new Error("its initialize reply does not match the protocol types");
      }
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "unknown error" };
  }
}

const APPROVALS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
]);

/** What an approval request asks for, as the `permission` event shows it. */
export function codexPermission(
  method: string,
  params: Json,
  filePaths: (itemId: string) => string[],
): { tool: string; detail: string; input: Record<string, unknown> } {
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const reason = text(params.reason);
  const raw = params.command;
  const command = Array.isArray(raw)
    ? raw.filter((part): part is string => typeof part === "string").join(" ")
    : text(raw);
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    const shown = command ? shellCommand(command) : undefined;
    const cwd = text(params.cwd);
    return {
      tool: "shell",
      detail: shown ? clip(shown) : (reason ?? "Run a command outside the sandbox"),
      input: {
        ...(shown ? { command: shown } : {}),
        ...(cwd ? { cwd } : {}),
        ...(reason ? { reason } : {}),
      },
    };
  }
  const itemId = text(params.itemId) ?? text(params.callId);
  const started = itemId ? filePaths(itemId) : [];
  const paths =
    started.length > 0
      ? started
      : isObject(params.fileChanges)
        ? Object.keys(params.fileChanges)
        : [];
  const grantRoot = text(params.grantRoot);
  return {
    tool: "apply_patch",
    detail:
      paths.length > 0 ? clip(paths.join(", ")) : (reason ?? "Change files outside the sandbox"),
    input: {
      ...(paths.length > 0 ? { path: paths[0], paths } : {}),
      ...(reason ? { reason } : {}),
      ...(grantRoot ? { grant_root: grantRoot } : {}),
    },
  };
}

/** The reply to an approval request, in the format of its method. */
export function codexDecision(method: string, decision: PermissionDecision): unknown {
  const allow = decision.behavior === "allow";
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return {
      decision: allow
        ? "approved"
        : { denied: { rejection: decision.message ?? "Denied by the human" } },
    };
  }
  return { decision: allow ? "accept" : "decline" };
}

function startCodex(
  command: string,
  prefix: string[],
  env: NodeJS.ProcessEnv,
  spec: RunSpec,
  io: RunIO,
  killGraceMs: number,
  timeoutMs: number,
): RunHandle {
  const queue = new EventQueue<RunEvent>();
  const normalizer = new CodexNormalizer(spec.cwd);
  let child: ChildProcess | null = null;
  let inputOpen = true;
  let stderrTail = "";
  let exitedResolve: (exit: RunExit) => void = () => undefined;
  const exited = new Promise<RunExit>((resolve) => {
    exitedResolve = resolve;
  });
  let closed = false;
  /** Messages waiting for the current turn to end. */
  const waiting: string[] = [];
  let endRequested = false;
  let ready = false;
  /** A turn was started and has not completed (its id may not be known yet). */
  let turnActive = false;
  /** Approval requests waiting for the human: permission id → its JSON-RPC request. */
  const approvals = new Map<string, { rpcId: RequestId; method: string }>();
  let approvalSeq = 0;

  const push = (events: RunEvent[]) => {
    for (const event of events) queue.push(event);
  };
  const write = (line: string) => {
    if (!child?.stdin || !inputOpen || child.stdin.destroyed) return;
    child.stdin.write(line);
  };
  const peer = createPeer(write);
  const closeInput = () => {
    if (child?.stdin && inputOpen) child.stdin.end();
    inputOpen = false;
  };

  const finish = (exit: RunExit | null, failure?: string) => {
    if (closed) return;
    closed = true;
    peer.close("Codex exited");
    approvals.clear();
    if (failure) queue.push({ t: "error", message: failure, retryable: false });
    push(normalizer.end(exit, stderrTail));
    queue.close();
    exitedResolve(exit ?? { code: null, signal: null });
  };

  /** Something Konsora asked for failed: report it and let the process end. */
  const abort = (message: string) => {
    push(normalizer.requestFailed(message));
    closeInput();
  };

  const startTurn = (text: string) => {
    const thread = normalizer.thread;
    if (!thread) return;
    turnActive = true;
    peer
      .request("turn/start", codexTurnParams(thread, text, spec), timeoutMs)
      .then((result) => normalizer.turnStarted(result))
      .catch((error: unknown) => {
        turnActive = false;
        if (!closed) abort(`Codex could not start a turn: ${(error as Error).message}`);
      });
  };

  /** After a turn: the next queued message, or the end of the input if it was asked for. */
  const afterTurn = () => {
    turnActive = false;
    const next = waiting.shift();
    if (next !== undefined) startTurn(next);
    else if (endRequested) closeInput();
  };

  const onServerRequest = (id: RequestId, method: string, params: Json) => {
    if (APPROVALS.has(method)) {
      const permission = `codex-${++approvalSeq}`;
      approvals.set(permission, { rpcId: id, method });
      const shown = codexPermission(method, params, (item) => normalizer.filePaths(item));
      queue.push({ t: "permission", id: permission, ...shown });
      return;
    }
    switch (method) {
      case "mcpServer/elicitation/request":
        peer.respond(id, { action: "decline", content: null, _meta: null });
        return;
      default:
        peer.fail(id, -32601, `Konsora does not handle ${method}`);
    }
  };

  const onLine = (line: string) => {
    io.raw?.(line);
    if (line.trim() === "") return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      message = undefined;
    }
    if (!isObject(message)) {
      push(normalizer.malformed());
      return;
    }
    if (peer.reply(message)) return;
    const method = typeof message.method === "string" ? message.method : null;
    if (!method) {
      push(normalizer.malformed());
      return;
    }
    const params = isObject(message.params) ? message.params : {};
    if ("id" in message && (typeof message.id === "number" || typeof message.id === "string")) {
      onServerRequest(message.id, method, params);
      return;
    }
    if (method === "serverRequest/resolved") {
      // Codex settled a request on its own (e.g. the turn was interrupted): nothing to answer.
      for (const [permission, request] of approvals)
        if (request.rpcId === params.requestId) approvals.delete(permission);
    }
    push(normalizer.notification({ method, params }));
    if (method === "turn/completed") afterTurn();
  };

  const setup = async () => {
    const thread = codexThreadParams(spec);
    await peer.request("initialize", codexInitializeParams(), timeoutMs);
    peer.notify("initialized");
    const result = await peer.request(thread.method, thread.params, timeoutMs);
    push(normalizer.threadStarted(result));
    if (!normalizer.thread) {
      closeInput();
      return;
    }
    ready = true;
    startTurn(spec.prompt);
  };

  try {
    codexThreadParams(spec);
  } catch (error) {
    queueMicrotask(() =>
      finish(
        null,
        error instanceof AdapterError ? error.message : "Could not prepare the Codex run",
      ),
    );
    return handle();
  }

  try {
    child = spawnAppServer(command, prefix, env, spec.cwd);
  } catch {
    queueMicrotask(() => finish(null, "Codex could not be started; is it installed and on PATH?"));
    return handle();
  }
  const proc = child;
  proc.on("error", (error: NodeJS.ErrnoException) => {
    finish(
      null,
      error.code === "ENOENT"
        ? "Codex is not installed or not on PATH"
        : "Codex could not be started",
    );
  });
  proc.stdin?.on("error", () => {
    inputOpen = false; // EPIPE: the process is gone; its exit reports why
  });
  proc.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2000);
  });
  const lines = proc.stdout ? createInterface({ input: proc.stdout, crlfDelay: Infinity }) : null;
  lines?.on("line", onLine);
  const stdoutDone = lines
    ? new Promise<void>((resolve) => lines.once("close", () => resolve()))
    : Promise.resolve();
  proc.on("close", (code, signal) => {
    void stdoutDone.then(() => finish({ code, signal }));
  });
  setup().catch((error: unknown) => {
    if (!closed) abort(`Codex could not start the session: ${(error as Error).message}`);
  });
  return handle();

  function handle(): RunHandle {
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
      send: (text) => {
        if (closed || !inputOpen) return;
        if (ready && !turnActive && waiting.length === 0) startTurn(text);
        else waiting.push(text);
      },
      endInput: () => {
        endRequested = true;
        if (!ready || (!turnActive && waiting.length === 0)) closeInput();
      },
      interrupt: async () => {
        const thread = normalizer.thread;
        const turn = normalizer.turn;
        if (closed || !thread || !turn) return;
        const params: v2.TurnInterruptParams = { threadId: thread, turnId: turn };
        await peer.request("turn/interrupt", params, timeoutMs).catch(() => undefined);
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
      sessionId: () => normalizer.thread,
      answerPermission: (id, decision) => {
        const request = approvals.get(id);
        if (!request || closed) return;
        approvals.delete(id);
        peer.respond(request.rpcId, codexDecision(request.method, decision));
      },
    };
  }
}
