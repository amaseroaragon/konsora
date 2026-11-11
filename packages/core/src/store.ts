/**
 * File store for `.konsora/tasks.json` (docs/esquema-tareas.md §5). Node-only: import it from
 * `@konsora/core/store`, never from the browser.
 *
 * - Reading never writes and never creates anything.
 * - Writes are semantic ops (`applyOp`) under an exclusive lock file created with O_EXCL that
 *   records `{pid, host, at}`. A lock is stale only when its PID is dead on this same host;
 *   there is no time-based expiry, so a slow writer is never robbed of its lock.
 * - The current file is re-read and validated under the lock; an invalid file is never
 *   overwritten. The result is written canonically to a temp file in the same directory,
 *   fsynced, renamed over the original, and the directory is fsynced.
 * - `.konsora` and `tasks.json` must not be symlinks (they could point outside the project).
 */
import { constants, watch } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "./hash.ts";
import { applyOp, type Op, type OpContext, type OpError } from "./ops.ts";
import type { SchemaIssue, TasksDocument } from "./schema.ts";
import { parseTasksFile } from "./semantics.ts";
import { serializeDocument } from "./serialize.ts";

export const KONSORA_DIR = ".konsora";
export const TASKS_FILE = "tasks.json";
export const LOCK_FILE = "tasks.json.lock";

export type StoreErrorCode =
  | "missing"
  | "exists"
  | "invalid"
  | "unsafe_path"
  | "lock_timeout"
  | "io";
export type StoreError = { code: StoreErrorCode; message: string; issues?: SchemaIssue[] };

export type Snapshot = { document: TasksDocument; hash: string; text: string };
export type ReadResult = ({ ok: true } & Snapshot) | { ok: false; error: StoreError };
export type MutateResult =
  | ({ ok: true; changed: string[]; created: string[] } & Snapshot)
  | { ok: false; source: "op"; error: OpError }
  | { ok: false; source: "store"; error: StoreError };

export type StoreOptions = {
  /** How long to wait for another writer's lock. Default 5000 ms. */
  lockTimeoutMs?: number;
  /** Poll interval while waiting for the lock. Default 20 ms. */
  lockPollMs?: number;
};

export function tasksPath(root: string): string {
  return join(root, KONSORA_DIR, TASKS_FILE);
}

/** `sha256:<hex>` of the file's exact bytes (as UTF-8 text). */
export function fileHash(text: string): string {
  return `sha256:${sha256Hex(text)}`;
}

class Failure extends Error {
  readonly detail: StoreError;
  constructor(detail: StoreError) {
    super(detail.message);
    this.detail = detail;
  }
}
const fail = (code: StoreErrorCode, message: string, issues?: SchemaIssue[]): never => {
  throw new Failure(issues ? { code, message, issues } : { code, message });
};

async function ensureSafe(root: string): Promise<void> {
  const dir = join(root, KONSORA_DIR);
  const dirInfo = await lstat(dir).catch(() => null);
  if (!dirInfo)
    fail("missing", `${KONSORA_DIR}/ does not exist; run \`konsora init\` to create it`);
  else if (dirInfo.isSymbolicLink())
    fail("unsafe_path", `${KONSORA_DIR} is a symlink; Konsora refuses to follow it`);
  else if (!dirInfo.isDirectory()) fail("unsafe_path", `${KONSORA_DIR} is not a directory`);
  const fileInfo = await lstat(tasksPath(root)).catch(() => null);
  if (!fileInfo) fail("missing", `${KONSORA_DIR}/${TASKS_FILE} does not exist`);
  else if (fileInfo.isSymbolicLink())
    fail("unsafe_path", `${TASKS_FILE} is a symlink; Konsora refuses to follow it`);
  else if (!fileInfo.isFile()) fail("unsafe_path", `${TASKS_FILE} is not a regular file`);
}

async function load(root: string): Promise<Snapshot> {
  await ensureSafe(root);
  const text = await readFile(tasksPath(root), "utf8");
  const parsed = parseTasksFile(text);
  if (!parsed.ok) {
    fail(
      "invalid",
      `${TASKS_FILE} is invalid (${parsed.issues.length} problem(s)); fix it before Konsora can write`,
      parsed.issues,
    );
  }
  return { document: (parsed as { document: TasksDocument }).document, hash: fileHash(text), text };
}

/** Reads and validates the plan. Never writes. */
export async function readTasks(root: string): Promise<ReadResult> {
  try {
    return { ok: true, ...(await load(root)) };
  } catch (error) {
    return { ok: false, error: toStoreError(error) };
  }
}

function toStoreError(error: unknown): StoreError {
  if (error instanceof Failure) return error.detail;
  return { code: "io", message: `File system error: ${(error as Error).message}` };
}

type LockInfo = { pid: number; host: string; at: string };

