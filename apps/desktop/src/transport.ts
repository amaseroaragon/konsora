import { invoke, isTauri } from "@tauri-apps/api/core";

// La clave privada pertenece a Rust; nunca pasa al WebView.
export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  options.signal?.throwIfAborted();
  if (!isTauri()) return fetch(`/api${path}`, { ...options, cache: "no-store" });
  const result = await invoke<{ status: number; body: unknown }>("api_request", {
    path, method: options.method ?? "GET",
    body: typeof options.body === "string" ? JSON.parse(options.body) : null,
  });
  options.signal?.throwIfAborted();
  return new Response(result.status === 204 ? null : JSON.stringify(result.body), {
    status: result.status, headers: { "Content-Type": "application/json" },
  });
}
