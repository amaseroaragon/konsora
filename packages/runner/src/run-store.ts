/**
 * Run store: `.konsora/runs/<run-id>/` (docs/esquema-tareas.md §6).
 *
 * - `run.json` is validated with `RunSchema` and always replaced atomically (temp + fsync +
 *   rename), under `.konsora/runs/.lock`, so read-modify-write updates never lose each other.
 * - `events.jsonl` and `raw.jsonl` only grow: each line is one O_APPEND write. `raw.jsonl` rotates
 *   to `raw.1.jsonl` before it would pass 20 MB (one previous file is kept). The raw log has a
 *   single writer, the run's supervisor.
 * - Creating a run checks, under the same lock, that its task has no other active run.
 * - Runs hold prompts and provider output: directories are 0700 and files 0600.
 * - `.konsora`, `runs` and each run directory must not be symlinks.
 */
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type CheckAttempt,
  type ChecksFile,
  ChecksFileSchema,
  canAddRun,
  type IntegrationState,
  isActiveRunState,
  type Run,
  type RunId,
  RunIdSchema,
  RunSchema,
  type RunState,
  transitionIntegration,
  transitionRun,
} from "@konsora/core";
import {
  acquireFileLock,
  KONSORA_DIR,
  LockTimeoutError,
  type StoreOptions,
  writeFileAtomically,
} from "@konsora/core/store";

export const RUNS_DIR = "runs";
export const RUNS_LOCK_FILE = ".lock";
export const RUN_FILE = "run.json";
export const EVENTS_FILE = "events.jsonl";
export const RAW_FILE = "raw.jsonl";
export const RAW_ROTATED_FILE = "raw.1.jsonl";
export const DIFF_FILE = "diff.patch";
export const CHECKS_FILE = "checks.json";
export const RAW_MAX_BYTES = 20 * 1024 * 1024;

export type RunStoreErrorCode =
  | "invalid_id"
  | "not_found"
  | "exists"
  | "invalid"
  | "active_run"
  | "invalid_transition"
  | "unsafe_path"
  | "lock_timeout";

export class RunStoreError extends Error {
  readonly code: RunStoreErrorCode;
  /** For `active_run`: the run that already occupies the task. */
  readonly activeRun: Run | undefined;
  constructor(code: RunStoreErrorCode, message: string, activeRun?: Run) {
    super(message);
    this.name = "RunStoreError";
    this.code = code;
    this.activeRun = activeRun;
  }
}

export type RunStoreOptions = StoreOptions & {
  /** Size at which `raw.jsonl` rotates. Default 20 MB. */
  rawMaxBytes?: number;
};

/** Fields that `update` may change. Identity, state and integration have their own methods. */
export type RunFields = Partial<Omit<Run, "id" | "task" | "task_hash" | "state" | "integration">>;

