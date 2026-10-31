/**
 * View model for the web UI, shaped like schema v2 (docs/esquema-tareas.md).
 * Until @konsora/core exists (CORE-01..05) the mock app derives `blocked`/`ready` here;
 * these helpers will be replaced by core's graph functions.
 */
import type { TaskState } from "../ui/index.ts";

export type Actor = "human" | `agent:${string}` | "konsora";

export type AgentSpec = { provider: "claude" | "codex"; model: string; effort: string };

export type Acceptance = { id: string; text: string; check?: string; result?: "pass" | "fail" };

export type NoteKind = "note" | "question" | "answer" | "feedback" | "summary";
export type Note = {
  id: string;
  at: string;
  by: Actor;
  kind: NoteKind;
  text: string;
  run?: string;
};

export type Group = { id: string; name: string };

export type Task = {
  id: string;
  title: string;
  state: TaskState;
  group: string;
  deps: string[];
  desc: string;
  acceptance: Acceptance[];
  agent?: AgentSpec;
  createdBy: Actor;
  notes: Note[];
};

export type RunState = "running" | "waiting_approval" | "succeeded" | "failed" | "cancelled";
export type RunEventKind =
  | "start"
  | "read"
  | "edit"
  | "bash"
  | "permission"
  | "check"
  | "message"
  | "end"
  | "error";
export type RunEvent = { at: string; kind: RunEventKind; text: string };
export type Check = { id: string; ok: boolean; detail: string };
export type DiffLine = { kind: "hunk" | "add" | "del" | "ctx"; text: string };
export type DiffFile = { path: string; added: number; removed: number; lines: DiffLine[] };

export type Run = {
  id: string;
  task: string;
  agent: AgentSpec;
  state: RunState;
  /** ISO start time; elapsed is computed live while running. */
  startedAt: string;
  durationS?: number;
  tokens?: { input: number; output: number };
  events: RunEvent[];
  checks: Check[];
  diff: DiffFile[];
  summary?: string;
  integrated?: boolean;
};

export type Project = {
  id: string;
  name: string;
  path: string;
  groups: Group[];
  tasks: Task[];
  runs: Run[];
};

export function byId(tasks: readonly Task[]): Map<string, Task> {
  return new Map(tasks.map((task) => [task.id, task]));
}

/** Unfinished dependencies of a todo task (only `done` unblocks). */
export function blockers(task: Task, index: Map<string, Task>): string[] {
  if (task.state !== "todo") return [];
  return task.deps.filter((id) => index.get(id)?.state !== "done");
}

export function isWaiting(task: Task): boolean {
  const last = [...task.notes].reverse().find((n) => n.kind === "question" || n.kind === "answer");
  return last?.kind === "question";
}

export function activeRun(task: Task, runs: readonly Run[]): Run | undefined {
  return runs.find(
    (run) => run.task === task.id && (run.state === "running" || run.state === "waiting_approval"),
  );
}

export function latestRun(task: Task, runs: readonly Run[]): Run | undefined {
  return runs
    .filter((run) => run.task === task.id)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

export function agentLabel(agent: AgentSpec): string {
  return `${agent.provider}/${agent.model}/${agent.effort}`;
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Longest-path layering for the graph view: roots at depth 0. */
export function depths(tasks: readonly Task[]): Map<string, number> {
  const index = byId(tasks);
  const memo = new Map<string, number>();
  const visit = (id: string, stack: Set<string>): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (stack.has(id)) return 0; // cycles are rejected by core; never loop here
    stack.add(id);
    const task = index.get(id);
    const depth = task
      ? Math.max(-1, ...task.deps.filter((d) => index.has(d)).map((d) => visit(d, stack))) + 1
      : 0;
    stack.delete(id);
    memo.set(id, depth);
    return depth;
  };
  for (const task of tasks) visit(task.id, new Set());
  return memo;
}
