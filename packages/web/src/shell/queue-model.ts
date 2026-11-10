/**
 * What the queue view shows (UI-18), as pure functions of the daemon's queue view, so it can be
 * tested without a browser. The rules themselves (what waits and why) are core's `queueStatus`.
 */
import type { AgentSpec, QueueWait, Run } from "@konsora/core";
import { isActiveRunState } from "@konsora/core";
import { type MessageKey, t } from "../i18n/index.ts";
import { providerName } from "./limits-model.ts";

const TASK_STATE: Record<string, MessageKey> = {
  proposed: "state.proposed",
  todo: "state.todo",
  doing: "state.doing",
  review: "state.review",
  done: "state.done",
};

/** Why an entry waits, in Spanish. */
export function waitText(wait: QueueWait): string {
  switch (wait.kind) {
    case "running":
      return t("queue.wait.running", { run: wait.run });
    case "paused":
      return t("queue.wait.paused");
    case "blocked":
      return t("queue.wait.blocked", { deps: wait.deps.join(", ") });
    case "slot":
      return t("queue.wait.slot.global");
    case "busy":
      if (wait.state === "missing") return t("queue.wait.missing");
      return wait.run
        ? t("queue.wait.busy.run", { run: wait.run })
        : t("queue.wait.busy", {
            state: TASK_STATE[wait.state] ? t(TASK_STATE[wait.state] as MessageKey) : wait.state,
          });
    case "launch":
      return t("queue.wait.launch");
  }
}

/**
 * The text for an entry: a provider-limit wait names the entry's provider, and a launched run
 * that waits for the human's approval says so (it is not just running).
 */
export function entryWaitText(
  wait: QueueWait,
  agent: Pick<AgentSpec, "provider">,
  runs: readonly Pick<Run, "id" | "state">[] = [],
): string {
  if (wait.kind === "slot" && wait.limit === "provider") {
    return t("queue.wait.slot.provider", { provider: providerName(agent.provider) });
  }
  if (
    wait.kind === "running" &&
    runs.some((r) => r.id === wait.run && r.state === "waiting_approval")
  ) {
    return t("queue.wait.approval", { run: wait.run });
  }
  return waitText(wait);
}

/** Tasks whose run waits for the human: a pending approval, or a run in `waiting_approval`. */
export function awaitingApproval(
  runs: readonly Pick<Run, "task" | "state">[] | undefined,
  approvals: readonly { task: string }[] | undefined,
): Set<string> {
  return new Set([
    ...(runs ?? []).filter((run) => run.state === "waiting_approval").map((run) => run.task),
    ...(approvals ?? []).map((approval) => approval.task),
  ]);
}

export function agentText(agent: AgentSpec): string {
  return [providerName(agent.provider), agent.model, agent.effort].filter(Boolean).join(" · ");
}

/**
 * Whether a task can be queued: approved and still to do, blocked ones too (the queue waits for
 * their dependencies), and never in read-only mode.
 */
export function canQueueTask(task: { state: string }, readOnly: boolean): boolean {
  return !readOnly && task.state === "todo";
}

/** The selected tasks Queue would add: the ones `canQueueTask` allows. */
export function queueableSelection(
  ids: readonly string[],
  tasks: readonly { id: string; state: string }[],
  readOnly: boolean,
): string[] {
  const todo = new Set(tasks.filter((task) => canQueueTask(task, readOnly)).map((task) => task.id));
  return ids.filter((id) => todo.has(id));
}

/**
 * The 1-based place of a queued task in the launch order (1 launches next), or `undefined` if it is
 * not queued. The daemon's queue view lists its `status` in that order.
 */
export function queuePlace(
  status: readonly { task: string }[] | undefined,
  task: string,
): number | undefined {
  const index = (status ?? []).findIndex((entry) => entry.task === task);
  return index < 0 ? undefined : index + 1;
}

/** The project's runs that are alive (or interrupted), oldest first. */
export function activeRuns(runs: readonly Run[] | undefined): Run[] {
  return (runs ?? []).filter((run) => isActiveRunState(run.state));
}

/** The limits form's draft as text fields, and what it saves. */
export type LimitsDraft = { max: string; claude: string; codex: string };

export function limitsDraft(limits: {
  max_parallel: number;
  per_provider: Partial<Record<"claude" | "codex", number>>;
}): LimitsDraft {
  return {
    max: String(limits.max_parallel),
    claude: limits.per_provider.claude === undefined ? "" : String(limits.per_provider.claude),
    codex: limits.per_provider.codex === undefined ? "" : String(limits.per_provider.codex),
  };
}

const whole = (text: string) =>
  /^\d+$/.test(text.trim()) && Number(text) >= 1 && Number(text) <= 16;

/** The limits to save, or `null` if a field is not a whole number from 1 to 16. */
export function parseLimitsDraft(draft: LimitsDraft): {
  max_parallel: number;
  per_provider: Partial<Record<"claude" | "codex", number>>;
} | null {
  if (!whole(draft.max)) return null;
  const per_provider: Partial<Record<"claude" | "codex", number>> = {};
  for (const provider of ["claude", "codex"] as const) {
    const value = draft[provider].trim();
    if (value === "") continue;
    if (!whole(value)) return null;
    per_provider[provider] = Number(value);
  }
  return { max_parallel: Number(draft.max.trim()), per_provider };
}