export type RunListing = {
  /** Valid runs, oldest first (run ids sort by time). */
  runs: Run[];
  /** Run directories whose `run.json` is missing or invalid. */
  invalid: { id: string; message: string }[];
};

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export class RunStore {
  readonly root: string;
  readonly #options: RunStoreOptions;
  /** Per-file queues so appends from this process never interleave or race a rotation. */
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(root: string, options: RunStoreOptions = {}) {
    this.root = root;
    this.#options = options;
  }

  get dir(): string {
    return join(this.root, KONSORA_DIR, RUNS_DIR);
  }

  runDir(id: RunId): string {
    const parsed = RunIdSchema.safeParse(id);
    if (!parsed.success) throw new RunStoreError("invalid_id", `"${id}" is not a run id`);
    return join(this.dir, id);
  }

  /**
   * Creates a new run directory with its `run.json`. The run must be `queued`, and its task must
   * have no other active run (`active_run` otherwise), except the variants of its own group.
   */
  async create(run: Run): Promise<Run> {
    const valid = validate(run);
    if (valid.state !== "queued") {
      throw new RunStoreError("invalid", `A new run must be queued, not ${valid.state}`);
    }
    await this.#ensureRunsDir();
    return this.#locked(async () => {
      // One active run per task; the variants of one group count as one (CORE-12).
      const { runs } = await this.list({ task: valid.task });
      const allowed = canAddRun(runs, valid);
      if (!allowed.ok) {
        const active = runs.find((r) => r.id === allowed.error.run);
        throw new RunStoreError(
          allowed.error.code === "active_run" ? "active_run" : "invalid",
          allowed.error.code === "active_run"
            ? `Task ${valid.task} already has an active run (${active?.id}, ${active?.state}); ` +
                "wait for it to finish or cancel it first"
            : allowed.error.message,
          active,
        );
      }
      const dir = this.runDir(valid.id);
      try {
        await mkdir(dir, { mode: DIR_MODE });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new RunStoreError("exists", `Run ${valid.id} already exists`);
        }
        throw error;
      }
      try {
        await this.#write(valid);
      } catch (error) {
        await rm(dir, { recursive: true, force: true });
        throw error;
      }
      return valid;
    });
  }

  /** Reads and validates one run. */
  async read(id: RunId): Promise<Run> {
    const dir = this.runDir(id);
    const info = await lstat(dir).catch(() => null);
    if (!info) throw new RunStoreError("not_found", `Run ${id} does not exist`);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new RunStoreError("unsafe_path", `Run ${id} is not a plain directory`);
    }
    let text: string;
    try {
      text = await readFile(join(dir, RUN_FILE), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new RunStoreError("invalid", `Run ${id} has no ${RUN_FILE}`);
      }
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new RunStoreError("invalid", `Run ${id}: ${RUN_FILE} is not valid JSON`);
    }
    const run = validate(value, id);
    if (run.id !== id) {
      throw new RunStoreError("invalid", `Run ${id}: ${RUN_FILE} belongs to ${run.id}`);
    }
    return run;
  }

  /** Every run, oldest first, optionally only those of one task. Never writes. */
  async list(filter: { task?: string } = {}): Promise<RunListing> {
    const names = await readdir(this.dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
    const listing: RunListing = { runs: [], invalid: [] };
    for (const name of names.filter((n) => RunIdSchema.safeParse(n).success).sort()) {
      try {
        const run = await this.read(name);
        if (filter.task === undefined || run.task === filter.task) listing.runs.push(run);
      } catch (error) {
        if (!(error instanceof RunStoreError)) throw error;
        listing.invalid.push({ id: name, message: error.message });
      }
    }
    return listing;
  }

  /** The active run of a task (at most one), or `null`. */
  async activeRun(task: string): Promise<Run | null> {
    const { runs } = await this.list({ task });
    return runs.find((run) => isActiveRunState(run.state)) ?? null;
  }

  /** The active run of every task that has one. */
  async activeRuns(): Promise<Map<string, Run>> {
    const { runs } = await this.list();
    const active = new Map<string, Run>();
    for (const run of runs) if (isActiveRunState(run.state)) active.set(run.task, run);
    return active;
  }

  /** Changes descriptive fields (worktree, commits, usage…), validated, without a transition. */
  async update(id: RunId, fields: RunFields): Promise<Run> {
    return this.#modify(id, (run) => ({ ...run, ...fields }));
  }

  /** Moves the run to `to` (and sets `fields` in the same write), or `invalid_transition`. */
  async transition(id: RunId, to: RunState, fields: RunFields = {}): Promise<Run> {
    return this.#modify(id, (run) => {
      const result = transitionRun(run, to);
      if (!result.ok) throw new RunStoreError("invalid_transition", result.error.message);
      return { ...result.run, ...fields };
    });
  }

  /** Moves a finished run's integration to `to`, or `invalid_transition`. */
  async integrate(id: RunId, to: IntegrationState): Promise<Run> {
    return this.#modify(id, (run) => {
      const result = transitionIntegration(run, to);
      if (!result.ok) throw new RunStoreError("invalid_transition", result.error.message);
      return result.run;
    });
  }

  /** Appends one normalized event as a line of `events.jsonl`. */
  async appendEvent(id: RunId, event: Record<string, unknown>): Promise<void> {
    const path = join(this.runDir(id), EVENTS_FILE);
    const line = `${JSON.stringify(event)}\n`;
    return this.#enqueue(path, async () => {
      await this.read(id); // the run must exist; never create stray directories
      await appendLine(path, line);
    });
  }

  /** Writes `diff.patch` (base..head) atomically, replacing an earlier one. */
  async writeDiff(id: RunId, patch: string): Promise<void> {
    await this.read(id);
    await writeFileAtomically(this.runDir(id), DIFF_FILE, patch, FILE_MODE);
  }

  /** Reads `diff.patch`, or `null` if the run has none yet. */
  async readDiff(id: RunId): Promise<string | null> {
    return readFile(join(this.runDir(id), DIFF_FILE), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
  }

  /** Reads `checks.json`, or `null` if the run has not run its checks. */
  async readChecks(id: RunId): Promise<ChecksFile | null> {
    const text = await readFile(join(this.runDir(id), CHECKS_FILE), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (text === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new RunStoreError("invalid", `Run ${id}: ${CHECKS_FILE} is not valid JSON`);
    }
    const parsed = ChecksFileSchema.safeParse(value);
    if (!parsed.success || parsed.data.run !== id) {
      throw new RunStoreError("invalid", `Run ${id}: ${CHECKS_FILE} is not valid`);
    }
    return parsed.data;
  }

  /** Adds an attempt to `checks.json` (atomically); its number must follow the last one. */
  async appendCheckAttempt(id: RunId, attempt: CheckAttempt): Promise<ChecksFile> {
    await this.read(id);
    const current = (await this.readChecks(id)) ?? { run: id, attempts: [] };
    const next: ChecksFile = { run: id, attempts: [...current.attempts, attempt] };
    const parsed = ChecksFileSchema.safeParse(next);
    if (!parsed.success) {
      throw new RunStoreError(
        "invalid",
        `Run ${id}: attempt ${attempt.attempt} does not fit ${CHECKS_FILE}`,
      );
    }
    await writeFileAtomically(
      this.runDir(id),
      CHECKS_FILE,
      `${JSON.stringify(parsed.data, null, 2)}\n`,
      FILE_MODE,
    );
    return parsed.data;
  }

  /** Reads `events.jsonl`, ignoring a trailing incomplete line. */
  async readEvents(id: RunId): Promise<unknown[]> {
    const text = await readFile(join(this.runDir(id), EVENTS_FILE), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      },
    );
    const lines = text.split("\n");
    lines.pop(); // "" after the last newline, or an incomplete line
    return lines.map((line) => JSON.parse(line) as unknown);
  }

  /**
   * Appends one line of raw provider output to `raw.jsonl`. When the file would pass the limit,
   * it first becomes `raw.1.jsonl` (replacing the previous one).
   */
  async appendRaw(id: RunId, line: string): Promise<void> {
    const dir = this.runDir(id);
    const path = join(dir, RAW_FILE);
    const text = line.endsWith("\n") ? line : `${line}\n`;
    const max = this.#options.rawMaxBytes ?? RAW_MAX_BYTES;
    return this.#enqueue(path, async () => {
      await this.read(id);
      const size = (await lstat(path).catch(() => null))?.size ?? 0;
      if (size > 0 && size + Buffer.byteLength(text) > max) {
        await rename(path, join(dir, RAW_ROTATED_FILE));
      }
      await appendLine(path, text);
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  async #modify(id: RunId, change: (run: Run) => Run): Promise<Run> {
    this.runDir(id);
    return this.#locked(async () => {
      const current = await this.read(id);
      const next = validate(change(current), id);
      if (next.id !== current.id || next.task !== current.task) {
        throw new RunStoreError("invalid", `Run ${id}: its id and task cannot change`);
      }
      await this.#write(next);
      return next;
    });
  }

  #write(run: Run): Promise<void> {
    return writeFileAtomically(
      this.runDir(run.id),
      RUN_FILE,
      `${JSON.stringify(run, null, 2)}\n`,
      FILE_MODE,
    );
  }

  async #ensureRunsDir(): Promise<void> {
    const konsora = join(this.root, KONSORA_DIR);
    const info = await lstat(konsora).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) {
      throw new RunStoreError("unsafe_path", `${KONSORA_DIR}/ is missing or is not a directory`);
    }
    try {
      await mkdir(this.dir, { mode: DIR_MODE });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const runs = await lstat(this.dir);
    if (!runs.isDirectory() || runs.isSymbolicLink()) {
      throw new RunStoreError("unsafe_path", `${KONSORA_DIR}/${RUNS_DIR} is not a directory`);
    }
  }

  async #locked<T>(fn: () => Promise<T>): Promise<T> {
    await this.#ensureRunsDir();
    let release: () => Promise<void>;
    try {
      release = await acquireFileLock(join(this.dir, RUNS_LOCK_FILE), this.#options);
    } catch (error) {
      if (error instanceof LockTimeoutError) {
        throw new RunStoreError(
          "lock_timeout",
          `${KONSORA_DIR}/${RUNS_DIR} is locked by ${error.holder}; try again shortly`,
        );
      }
      throw error;
    }
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  #enqueue(path: string, task: () => Promise<void>): Promise<void> {
    const previous = this.#queues.get(path) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.catch(() => undefined);
    this.#queues.set(path, settled);
    void settled.then(() => {
      if (this.#queues.get(path) === settled) this.#queues.delete(path);
    });
    return next;
  }
}

function validate(value: unknown, id?: string): Run {
  const parsed = RunSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? `${first.path.join(".")}: ` : "";
    throw new RunStoreError(
      "invalid",
      `${id ? `Run ${id}: ` : ""}invalid run (${where}${first?.message ?? "unknown problem"})`,
    );
  }
  return parsed.data;
}

/** One O_APPEND write per line: concurrent appenders (even other processes) never interleave. */
async function appendLine(path: string, text: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    FILE_MODE,
  );
  try {
    const buffer = Buffer.from(text, "utf8");
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await handle.write(buffer, offset);
      offset += bytesWritten;
    }
  } finally {
    await handle.close();
  }
}
