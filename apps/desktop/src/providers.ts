import { API_URL } from "./api";

export interface ProviderInfo {
  id: string;
  name: string;
  available: boolean;
  models: string[];
  detail: string;
}

export interface Generation {
  provider: string;
  model: string;
  text: string;
}

function isRecord(data: unknown): data is Record<string, unknown> {
  return typeof data === "object" && data !== null;
}

async function request(path: string, signal: AbortSignal, body?: object): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/providers${path}`, {
      signal, cache: "no-store", method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("No se pudo completar la conexión con el servicio local. Comprueba que está iniciado. Si ya enviaste a OpenAI, la petición puede haber consumido tokens.");
  }
  let data: unknown;
  try { data = await response.json(); } catch {
    throw new Error("El servicio local devolvió una respuesta con un formato inesperado.");
  }
  if (!response.ok) {
    throw new Error(isRecord(data) && typeof data.detail === "string"
      ? data.detail : "No se pudo completar la petición al proveedor.");
  }
  return data;
}

export async function listProviders(signal: AbortSignal): Promise<ProviderInfo[]> {
  const data = await request("", signal);
  if (!Array.isArray(data)) throw new Error("La lista de proveedores tiene un formato inesperado.");
  return data.map((item: unknown) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string" ||
      typeof item.available !== "boolean" || typeof item.detail !== "string" ||
      !Array.isArray(item.models) || !item.models.every((model: unknown) => typeof model === "string")) {
      throw new Error("El servicio local devolvió un proveedor con un formato inesperado.");
    }
    return { id: item.id, name: item.name, available: item.available, models: item.models, detail: item.detail };
  });
}

export async function generate(
  provider: string, model: string, prompt: string, maxOutputTokens: number, signal: AbortSignal,
): Promise<Generation> {
  const data = await request(`/${encodeURIComponent(provider)}/generate`, signal, {
    model, prompt, max_output_tokens: maxOutputTokens,
  });
  if (!isRecord(data) || data.provider !== provider || data.model !== model || typeof data.text !== "string") {
    throw new Error("La respuesta del proveedor tiene un formato inesperado.");
  }
  return { provider, model, text: data.text };
}
