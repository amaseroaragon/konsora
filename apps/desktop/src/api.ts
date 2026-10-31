import { apiFetch } from "./transport";

// Contrato de GET /health, definido en services/api/konsora_api/main.py.
export interface HealthResponse {
  status: "ok";
  service: "konsora-api";
}

export interface Project {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  workspace_path: string | null;
  workspace_status: "unassigned" | "ready" | "missing" | "inaccessible" | "unsafe";
}

export async function getHealth(signal: AbortSignal): Promise<HealthResponse> {
  const response = await apiFetch("/health", {
    signal,
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`La API respondió con el código ${response.status}.`);
  }

  const data: unknown = await response.json();
  if (
    typeof data !== "object" ||
    data === null ||
    !("status" in data) ||
    !("service" in data) ||
    data.status !== "ok" ||
    data.service !== "konsora-api"
  ) {
    throw new Error("La respuesta de la API no tiene el formato esperado.");
  }

  return { status: data.status, service: data.service };
}

async function projectRequest(path = "", options: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timeout = window.setTimeout(abort, 5000);

  try {
    let response: Response;
    try {
      response = await apiFetch(`/projects${path}`, {
        ...options,
        signal: controller.signal,
        cache: "no-store",
      });
    } catch {
      throw new Error("No se pudo conectar con el servicio local. Comprueba la conexión y vuelve a intentarlo.");
    }
    if (response.status === 204) return undefined;
    const data: unknown = await response.json();
    if (!response.ok) {
      const detail = typeof data === "object" && data !== null && "detail" in data ? data.detail : null;
      throw new Error(
        typeof detail === "string"
          ? detail
          : "No se pudo guardar el cambio. Revisa el nombre del proyecto e inténtalo de nuevo.",
      );
    }
    return data;
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

function parseProject(data: unknown): Project {
  if (
    typeof data !== "object" || data === null ||
    !("id" in data) || typeof data.id !== "string" ||
    !("name" in data) || typeof data.name !== "string" ||
    !("created_at" in data) || typeof data.created_at !== "string" ||
    !("updated_at" in data) || typeof data.updated_at !== "string" ||
    !("workspace_path" in data) || (data.workspace_path !== null && typeof data.workspace_path !== "string") ||
    !("workspace_status" in data) ||
    !["unassigned", "ready", "missing", "inaccessible", "unsafe"].includes(String(data.workspace_status)) ||
    !Number.isFinite(Date.parse(data.created_at)) || !Number.isFinite(Date.parse(data.updated_at))
  ) {
    throw new Error("El servicio local devolvió un proyecto con un formato inesperado.");
  }
  return {
    id: data.id, name: data.name, created_at: data.created_at, updated_at: data.updated_at,
    workspace_path: data.workspace_path, workspace_status: data.workspace_status as Project["workspace_status"],
  };
}

export async function listProjects(signal: AbortSignal): Promise<Project[]> {
  const data = await projectRequest("", { signal });
  if (!Array.isArray(data)) throw new Error("La lista de proyectos tiene un formato inesperado.");
  return data.map(parseProject);
}

export async function openProject(id: string): Promise<Project> {
  return parseProject(await projectRequest(`/${encodeURIComponent(id)}`));
}

export async function createProject(name: string): Promise<Project> {
  return parseProject(await projectRequest("", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }));
}

export async function renameProject(id: string, name: string): Promise<Project> {
  return parseProject(await projectRequest(`/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }));
}

export async function deleteProject(id: string): Promise<void> {
  await projectRequest(`/${encodeURIComponent(id)}?confirm=true`, { method: "DELETE" });
}

export async function setProjectWorkspace(id: string, workspacePath: string | null): Promise<Project> {
  return parseProject(await projectRequest(`/${encodeURIComponent(id)}/workspace`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace_path: workspacePath }),
  }));
}
