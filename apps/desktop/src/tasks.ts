import { API_URL } from "./api";

export type TaskStatus = "proposal" | "pending" | "in_progress" | "in_review" | "done";
export type AttemptStatus = "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export interface Task {
  id: string; project_id: string; title: string; description: string; acceptance_criteria: string;
  sort_order: number; status: TaskStatus; version: number; created_at: string; updated_at: string;
  dependencies: string[]; blocked_by: string[]; blocked: boolean;
  last_attempt_status: AttemptStatus | null; last_attempt_error: string | null;
  source_revision: string | null; fingerprint: string | null; declared_status: TaskStatus | null; review_required: boolean;
}
export interface TaskAttempt {
  id: string; task_id: string; task_version: number; task_snapshot: Task;
  connector: string; model: string | null; status: AttemptStatus; result: string; error: string | null;
  started_at: string; finished_at: string | null;
}
export interface TaskActivity {
  id: number; task_id: string; task_version: number; event: string;
  actor: "user" | "supervisor" | "external"; detail: string; created_at: string;
}
export interface TaskDetails { task: Task; attempts: TaskAttempt[]; activity: TaskActivity[]; read_only: boolean }
export interface TaskSource {
  mode: "files" | "legacy" | "uninitialized" | "unassigned";
  revision: string | null; can_write: boolean; file_path: string | null; legacy_count: number;
}
export interface TaskBoardData { source: TaskSource; tasks: Task[] }
export interface MigrationPreview {
  target: string; legacy_revision: string; task_count: number; attempt_count: number; activity_count: number; file_exists: boolean;
}
export interface PromptRequest { task_ids: string[]; expected_revision: string; context: string }
export interface PreparedPrompt {
  source: string; revision: string; fingerprint: string; task_ids: string[]; text: string;
  blocked: { task_id: string; dependency_id: string; selected: boolean }[]; other_states: string[];
}
export interface TaskFields {
  title: string; description?: string; acceptance_criteria?: string; sort_order?: number; dependencies?: string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function date(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}
function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
function attemptStatus(value: unknown): value is AttemptStatus {
  return typeof value === "string" && ["running", "succeeded", "failed", "cancelled", "interrupted"].includes(value);
}
function invalid(): never { throw new Error("El servicio devolvió datos de tareas con un formato inesperado."); }

function parseTask(value: unknown): Task {
  if (!record(value) || typeof value.id !== "string" || typeof value.project_id !== "string" ||
    typeof value.title !== "string" || typeof value.description !== "string" || typeof value.acceptance_criteria !== "string" ||
    !Number.isInteger(value.sort_order) || Number(value.sort_order) < 0 ||
    !Number.isInteger(value.version) || Number(value.version) < 1 ||
    typeof value.status !== "string" || !["proposal", "pending", "in_progress", "in_review", "done"].includes(value.status) ||
    !date(value.created_at) || !date(value.updated_at) || !strings(value.dependencies) || !strings(value.blocked_by) ||
    typeof value.blocked !== "boolean" || (value.last_attempt_status !== null && !attemptStatus(value.last_attempt_status)) ||
    !nullableString(value.last_attempt_error) || !nullableString(value.source_revision) || !nullableString(value.fingerprint) ||
    typeof value.review_required !== "boolean") return invalid();
  return value as unknown as Task;
}

function parseDetails(value: unknown): TaskDetails {
  if (!record(value) || !Array.isArray(value.attempts) || !Array.isArray(value.activity)) return invalid();
  const attempts = value.attempts.map((item: unknown): TaskAttempt => {
    if (!record(item) || typeof item.id !== "string" || typeof item.task_id !== "string" ||
      !Number.isInteger(item.task_version) || Number(item.task_version) < 1 ||
      typeof item.connector !== "string" || !nullableString(item.model) || !attemptStatus(item.status) ||
      typeof item.result !== "string" || !nullableString(item.error) || !date(item.started_at) ||
      (item.finished_at !== null && !date(item.finished_at))) return invalid();
    return { ...item, task_snapshot: parseTask(item.task_snapshot) } as unknown as TaskAttempt;
  });
  const activity = value.activity.map((item: unknown): TaskActivity => {
    if (!record(item) || !Number.isInteger(item.id) || typeof item.task_id !== "string" ||
      !Number.isInteger(item.task_version) || Number(item.task_version) < 1 ||
      typeof item.event !== "string" || !["user", "supervisor", "external"].includes(String(item.actor)) ||
      typeof item.detail !== "string" || !date(item.created_at)) return invalid();
    return item as unknown as TaskActivity;
  });
  return { task: parseTask(value.task), attempts, activity, read_only: value.read_only === true };
}

async function request(project: string, path: string, signal: AbortSignal, method = "GET", body?: object): Promise<unknown> {
  const response = await fetch(`${API_URL}/projects/${encodeURIComponent(project)}/tasks${path}`, {
    signal, cache: "no-store", method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => { throw new Error("No se pudo conectar con el servicio local. Actualiza las tareas antes de repetir la operación."); });
  if (response.status === 204) return undefined;
  const data: unknown = await response.json();
  if (!response.ok) throw new Error(record(data) && typeof data.detail === "string" ? data.detail : "No se pudo completar la operación de la tarea.");
  return data;
}

export async function listTasks(project: string, signal: AbortSignal): Promise<Task[]> {
  const data = await request(project, "", signal);
  if (!Array.isArray(data)) return invalid();
  return data.map(parseTask);
}
export async function createTask(project: string, fields: TaskFields & { status?: "proposal" | "pending" }, signal: AbortSignal, revision?: string | null): Promise<Task> {
  return parseTask(await request(project, "", signal, "POST", { ...fields, expected_revision: revision }));
}
export async function openTask(project: string, id: string, signal: AbortSignal): Promise<TaskDetails> {
  return parseDetails(await request(project, `/${encodeURIComponent(id)}`, signal));
}
export async function editTask(project: string, id: string, version: number, fields: Partial<TaskFields>, signal: AbortSignal, revision?: string | null): Promise<Task> {
  return parseTask(await request(project, `/${encodeURIComponent(id)}`, signal, "PATCH", { ...fields, expected_version: version, expected_revision: revision }));
}
export async function changeTaskStatus(project: string, id: string, version: number, status: TaskStatus, comment: string, signal: AbortSignal, revision?: string | null): Promise<Task> {
  return parseTask(await request(project, `/${encodeURIComponent(id)}/status`, signal, "POST", { status, comment, expected_version: version, expected_revision: revision }));
}
export async function deleteTask(project: string, id: string, version: number, signal: AbortSignal, revision?: string | null): Promise<void> {
  await request(project, `/${encodeURIComponent(id)}?expected_version=${encodeURIComponent(version)}&expected_revision=${encodeURIComponent(revision ?? "")}&confirm=true`, signal, "DELETE");
}

export async function loadTaskBoard(project: string, signal: AbortSignal): Promise<TaskBoardData> {
  const data = await request(project, "/board", signal);
  if (!record(data) || !record(data.source) || !Array.isArray(data.tasks)) return invalid();
  const source = data.source;
  if (!["files", "legacy", "uninitialized", "unassigned"].includes(String(source.mode)) ||
    !nullableString(source.revision) || !nullableString(source.file_path) || typeof source.can_write !== "boolean" ||
    !Number.isInteger(source.legacy_count)) return invalid();
  return { source: source as unknown as TaskSource, tasks: data.tasks.map(parseTask) };
}

export async function previewTaskMigration(project: string, signal: AbortSignal): Promise<MigrationPreview> {
  const data = await request(project, "/migration", signal);
  if (!record(data) || typeof data.target !== "string" || typeof data.legacy_revision !== "string" ||
    !Number.isInteger(data.task_count) || !Number.isInteger(data.attempt_count) || !Number.isInteger(data.activity_count) ||
    typeof data.file_exists !== "boolean") return invalid();
  return data as unknown as MigrationPreview;
}

export async function initializeTaskFile(project: string, preview: MigrationPreview, signal: AbortSignal): Promise<void> {
  await request(project, "/initialize", signal, "POST", {
    mode: preview.task_count ? "migrate" : "empty", legacy_revision: preview.legacy_revision, target: preview.target, confirm: true,
  });
}

function parsePrompt(data: unknown): PreparedPrompt {
  if (!record(data) || typeof data.source !== "string" || typeof data.revision !== "string" ||
    typeof data.fingerprint !== "string" || typeof data.text !== "string" || !strings(data.task_ids) ||
    !strings(data.other_states) || !Array.isArray(data.blocked) || !data.blocked.every((item: unknown) =>
      record(item) && typeof item.task_id === "string" && typeof item.dependency_id === "string" && typeof item.selected === "boolean")) return invalid();
  return data as unknown as PreparedPrompt;
}

export async function prepareTaskPrompt(project: string, input: PromptRequest, signal: AbortSignal): Promise<PreparedPrompt> {
  return parsePrompt(await request(project, "/prompt/preview", signal, "POST", input));
}
export async function validateTaskPrompt(project: string, input: PromptRequest, fingerprint: string, signal: AbortSignal): Promise<PreparedPrompt> {
  return parsePrompt(await request(project, "/prompt/validate", signal, "POST", { ...input, prompt_fingerprint: fingerprint }));
}
export async function saveTaskPrompt(project: string, input: PromptRequest, fingerprint: string, filename: string, signal: AbortSignal): Promise<string> {
  const data = await request(project, "/prompt/save", signal, "POST", { ...input, prompt_fingerprint: fingerprint, filename });
  if (!record(data) || typeof data.path !== "string" || typeof data.fingerprint !== "string") return invalid();
  return data.path;
}
