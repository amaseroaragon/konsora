/** Plain-text renderers for the CLI. English, no colors, stable column layout. */
import {
  compareByRank,
  dependentsOf,
  deriveFlags,
  indexTasks,
  isStale,
  type LogEntry,
  milestoneProgress,
  recommendedModel,
  type SchemaIssue,
  STALE_AFTER_HOURS,
  startedBy,
  type Task,
  type TaskFlags,
  type TaskState,
  type TasksDocument,
  topoOrder,
} from "@konsora/core";

export const STATES: readonly TaskState[] = ["proposed", "todo", "doing", "done"];

/** A task plus its derived flags: the shape of every task in `--json` output. */
export type TaskView = Task &
  Omit<TaskFlags, "blocked"> & {
    blocked: boolean;
    /** Moved to `.konsora/archive.json` (`konsora archive`); only `show` returns these. */
    archived?: true;
  };

export function views(doc: TasksDocument): TaskView[] {
  const flags = deriveFlags(doc);
  const index = indexTasks(doc);
  return topoOrder(doc).order.map((id) => {
    const task = index.get(id) as Task;
    return { ...task, ...(flags.get(id) as TaskFlags) };
  });
}

/** The tasks an agent can start now, in priority order (`rank`): the first is the next to take. */
export function readyViews(list: readonly TaskView[]): TaskView[] {
  return list.filter((t) => t.ready).sort(compareByRank);
}

function flagText(view: TaskView): string {
  const parts: string[] = [];
  if (view.ready) parts.push("ready");
  if (view.blocked) parts.push(`blocked by ${view.blockers.join(", ")}`);
  if (view.waiting) parts.push("waiting for answer");
  return parts.join("; ");
}

export function taskTable(list: readonly TaskView[]): string {
  if (list.length === 0) return "No tasks match.\n";
  const idWidth = Math.max(2, ...list.map((t) => t.id.length));
  const rows = list.map((t) => {
    const flags = flagText(t);
    return `${t.id.padEnd(idWidth)}  ${t.state.padEnd(8)}  ${(t.difficulty ?? "-").padEnd(6)}  ${t.title}${flags ? `  [${flags}]` : ""}`;
  });
  return `${"ID".padEnd(idWidth)}  ${"STATE".padEnd(8)}  ${"DIFF".padEnd(6)}  TITLE\n${rows.join("\n")}\n`;
}

export function statusText(
  doc: TasksDocument,
  file: string,
  check: { now: Date; hours: number } = { now: new Date(), hours: STALE_AFTER_HOURS },
): string {
  const list = views(doc);
  const stale = list.filter((t) => isStale(t, check.now, check.hours));
  const count = (state: TaskState) => list.filter((t) => t.state === state).length;
  const section = (title: string, items: TaskView[], extra?: (t: TaskView) => string) =>
    items.length
      ? `\n${title}:\n${items.map((t) => `  ${t.id.padEnd(9)} ${t.title}${extra?.(t) ?? ""}`).join("\n")}\n`
      : "";
  return [
    `${doc.project.name} · ${file} · ${list.length} tasks in ${doc.groups.length} groups\n`,
    `  groups: ${doc.groups.map((g) => `${g.id} (${g.name})`).join(", ")}\n`,
    `\n  ${STATES.map((s) => `${s} ${count(s)}`).join("   ")}\n`,
    `  ready ${list.filter((t) => t.ready).length} · blocked ${list.filter((t) => t.blocked).length} · waiting ${list.filter((t) => t.waiting).length}${stale.length ? ` · abandoned ${stale.length}` : ""}\n`,
    section(
      "Waiting for an answer",
      list.filter((t) => t.waiting),
    ),
    section(
      `Abandoned? (in progress, no activity for over ${check.hours} h; pause it or pick it up)`,
      stale,
      startedText,
    ),
    section(
      "Doing",
      list.filter((t) => t.state === "doing"),
      startedText,
    ),
    section("Ready to start", readyViews(list)),
    section(
      "Ideas (proposed; anyone can promote them to todo)",
      list.filter((t) => t.state === "proposed"),
    ),
    milestonesText(doc),
    templatesText(doc),
  ].join("");
}

/** `  (claude, since 2026-11-02 10:00)`: who has a task in progress (CORE-09). */
function startedText(view: TaskView): string {
  const started = startedBy(view);
  return started ? `  (${started.by.replace(/^agent:/, "")}, since ${minute(started.at)})` : "";
}

const minute = (at: string) => at.replace("T", " ").slice(0, 16);

