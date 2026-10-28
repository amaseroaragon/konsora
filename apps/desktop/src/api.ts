// Contrato de GET /health, definido en services/api/konsora_api/main.py.
export interface HealthResponse {
  status: "ok";
  service: "konsora-api";
}

export const API_URL = (
  import.meta.env.VITE_API_URL || "http://127.0.0.1:8000"
).replace(/\/$/, "");

export async function getHealth(signal: AbortSignal): Promise<HealthResponse> {
  const response = await fetch(`${API_URL}/health`, {
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
