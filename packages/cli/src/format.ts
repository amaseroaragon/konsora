/** Plain-text renderers for the CLI. English, no colors, stable column layout. */
import {
  dependentsOf,
  deriveFlags,
  indexTasks,
  type SchemaIssue,
  type Task,
  type TaskFlags,
  type TaskState,
  type TasksDocument,
  topoOrder,
} from "@konsora/core";

export const STATES: readonly TaskState[] = ["proposed", "todo", "doing", "review", "done"];

/** A task plus its derived flags: the shape of every task in `--json` output. */
export type TaskView = Task & Omit<TaskFlags, "blocked"> & { blocked: boolean };

export function views(doc: TasksDocument): TaskView[] {
  const flags = deriveFlags(doc);
  const index = indexTasks(doc);
  return topoOrder(doc).order.map((id) => {
    const task = index.get(id) as Task;
    return { ...task, ...(flags.get(id) as TaskFlags) };
  });
}

function flagText(view: TaskView): string {
  const parts: string[] = [];
  if (view.ready) parts.push("ready");
  if (view.blocked) parts.push(`blocked by ${view.blockers.join(", ")}`);
  if (view.waiting) parts.push("waiting for answer");
  if (view.yolo) parts.push("yolo");
  return parts.join("; ");
}

export function taskTable(list: readonly TaskView[]): string {
  if (list.length === 0) return "No tasks match.\n";
  const idWidth = Math.max(2, ...list.map((t) => t.id.length));
  const rows = list.map((t) => {
    const flags = flagText(t);
    return `${t.id.padEnd(idWidth)}  ${t.state.padEnd(8)}  ${t.title}${flags ? `  [${flags}]` : ""}`;
  });
  return `${"ID".padEnd(idWidth)}  ${"STATE".padEnd(8)}  TITLE\n${rows.join("\n")}\n`;
}

export function statusText(doc: TasksDocument, file: string): string {
  const list = views(doc);
  const count = (state: TaskState) => list.filter((t) => t.state === state).length;
  const section = (title: string, items: TaskView[]) =>
    items.length
      ? `\n${title}:\n${items.map((t) => `  ${t.id.padEnd(9)} ${t.title}`).join("\n")}\n`
      : "";
  return [
    `${doc.project.name} · ${file} · ${list.length} tasks in ${doc.groups.length} groups\n`,
    `  groups: ${doc.groups.map((g) => `${g.id} (${g.name})`).join(", ")}\n`,
    `\n  ${STATES.map((s) => `${s} ${count(s)}`).join("   ")}\n`,
    `  ready ${list.filter((t) => t.ready).length} · blocked ${list.filter((t) => t.blocked).length} · waiting ${list.filter((t) => t.waiting).length}\n`,
    section(
      "Waiting for an answer",
      list.filter((t) => t.waiting),
    ),
    section(
      "In review (needs a human)",
      list.filter((t) => t.state === "review"),
    ),
    section(
      "Doing",
      list.filter((t) => t.state === "doing"),
    ),
    section(
      "Ready to start",
      list.filter((t) => t.ready),
    ),
    section(
      "Proposed (needs approval)",
      list.filter((t) => t.state === "proposed"),
    ),
  ].join("");
}

export function showText(doc: TasksDocument, view: TaskView): string {
  const index = indexTasks(doc);
  const group = doc.groups.find((g) => g.id === view.group);
  const lines = [
    `${view.id} · ${view.title}`,
    `state: ${view.state}${flagText(view) ? ` (${flagText(view)})` : ""}   group: ${view.group}${group ? ` (${group.name})` : ""}   rank: ${view.rank}`,
  ];
  if (view.deps?.length) {
    lines.push(
      `deps: ${view.deps.map((d) => `${d} (${index.get(d)?.state ?? "missing"})`).join(", ")}`,
    );
  }
  const dependents = dependentsOf(view.id, doc);
  if (dependents.length) lines.push(`dependents: ${dependents.join(", ")}`);
  if (view.agent) {
    lines.push(
      `agent: ${[view.agent.provider, view.agent.model, view.agent.effort].filter(Boolean).join("/")}`,
    );
  }
  if (view.labels?.length) lines.push(`labels: ${view.labels.join(", ")}`);
  if (view.difficulty) lines.push(`difficulty: ${view.difficulty}`);
  lines.push(`created: ${view.created.at} by ${view.created.by} · updated: ${view.updated_at}`);
  if (view.desc) lines.push("", view.desc);
  if (view.acceptance?.length) {
    lines.push("", "Acceptance:");
    for (const a of view.acceptance)
      lines.push(`  ${a.id.padEnd(4)} ${a.text}${a.check ? `  [check: ${a.check}]` : ""}`);
  }
  if (view.notes?.length) {
    lines.push("", "Notes:");
    for (const n of view.notes) {
      lines.push(
        `  ${n.at.replace("T", " ").slice(0, 16)}  ${n.by}  ${n.kind}${n.run ? ` (${n.run})` : ""}`,
      );
      for (const line of n.text.split("\n")) lines.push(`      ${line}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function issuesText(issues: readonly SchemaIssue[]): string {
  return `${issues.map((i) => `  ${i.path || "/"}  ${i.code}  ${i.message}`).join("\n")}\n`;
}