function parseLock(raw: string): LockInfo | null {
  try {
    const value = JSON.parse(raw) as LockInfo;
    return typeof value.pid === "number" && typeof value.host === "string" ? value : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // exists but not ours
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Thrown by `acquireFileLock` when another live process keeps the lock past the timeout. */
export class LockTimeoutError extends Error {
  /** Who holds the lock, e.g. "pid 123 on host since …", or "another writer". */
  readonly holder: string;
  constructor(holder: string) {
    super(`locked by ${holder}`);
    this.holder = holder;
  }
}

/**
 * Acquires an exclusive lock file at `path` (O_EXCL, `{pid, host, at}`), or throws
 * `LockTimeoutError`. A lock is stale only when its PID is dead on this same host; there is no
 * time-based expiry. Returns a release function that removes the lock only if it is still ours.
 */
export async function acquireFileLock(
  path: string,
  options: StoreOptions = {},
): Promise<() => Promise<void>> {
  const deadline = Date.now() + (options.lockTimeoutMs ?? 5000);
  const mine = {
    pid: process.pid,
    host: hostname(),
    at: new Date().toISOString(),
    // Tells apart two holders in the same process, so a release never removes another's lock.
    nonce: Math.random().toString(36).slice(2),
  };
  const body = JSON.stringify(mine);
  for (;;) {
    try {
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o644,
      );
      try {
        await handle.writeFile(body);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return async () => {
        // Remove only our own lock.
        const current = await readFile(path, "utf8").catch(() => "");
        if (current === body) await unlink(path).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const raw = await readFile(path, "utf8").catch(() => "");
    const holder = parseLock(raw);
    if (holder && holder.host === mine.host && !isAlive(holder.pid)) {
      // Stale: its process is gone. Re-read right before deleting so we never remove a lock
      // that another waiter has just taken over (compare-and-delete).
      const again = await readFile(path, "utf8").catch(() => "");
      if (again === raw) await unlink(path).catch(() => undefined);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new LockTimeoutError(
        holder ? `pid ${holder.pid} on ${holder.host} since ${holder.at}` : "another writer",
      );
    }
    await sleep(options.lockPollMs ?? 20);
  }
}

/** Acquires the plan's lock or throws `lock_timeout`. Returns a release function. */
async function acquireLock(root: string, options: StoreOptions): Promise<() => Promise<void>> {
  try {
    return await acquireFileLock(join(root, KONSORA_DIR, LOCK_FILE), options);
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      fail("lock_timeout", `${TASKS_FILE} is locked by ${error.holder}; try again shortly`);
    }
    throw error;
  }
}

/**
 * Replaces `dir/name` atomically: writes a temp file in the same directory (O_EXCL, `mode`),
 * fsyncs it, renames it over the target and fsyncs the directory. Readers see the old or the new
 * content, never a partial file.
 */
export async function writeFileAtomically(
  dir: string,
  name: string,
  text: string,
  mode = 0o644,
): Promise<void> {
  const temp = join(dir, `.${name}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temp, join(dir, name));
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  const dirHandle = await open(dir, constants.O_RDONLY);
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}

function writeAtomically(root: string, text: string): Promise<void> {
  return writeFileAtomically(join(root, KONSORA_DIR), TASKS_FILE, text);
}

/**
 * Applies one semantic op to the current file under the lock and writes the result.
 * Returns the op's own error (role, transition, conflict…) or a store error; never a partial write.
 */
export async function mutate(
  root: string,
  op: Op,
  ctx: OpContext,
  options: StoreOptions = {},
): Promise<MutateResult> {
  let release: (() => Promise<void>) | undefined;
  try {
    await ensureSafe(root);
    release = await acquireLock(root, options);
    const current = await load(root);
    const result = applyOp(current.document, op, ctx);
    if (!result.ok) return { ok: false, source: "op", error: result.error };
    const text = serializeDocument(result.document);
    if (text !== current.text) await writeAtomically(root, text);
    return {
      ok: true,
      document: result.document,
      hash: fileHash(text),
      text,
      changed: result.changed,
      created: result.created,
    };
  } catch (error) {
    return { ok: false, source: "store", error: toStoreError(error) };
  } finally {
    await release?.();
  }
}

export type WatchEvent =
  | ({ type: "changed" } & Snapshot)
  | { type: "invalid"; error: StoreError }
  | { type: "missing" };

/**
 * Watches `.konsora/` and reports when the plan's content changes (by hash, so touching the file
 * or Konsora's own lock/temp files does not fire). Debounced; the first read is the baseline and
 * is not reported.
 */
export function watchTasks(
  root: string,
  onEvent: (event: WatchEvent) => void,
  options: { debounceMs?: number } = {},
): { close: () => void; ready: Promise<void> } {
  let last: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const check = async () => {
    const result = await readTasks(root);
    if (closed) return;
    let key: string;
    let event: WatchEvent;
    if (result.ok) {
      key = result.hash;
      event = { type: "changed", document: result.document, hash: result.hash, text: result.text };
    } else if (result.error.code === "missing") {
      key = "missing";
      event = { type: "missing" };
    } else {
      key = `invalid:${await readFile(tasksPath(root), "utf8").then(fileHash, () => "")}`;
      event = { type: "invalid", error: result.error };
    }
    if (key !== last) {
      const first = last === undefined;
      last = key;
      if (!first) onEvent(event);
    }
  };

  const ready = check();
  const watcher = watch(join(root, KONSORA_DIR), (_kind, name) => {
    if (name === LOCK_FILE || name?.endsWith(".tmp")) return;
    clearTimeout(timer);
    timer = setTimeout(() => void check(), options.debounceMs ?? 100);
  });
  return {
    ready,
    close: () => {
      closed = true;
      clearTimeout(timer);
      watcher.close();
    },
  };
}

/** Leftover temp files from a crashed writer (for diagnostics; safe to delete when unlocked). */
export async function strayTempFiles(root: string): Promise<string[]> {
  const names = await readdir(join(root, KONSORA_DIR)).catch(() => []);
  return names.filter((n) => n.startsWith(`.${TASKS_FILE}.`) && n.endsWith(".tmp"));
}

export type InitResult = ({ ok: true } & Snapshot) | { ok: false; error: StoreError };

/**
 * Creates `.konsora/tasks.json` for a new plan. Explicit action only: never called when merely opening a folder. Refuses to overwrite an
 * existing tasks file (exclusive create) and refuses a symlinked `.konsora`.
 */
export async function initTasks(root: string, doc: TasksDocument): Promise<InitResult> {
  try {
    const parsed = parseTasksFile(serializeDocument(doc));
    if (!parsed.ok) fail("invalid", "The initial plan is invalid", parsed.issues);
    const dir = join(root, KONSORA_DIR);
    const info = await lstat(dir).catch(() => null);
    if (info?.isSymbolicLink())
      fail("unsafe_path", `${KONSORA_DIR} is a symlink; Konsora refuses to follow it`);
    if (info && !info.isDirectory())
      fail("unsafe_path", `${KONSORA_DIR} exists and is not a directory`);
    if (!info) await mkdir(dir);
    const text = serializeDocument(doc);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(
        tasksPath(root),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o644,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        fail(
          "exists",
          `${KONSORA_DIR}/${TASKS_FILE} already exists; Konsora will not overwrite it`,
        );
      }
      throw error;
    }
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { ok: true, document: doc, hash: fileHash(text), text };
  } catch (error) {
    return { ok: false, error: toStoreError(error) };
  }
}

export const BACKUP_V1_FILE = "tasks.v1.json.bak";
export const BACKUP_V2_FILE = "tasks.v2.json.bak";
export const LEGACY_HISTORY_FILE = join("legacy", "v1-history.json");

/**
 * Replaces an old `tasks.json` (v1 or v2) with its migrated v3 text, under the lock. Refuses if
 * the file changed since `expectedText` was read, or if the backup or history file already exist.
 * Order: backup → history (v1 only) → atomic replace, so a crash never loses the original.
 */
export async function writeMigration(
  root: string,
  input:
    | { expectedText: string; text: string; from: "v1"; history: unknown }
    | {
        expectedText: string;
        text: string;
        from: "v2";
      },
  options: StoreOptions = {},
): Promise<{ ok: true; backup: string; history?: string } | { ok: false; error: StoreError }> {
  let release: (() => Promise<void>) | undefined;
  try {
    await ensureSafe(root);
    release = await acquireLock(root, options);
    const current = await readFile(tasksPath(root), "utf8");
    if (current !== input.expectedText)
      fail("invalid", `${TASKS_FILE} changed since the migration preview; run it again`);
    const parsed = parseTasksFile(input.text);
    if (!parsed.ok) fail("invalid", "The migrated plan is invalid", parsed.issues);
    const dir = join(root, KONSORA_DIR);
    const exclusive = async (path: string, text: string) => {
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o644,
      ).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          fail("exists", `${path} already exists; move it away first`);
        throw error;
      });
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    };
    const backup = join(dir, input.from === "v1" ? BACKUP_V1_FILE : BACKUP_V2_FILE);
    await exclusive(backup, current);
    if (input.from === "v2") {
      await writeAtomically(root, input.text);
      return { ok: true, backup };
    }
    const history = join(dir, LEGACY_HISTORY_FILE);
    await mkdir(join(dir, "legacy"), { recursive: true });
    await exclusive(history, `${JSON.stringify(input.history, null, 2)}\n`);
    await writeAtomically(root, input.text);
    return { ok: true, backup, history };
  } catch (error) {
    return { ok: false, error: toStoreError(error) };
  } finally {
    await release?.();
  }
}
