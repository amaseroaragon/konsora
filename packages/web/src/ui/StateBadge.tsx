import { type MessageKey, t } from "../i18n/index.ts";

/** Stored task states (docs/esquema-tareas.md §2). */
export type TaskState = "proposed" | "todo" | "doing" | "review" | "done";
/** Derived or run-related conditions shown alongside the state. */
export type TaskFlag = "blocked" | "waiting" | "ready" | "running" | "external" | "checks";
export type BadgeKind = TaskState | TaskFlag;

export const taskStates: readonly TaskState[] = ["proposed", "todo", "doing", "review", "done"];

const labelKey: Record<BadgeKind, MessageKey> = {
  proposed: "state.proposed",
  todo: "state.todo",
  doing: "state.doing",
  review: "state.review",
  done: "state.done",
  blocked: "state.blocked",
  waiting: "state.waiting",
  ready: "state.ready",
  running: "state.running",
  external: "state.external",
  checks: "state.checks",
};

export type StateBadgeProps = {
  kind: BadgeKind;
  /** Overrides the default label, e.g. "Bloqueada · CORE-01". */
  label?: string;
};

/** Square mark + mono caps label. Kinds differ in lightness as well as hue. */
export function StateBadge({ kind, label }: StateBadgeProps) {
  return (
    <span className={`k-badge k-badge--${kind}`}>
      <span className="k-badge__mark" aria-hidden="true" />
      {label ?? t(labelKey[kind])}
    </span>
  );
}

export function stateLabel(kind: BadgeKind): string {
  return t(labelKey[kind]);
}
