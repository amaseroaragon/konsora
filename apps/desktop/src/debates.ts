import { API_URL } from "./api";

export interface Debate {
  id: string;
  project_id: string;
  problem: string;
  context: string;
  simulated: true;
  created_at: string;
  updated_at: string;
}

export type ProposalStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface Proposal {
  id: string;
  position: 1 | 2;
  name: string;
  connector: string;
  model: string;
  simulated: true;
  status: ProposalStatus;
  content: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface DebateHistory { debate: Debate; proposals: Proposal[] }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function date(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function nullableText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseDebate(value: unknown): Debate {
  if (!record(value) || typeof value.id !== "string" || typeof value.project_id !== "string" ||
    typeof value.problem !== "string" || typeof value.context !== "string" || value.simulated !== true ||
    !date(value.created_at) || !date(value.updated_at)) {
    throw new Error("El servicio devolvió un debate con un formato inesperado.");
  }
  return { id: value.id, project_id: value.project_id, problem: value.problem, context: value.context,
    simulated: true, created_at: value.created_at, updated_at: value.updated_at };
}

function parseHistory(value: unknown): DebateHistory {
  if (!record(value) || !Array.isArray(value.proposals) || value.proposals.length !== 2) {
    throw new Error("El historial del debate tiene un formato inesperado.");
  }
  const statuses = ["pending", "running", "completed", "failed", "cancelled"];
  const proposals = value.proposals.map((item: unknown): Proposal => {
    if (!record(item) || typeof item.id !== "string" || (item.position !== 1 && item.position !== 2) ||
      typeof item.name !== "string" || typeof item.connector !== "string" || typeof item.model !== "string" ||
      item.simulated !== true || typeof item.status !== "string" || !statuses.includes(item.status) ||
      !nullableText(item.content) || !nullableText(item.error) || !date(item.created_at) ||
      (item.started_at !== null && !date(item.started_at)) || (item.finished_at !== null && !date(item.finished_at))) {
      throw new Error("El servicio devolvió una propuesta con un formato inesperado.");
    }
    return { id: item.id, position: item.position, name: item.name, connector: item.connector, model: item.model,
      simulated: true, status: item.status as ProposalStatus, content: item.content, error: item.error,
      created_at: item.created_at, started_at: item.started_at, finished_at: item.finished_at };
  });
  if (proposals[0].position !== 1 || proposals[1].position !== 2) {
    throw new Error("El orden de las propuestas es inesperado.");
  }
  return { debate: parseDebate(value.debate), proposals };
}

async function request(project: string, path: string, signal: AbortSignal, body?: object): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/projects/${encodeURIComponent(project)}/debates${path}`, {
      signal, cache: "no-store", method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("No se pudo conectar con el servicio local. Actualiza el debate para consultar lo que llegó a guardarse.");
  }
  const data: unknown = await response.json();
  if (!response.ok) throw new Error(record(data) && typeof data.detail === "string" ? data.detail : "No se pudo completar la operación del debate.");
  return data;
}

export async function listDebates(project: string, signal: AbortSignal): Promise<Debate[]> {
  const data = await request(project, "", signal);
  if (!Array.isArray(data)) throw new Error("La lista de debates tiene un formato inesperado.");
  return data.map(parseDebate);
}
export async function createDebate(project: string, problem: string, context: string, signal: AbortSignal): Promise<DebateHistory> {
  return parseHistory(await request(project, "", signal, { problem, context }));
}
export async function openDebate(project: string, debate: string, signal: AbortSignal): Promise<DebateHistory> {
  return parseHistory(await request(project, `/${encodeURIComponent(debate)}`, signal));
}
export async function runDebate(project: string, debate: string, signal: AbortSignal): Promise<DebateHistory> {
  return parseHistory(await request(project, `/${encodeURIComponent(debate)}/run`, signal, {}));
}
