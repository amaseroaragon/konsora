/**
 * Oversight of plans the daemon watches (docs/esquema-tareas.md §5, "Cambios externos").
 *
 * Per project, in the data dir (never in the project): `snapshot.json` (last trusted plan),
 * `external.json` (open flags) and `approvals.jsonl` (append-only log of human actions done
 * through the daemon). On every check the current file is diffed against the snapshot: changes
 * an agent may make (create in todo or as an idea, promote, start, pause, finish, notes, edits of
 * unfinished work, deleting what nobody started) pass; changes that need a human (reopen, jumps
 * no single op makes, edits of done work, deleting started work, notes rewritten) are flagged
 * "unapproved external change" until the human confirms or reverts them.
 * The snapshot then advances, so each change is evaluated once; flags persist.
 */
import { appendFile, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { stableStringify, type Task, type TasksDocument } from "@konsora/core";
import { ensurePrivateDir, readJson, writePrivateFile } from "./files.ts";

export type FlagKind = "transition" | "created_approved" | "edited" | "deleted" | "notes_rewritten";

export type ExternalFlag = {
  task: string;
  kind: FlagKind;
  /** Human-readable explanation, e.g. "review → done without your acceptance". */
  message: string;
  from?: string;
  to?: string;
  /** The task before the change (null if it was created externally): what "revert" restores. */
  previous: Task | null;
  detected_at: string;
};

export type LedgerEntry = {
  at: string;
  task: string;
  op: string;
  from?: string;
  to?: string;
  actor: "human";
};

type Snapshot = { taken_at: string; hash: string; document: TasksDocument };

/**
 * Where an agent's own ops can take a task, possibly in several steps seen at once (promote,
 * start, pause; `done` only by finishing, checked separately). Done work never moves.
 */
const AGENT_REACH: Record<Task["state"], readonly Task["state"][]> = {
  proposed: ["todo", "doing"],
  todo: ["doing"],
  doing: ["todo"],
  done: [],
};

/**
 * State changes only a human may make: reopening, and anything agents cannot reach. Reaching
 * `done` counts as the agent's only with a new `summary` note, which `finish` always leaves.
 */
function humanTransition(before: Task, after: Task): boolean {
  if (before.state === after.state) return false;
  if (after.state === "done") {
    const added = (after.notes ?? []).slice((before.notes ?? []).length);
    return before.state === "done" || !added.some((note) => note.kind === "summary");
  }
  return !AGENT_REACH[before.state].includes(after.state);
}

const CONTENT = ["title", "desc", "acceptance", "labels", "group"] as const;

function notesRewritten(before: Task, after: Task): boolean {
  const old = before.notes ?? [];
  const now = after.notes ?? [];
  return old.some((note, i) => stableStringify(note) !== stableStringify(now[i]));
}

/** Pure diff: which changes from `before` to `after` need a human. */
export function detectUnapproved(
  before: TasksDocument,
  after: TasksDocument,
  at: string,
): ExternalFlag[] {
  const flags: ExternalFlag[] = [];
  const old = new Map(before.tasks.map((t) => [t.id, t]));
  const now = new Map(after.tasks.map((t) => [t.id, t]));
  for (const task of after.tasks) {
    const prev = old.get(task.id);
    if (!prev) {
      if (task.state !== "proposed" && task.state !== "todo") {
        flags.push({
          task: task.id,
          kind: "created_approved",
          message: `created directly as ${task.state} (tasks start as todo or as ideas)`,
          to: task.state,
          previous: null,
          detected_at: at,
        });
      }
      continue;
    }
    if (humanTransition(prev, task)) {
      flags.push({
        task: task.id,
        kind: "transition",
        message: `${prev.state} → ${task.state} without you (no agent op does that)`,
        from: prev.state,
        to: task.state,
        previous: prev,
        detected_at: at,
      });
    } else if (prev.state === "done") {
      const changed = CONTENT.filter(
        (key) => stableStringify(prev[key] ?? null) !== stableStringify(task[key] ?? null),
      );
      const depsRemoved = (prev.deps ?? []).filter((d) => !(task.deps ?? []).includes(d));
      if (changed.length || depsRemoved.length) {
        const what = [
          ...changed,
          ...(depsRemoved.length ? [`removed deps ${depsRemoved.join(", ")}`] : []),
        ].join(", ");
        flags.push({
          task: task.id,
          kind: "edited",
          message: `finished task changed outside Konsora (${what})`,
          previous: prev,
          detected_at: at,
        });
      } else if (notesRewritten(prev, task)) {
        flags.push({
          task: task.id,
          kind: "notes_rewritten",
          message: "existing notes were edited or deleted (notes are append-only)",
          previous: prev,
          detected_at: at,
        });
      }
    } else if (notesRewritten(prev, task)) {
      flags.push({
        task: task.id,
        kind: "notes_rewritten",
        message: "existing notes were edited or deleted (notes are append-only)",
        previous: prev,
        detected_at: at,
      });
    }
  }
  for (const prev of before.tasks) {
    if (!now.has(prev.id) && prev.state !== "proposed" && prev.state !== "todo") {
      flags.push({
        task: prev.id,
        kind: "deleted",
        message: `started task deleted outside Konsora (was ${prev.state})`,
        from: prev.state,
        previous: prev,
        detected_at: at,
      });
    }
  }
  return flags;
}

export class Oversight {
  private readonly dir: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, projectId: string) {
    this.dir = join(dataDir, "projects", projectId);
  }

  private path(name: string) {
    return join(this.dir, name);
  }

  async flags(): Promise<ExternalFlag[]> {
    return (await readJson<ExternalFlag[]>(this.path("external.json"))) ?? [];
  }

  async ledger(): Promise<LedgerEntry[]> {
    const text = await readFile(this.path("approvals.jsonl"), "utf8").catch(() => "");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LedgerEntry);
  }

  /**
   * Compares the current plan with the snapshot, records new flags, drops flags that no longer
   * apply (the task left the flagged state or is gone), and advances the snapshot.
   * The first check of a project only takes the baseline.
   */
  check(current: TasksDocument, hash: string, at: string): Promise<ExternalFlag[]> {
    return this.serial(async () => {
      const snapshot = await readJson<Snapshot>(this.path("snapshot.json"));
      let flags = await this.flags();
      if (snapshot && snapshot.hash !== hash) {
        const ledger = (await this.ledger()).filter((e) => e.at >= snapshot.taken_at);
        // A human action logged after the snapshot (e.g. a crash before the snapshot was saved) is not external.
        const fresh = detectUnapproved(snapshot.document, current, at).filter(
          (flag) =>
            !ledger.some(
              (e) => e.task === flag.task && (flag.to === undefined || e.to === flag.to),
            ),
        );
        // Going back by hand to the state from before an open flag undoes it; that is not a new change.
        const undone = (f: ExternalFlag) =>
          f.kind === "transition" &&
          flags.some(
            (e) => e.task === f.task && e.kind === "transition" && e.previous?.state === f.to,
          );
        const added = fresh.filter((f) => !undone(f));
        flags = [
          ...flags.filter((f) => !added.some((n) => n.task === f.task && n.kind === f.kind)),
          ...added,
        ];
      }
      const byId = new Map(current.tasks.map((t) => [t.id, t]));
      flags = flags.filter((flag) => {
        const task = byId.get(flag.task);
        if (flag.kind === "deleted") return !task;
        if (!task) return false;
        if (flag.kind === "transition" || flag.kind === "created_approved")
          return task.state === flag.to;
        return true;
      });
      if (!snapshot || snapshot.hash !== hash) await this.saveSnapshot(current, hash, at);
      await this.saveFlags(flags);
      return flags;
    });
  }

  /** After the daemon's own write: the result is trusted. */
  trust(document: TasksDocument, hash: string, at: string): Promise<void> {
    return this.serial(() => this.saveSnapshot(document, hash, at));
  }

  async log(entries: LedgerEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await ensurePrivateDir(this.dir);
    await appendFile(
      this.path("approvals.jsonl"),
      entries.map((e) => `${JSON.stringify(e)}\n`).join(""),
      { mode: 0o600 },
    );
    const handle = await open(this.path("approvals.jsonl"), "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /**
   * Removes every flag of a task (after confirm or revert) and returns them oldest first, so a
   * revert restores the version from before the first unapproved change.
   */
  resolve(task: string): Promise<ExternalFlag[]> {
    return this.serial(async () => {
      const flags = await this.flags();
      const mine = flags.filter((f) => f.task === task);
      if (mine.length) await this.saveFlags(flags.filter((f) => f.task !== task));
      return mine;
    });
  }

  private async saveSnapshot(document: TasksDocument, hash: string, at: string) {
    await writePrivateFile(
      this.path("snapshot.json"),
      JSON.stringify({ taken_at: at, hash, document } satisfies Snapshot),
    );
  }

  private async saveFlags(flags: ExternalFlag[]) {
    await writePrivateFile(this.path("external.json"), `${JSON.stringify(flags, null, 2)}\n`);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

export type OversightFor = (projectId: string) => Oversight;

/** One Oversight per project, shared by the HTTP app and the event hub (same write queue). */
export function createOversights(dataDir: string): OversightFor {
  const cache = new Map<string, Oversight>();
  return (projectId) => {
    let instance = cache.get(projectId);
    if (!instance) {
      instance = new Oversight(dataDir, projectId);
      cache.set(projectId, instance);
    }
    return instance;
  };
}