/** Each milestone with its done and total tasks (CORE-19), for `propose --milestone <id>`. */
function milestonesText(doc: TasksDocument): string {
  const progress = milestoneProgress(doc);
  if (progress.length === 0) return "";
  const width = Math.max(9, ...progress.map((m) => m.id.length + 1));
  const rows = progress.map(
    (m) =>
      `  ${m.id.padEnd(width)} ${m.name}  ${m.done}/${m.total} done${m.criterion ? `\n  ${"".padEnd(width)} done when: ${m.criterion}` : ""}`,
  );
  return `\nMilestones (propose --milestone <id>):\n${rows.join("\n")}\n`;
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
  const archived = new Set(doc.archived);
  const group = doc.groups.find((g) => g.id === view.group);
  const flags = view.archived ? "archived" : flagText(view);
  const lines = [
    `${view.id} · ${view.title}`,
    `state: ${view.state}${flags ? ` (${flags})` : ""}   group: ${view.group}${group ? ` (${group.name})` : ""}   rank: ${view.rank}`,
  ];
  if (view.deps?.length) {
    const depState = (d: string) =>
      index.get(d)?.state ?? (archived.has(d) ? "done, archived" : "missing");
    lines.push(`deps: ${view.deps.map((d) => `${d} (${depState(d)})`).join(", ")}`);
  }
  const dependents = dependentsOf(view.id, doc);
  if (dependents.length) lines.push(`dependents: ${dependents.join(", ")}`);
  if (view.labels?.length) lines.push(`labels: ${view.labels.join(", ")}`);
  if (view.difficulty) lines.push(`difficulty: ${view.difficulty}`);
  const model = recommendedModel(doc.project, view);
  if (model) lines.push(`recommended model: ${model}`);
  if (view.milestone) {
    const milestone = doc.milestones?.find((m) => m.id === view.milestone);
    lines.push(`milestone: ${view.milestone}${milestone ? ` (${milestone.name})` : ""}`);
  }
  lines.push(`created: ${view.created.at} by ${view.created.by} · updated: ${view.updated_at}`);
  const started = startedBy(view);
  if (started) lines.push(`started: ${started.at} by ${started.by}`);
  if (view.desc) lines.push("", view.desc);
  if (view.acceptance?.length) {
    lines.push("", "Acceptance:");
    for (const a of view.acceptance) lines.push(`  ${a.id.padEnd(4)} ${a.text}`);
  }
  if (view.commits?.length) lines.push("", `Commits: ${view.commits.join(" ")}`);
  if (view.notes?.length) {
    lines.push("", "Notes:");
    for (const n of view.notes) {
      lines.push(`  ${n.at.replace("T", " ").slice(0, 16)}  ${n.by}  ${n.kind}`);
      for (const line of n.text.split("\n")) lines.push(`      ${line}`);
      if (n.options?.length) lines.push(`      options: ${n.options.join(" | ")}`);
      for (const e of n.evidence ?? [])
        lines.push(`      ${e.ac} ${e.met ? "met" : "NOT MET"}: ${e.text.replaceAll("\n", " ")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function issuesText(issues: readonly SchemaIssue[]): string {
  return `${issues.map((i) => `  ${i.path || "/"}  ${i.code}  ${i.message}`).join("\n")}\n`;
}

/** `konsora log`: one line per closed task, newest first, with the summary's first line. */
export function logText(entries: readonly LogEntry[]): string {
  if (entries.length === 0) return "No finished tasks match.\n";
  const idWidth = Math.max(2, ...entries.map((e) => e.id.length));
  const byWidth = Math.max(2, ...entries.map((e) => who(e.by).length));
  const rows = entries.map((e) => {
    const first = e.summary
      ?.split("\n")
      .find((line) => line.trim())
      ?.trim();
    const flags = [
      e.archived ? "archived" : undefined,
      e.unmet ? `${e.unmet} not met` : undefined,
      e.unproven ? `${e.unproven} without evidence` : undefined,
    ].filter(Boolean);
    return (
      `${minute(e.at)}  ${e.id.padEnd(idWidth)}  ${who(e.by).padEnd(byWidth)}  ${e.title}` +
      `${flags.length ? `  [${flags.join("; ")}]` : ""}\n` +
      `${"".padEnd(18 + idWidth + byWidth)}${first ?? "(no closing summary)"}`
    );
  });
  return `${rows.join("\n")}\n`;
}

const who = (by: string | undefined) => (by ? by.replace(/^agent:/, "") : "-");
