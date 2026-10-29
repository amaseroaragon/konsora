import { API_URL } from "./api";

export interface ConnectorInfo {
  id: string;
  name: string;
  status: "ready" | "simulated" | "missing" | "login_required" | "api_login" | "unsupported" | "error";
  model: string;
  detail: string;
}

export interface PromptResult {
  connector: string;
  model: string;
  text: string;
}

function record(data: unknown): data is Record<string, unknown> {
  return typeof data === "object" && data !== null;
}

async function request(path: string, signal: AbortSignal, body?: object): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/connectors${path}`, {
      signal, cache: "no-store", method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("No se pudo conectar con el servicio local. Comprueba que está iniciado y reintenta.");
  }
  const data: unknown = await response.json();
  if (!response.ok) {
    throw new Error(record(data) && typeof data.detail === "string" ? data.detail : "No se pudo completar la consulta.");
  }
  return data;
}

export async function listConnectors(signal: AbortSignal): Promise<ConnectorInfo[]> {
  const data = await request("", signal);
  const statuses = ["ready", "simulated", "missing", "login_required", "api_login", "unsupported", "error"];
  if (!Array.isArray(data)) throw new Error("La lista de conectores tiene un formato inesperado.");
  return data.map((item: unknown) => {
    if (!record(item) || typeof item.id !== "string" || typeof item.name !== "string" ||
      typeof item.status !== "string" || !statuses.includes(item.status) ||
      typeof item.model !== "string" || typeof item.detail !== "string") {
      throw new Error("El servicio local devolvió un conector con un formato inesperado.");
    }
    return {
      id: item.id, name: item.name, status: item.status as ConnectorInfo["status"],
      model: item.model, detail: item.detail,
    };
  });
}

export async function sendPrompt(
  connector: string, prompt: string, confirmed: boolean, signal: AbortSignal,
): Promise<PromptResult> {
  const data = await request(`/${encodeURIComponent(connector)}/prompt`, signal, {
    prompt, confirm_subscription_use: confirmed,
  });
  if (!record(data) || data.connector !== connector || typeof data.model !== "string" || typeof data.text !== "string") {
    throw new Error("La respuesta del conector tiene un formato inesperado.");
  }
  return { connector, model: data.model, text: data.text };
}
