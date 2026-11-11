/** Plain-text renderers for the CLI. English, no colors, stable column layout. */
import {
  blockProgress,
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

export const STATES: readonly TaskState[] = ["proposed", "todo", "doing", "done"];

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
  if (view.block) parts.push(`block ${view.block}`);
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
      "Doing",
      list.filter((t) => t.state === "doing"),
    ),
    section(
      "Ready to start",
      list.filter((t) => t.ready),
    ),
    section(
      "Ideas (proposed; anyone can promote them to todo)",
      list.filter((t) => t.state === "proposed"),
    ),
    blocksText(doc),
    templatesText(doc),
  ].join("");
}

/** The plan's blocks: branch, base, progress and whether the human can merge it. */
function blocksText(doc: TasksDocument): string {
  const blocks = doc.blocks ?? [];
  if (blocks.length === 0) return "";
  const rows = blocks.map((b) => {
    const p = blockProgress(doc, b.id);
    const status =
      p.status === "merged"
        ? `merged ${b.merged?.commit.slice(0, 12)}`
        : p.status === "ready"
          ? "ready to merge (the human merges it in the Konsora UI)"
          : "open";
    return `  ${b.id.padEnd(12)} ${b.name}  [${b.branch} → ${b.base} · ${p.done}/${p.tasks.length} done · ${status}]`;
  });
  return `\nBlocks:\n${rows.join("\n")}\n`;
}

/**
 * Where to work on a task of a block: its branch, created from the base when missing. Empty for a
 * task outside any block or in a merged one.
 */
export function branchHint(doc: TasksDocument, taskId: string): string {
  const task = doc.tasks.find((t) => t.id === taskId);
  const block = doc.blocks?.find((b) => b.id === task?.block);
  if (!block || block.merged) return "";
  return `${taskId} is in block ${block.id}: work and commit on branch ${block.branch} (git switch ${block.branch}, or git switch -c ${block.branch} ${block.base} if it does not exist yet). Leave .konsora/tasks.json out of those commits. The human merges the branch into ${block.base} when every task of the block is done.`;
}

/** The project's templates, for `propose --template <id>`. */
function templatesText(doc: TasksDocument): string {
  const templates = doc.project.templates ?? [];
  if (templates.length === 0) return "";
  const rows = templates.map((t) => {
    const details = [
      t.acceptance?.length ? `${t.acceptance.length} criteria` : undefined,
      t.labels?.length ? `labels ${t.labels.join(", ")}` : undefined,
    ].filter(Boolean);
    return `  ${t.id.padEnd(9)} ${t.name}${details.length ? `  [${details.join("; ")}]` : ""}`;
  });
  return `\nTemplates (propose --template <id>):\n${rows.join("\n")}\n`;
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
  if (view.labels?.length) lines.push(`labels: ${view.labels.join(", ")}`);
  if (view.block) {
    const block = doc.blocks?.find((b) => b.id === view.block);
    lines.push(
      `block: ${view.block}${block ? ` (${block.name}; branch ${block.branch} → ${block.base}${block.merged ? "; merged" : ""})` : ""}`,
    );
  }
  lines.push(`created: ${view.created.at} by ${view.created.by} · updated: ${view.updated_at}`);
  if (view.desc) lines.push("", view.desc);
  if (view.acceptance?.length) {
    lines.push("", "Acceptance:");
    for (const a of view.acceptance) lines.push(`  ${a.id.padEnd(4)} ${a.text}`);
  }
  if (view.notes?.length) {
    lines.push("", "Notes:");
    for (const n of view.notes) {
      lines.push(`  ${n.at.replace("T", " ").slice(0, 16)}  ${n.by}  ${n.kind}`);
      for (const line of n.text.split("\n")) lines.push(`      ${line}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function issuesText(issues: readonly SchemaIssue[]): string {
  return `${issues.map((i) => `  ${i.path || "/"}  ${i.code}  ${i.message}`).join("\n")}\n`;
}
