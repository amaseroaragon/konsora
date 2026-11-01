/**
 * Pending permission approvals of runs (MCP-04). When Claude asks to use a tool that its
 * allowed list does not cover, the MCP `permission` tool of that run forwards the request here;
 * it waits until the human decides in the UI (M6) or the wait runs out.
 *
 * Each run is registered by the runner with its own random token: the run token can only ask
 * for permissions of that run, never decide them, and the human token is never handed to a run.
 * State lives in memory: if the daemon stops, pending requests fail and the MCP denies them.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { sameToken } from "./auth.ts";

export type RunInfo = { run: string; project: string; task: string };

export type PermissionRequest = {
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id?: string | undefined;
};

export type ApprovalState = "pending" | "allowed" | "denied" | "expired";

export type Approval = RunInfo & {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  tool_use_id?: string;
  requested_at: string;
  state: ApprovalState;
  decided_at?: string;
  message?: string;
};

export type Decision = { behavior: "allow" | "deny"; message?: string };

export type ApprovalEvent =
  | { type: "permission.requested"; project: string; run: string; approval: Approval }
  | { type: "permission.resolved"; project: string; run: string; approval: Approval };

type Waiter = { approval: Approval; settle: (decision: Decision) => void };

export type ApprovalsOptions = {
  now?: () => Date;
  /** Called for every request and resolution; the daemon forwards it over the WebSocket. */
  onEvent?: (event: ApprovalEvent) => void;
};

/** Kept after resolution so the UI can show recent decisions; older ones are dropped. */
const KEEP_RESOLVED = 200;

export class Approvals {
  private readonly runs = new Map<string, RunInfo & { token: string }>();
  private readonly waiting = new Map<string, Waiter>();
  private readonly resolved: Approval[] = [];
  private readonly options: ApprovalsOptions;

  constructor(options: ApprovalsOptions = {}) {
    this.options = options;
  }

  private now() {
    return (this.options.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  /** Registers a run and returns its token (for the run's MCP, via KONSORA_RUN_TOKEN). */
  registerRun(info: RunInfo): string {
    const token = randomBytes(32).toString("hex");
    this.runs.set(info.run, { ...info, token });
    return token;
  }

  /** Forgets a run; whatever it still waits for is denied. */
  endRun(run: string) {
    this.runs.delete(run);
    for (const waiter of [...this.waiting.values()])
      if (waiter.approval.run === run) this.finish(waiter, "expired", "The run has ended.");
  }

  /** The run that `token` belongs to, if it is the token of `run`. */
  authenticate(run: string, token: string): RunInfo | undefined {
    const info = this.runs.get(run);
    if (!info || !sameToken(token, info.token)) return undefined;
    return { run: info.run, project: info.project, task: info.task };
  }

  /**
   * Records a pending approval and resolves with the human's decision, or with deny once
   * `waitMs` passes or `signal` aborts (the MCP gave up).
   */
  request(
    info: RunInfo,
    request: PermissionRequest,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<{ approval: Approval; decision: Decision }> {
    const approval: Approval = {
      ...info,
      id: `p-${randomUUID()}`,
      tool: request.tool_name,
      input: request.input,
      ...(request.tool_use_id ? { tool_use_id: request.tool_use_id } : {}),
      requested_at: this.now(),
      state: "pending",
    };
    return new Promise((resolve) => {
      const waiter: Waiter = {
        approval,
        settle: (decision) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve({ approval, decision });
        },
      };
      const timer = setTimeout(
        () => this.finish(waiter, "expired", "No decision arrived in time."),
        waitMs,
      );
      const onAbort = () => this.finish(waiter, "expired", "The request was abandoned.");
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.set(approval.id, waiter);
      this.options.onEvent?.({
        type: "permission.requested",
        project: info.project,
        run: info.run,
        approval: { ...approval },
      });
      if (signal?.aborted) onAbort();
    });
  }

  /** The human's decision on a pending approval of `run`. */
  decide(
    run: string,
    id: string,
    decision: Decision,
  ): { ok: true; approval: Approval } | { ok: false; code: "not_found" | "resolved" } {
    const waiter = this.waiting.get(id);
    if (!waiter || waiter.approval.run !== run) {
      const done = this.resolved.find((a) => a.id === id && a.run === run);
      return { ok: false, code: done ? "resolved" : "not_found" };
    }
    const state = decision.behavior === "allow" ? "allowed" : "denied";
    return { ok: true, approval: this.finish(waiter, state, decision.message) };
  }

  /** Pending approvals, oldest first. */
  pending(): Approval[] {
    return [...this.waiting.values()].map((w) => ({ ...w.approval }));
  }

  /** Denies everything still waiting (the daemon is shutting down). */
  close() {
    for (const waiter of [...this.waiting.values()])
      this.finish(waiter, "expired", "The Konsora daemon stopped.");
    this.runs.clear();
  }

  private finish(waiter: Waiter, state: Exclude<ApprovalState, "pending">, message?: string) {
    const { approval } = waiter;
    this.waiting.delete(approval.id);
    approval.state = state;
    approval.decided_at = this.now();
    if (message) approval.message = message;
    this.resolved.push(approval);
    if (this.resolved.length > KEEP_RESOLVED) this.resolved.shift();
    waiter.settle(
      state === "allowed"
        ? { behavior: "allow" }
        : { behavior: "deny", message: message ?? "Denied by the human." },
    );
    this.options.onEvent?.({
      type: "permission.resolved",
      project: approval.project,
      run: approval.run,
      approval: { ...approval },
    });
    return { ...approval };
  }
}
