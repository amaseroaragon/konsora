import { API_URL } from "./api";

export type TaskStatus = "proposal" | "pending" | "in_progress" | "in_review" | "done";
export type AttemptStatus = "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export interface Task {
  id: string; project_id: string; title: string; description: string; acceptance_criteria: string;
  sort_order: number; status: TaskStatus; version: number; created_at: string; updated_at: string;
  dependencies: string[]; blocked_by: string[]; blocked: boolean;
  last_attempt_status: AttemptStatus | null; last_attempt_error: string | null;
}
export interface TaskAttempt {
  id: string; task_id: string; task_version: number; task_snapshot: Task;
  connector: string; model: string | null; status: AttemptStatus; result: string; error: string | null;
  started_at: string; finished_at: string | null;
}
export interface TaskActivity {
  id: number; task_id: string; task_version: number; event: string;
  actor: "user" | "supervisor"; detail: string; created_at: string;
}
export interface TaskDetails { task: Task; attempts: TaskAttempt[]; activity: TaskActivity[] }
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
    !nullableString(value.last_attempt_error)) return invalid();
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
      typeof item.event !== "string" || (item.actor !== "user" && item.actor !== "supervisor") ||
      typeof item.detail !== "string" || !date(item.created_at)) return invalid();
    return item as unknown as TaskActivity;
  });
  return { task: parseTask(value.task), attempts, activity };
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
export async function createTask(project: string, fields: TaskFields & { status?: "proposal" | "pending" }, signal: AbortSignal): Promise<Task> {
  return parseTask(await request(project, "", signal, "POST", fields));
}
export async function openTask(project: string, id: string, signal: AbortSignal): Promise<TaskDetails> {
  return parseDetails(await request(project, `/${encodeURIComponent(id)}`, signal));
}
export async function editTask(project: string, id: string, version: number, fields: Partial<TaskFields>, signal: AbortSignal): Promise<Task> {
  return parseTask(await request(project, `/${encodeURIComponent(id)}`, signal, "PATCH", { ...fields, expected_version: version }));
}
export async function changeTaskStatus(project: string, id: string, version: number, status: TaskStatus, comment: string, signal: AbortSignal): Promise<Task> {
  return parseTask(await request(project, `/${encodeURIComponent(id)}/status`, signal, "POST", { status, comment, expected_version: version }));
}
export async function deleteTask(project: string, id: string, version: number, signal: AbortSignal): Promise<void> {
  await request(project, `/${encodeURIComponent(id)}?expected_version=${encodeURIComponent(version)}&confirm=true`, signal, "DELETE");
}
