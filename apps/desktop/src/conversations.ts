import { API_URL } from "./api";

export interface Conversation {
  id: string;
  project_id: string;
  title: string;
  connector: string;
  model: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  position: number;
  role: "user" | "assistant";
  content: string;
  connector: string;
  model: string;
  created_at: string;
}

export interface ConversationHistory { conversation: Conversation; messages: Message[] }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function date(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseConversation(value: unknown): Conversation {
  if (!record(value) || typeof value.id !== "string" || typeof value.project_id !== "string" ||
    typeof value.title !== "string" || typeof value.connector !== "string" ||
    (value.model !== null && typeof value.model !== "string") || !date(value.created_at) || !date(value.updated_at)) {
    throw new Error("El servicio devolvió un chat con un formato inesperado.");
  }
  return { id: value.id, project_id: value.project_id, title: value.title, connector: value.connector,
    model: value.model, created_at: value.created_at, updated_at: value.updated_at };
}

function parseHistory(value: unknown): ConversationHistory {
  if (!record(value) || !Array.isArray(value.messages)) throw new Error("El historial tiene un formato inesperado.");
  const messages = value.messages.map((item: unknown): Message => {
    if (!record(item) || typeof item.id !== "string" || typeof item.position !== "number" ||
      (item.role !== "user" && item.role !== "assistant") || typeof item.content !== "string" ||
      typeof item.connector !== "string" || typeof item.model !== "string" || !date(item.created_at)) {
      throw new Error("El servicio devolvió un mensaje con un formato inesperado.");
    }
    return { id: item.id, position: item.position, role: item.role, content: item.content,
      connector: item.connector, model: item.model, created_at: item.created_at };
  });
  return { conversation: parseConversation(value.conversation), messages };
}

async function request(project: string, path: string, signal: AbortSignal, body?: object): Promise<unknown> {
  const response = await fetch(`${API_URL}/projects/${encodeURIComponent(project)}/conversations${path}`, {
    signal, cache: "no-store", method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => { throw new Error("No se pudo conectar con el servicio local. Revisa el historial antes de reenviar un mensaje."); });
  const data: unknown = await response.json();
  if (!response.ok) throw new Error(record(data) && typeof data.detail === "string" ? data.detail : "No se pudo completar la operación del chat.");
  return data;
}

export async function listConversations(project: string, signal: AbortSignal): Promise<Conversation[]> {
  const data = await request(project, "", signal);
  if (!Array.isArray(data)) throw new Error("La lista de chats tiene un formato inesperado.");
  return data.map(parseConversation);
}

export async function createConversation(project: string, title: string, signal: AbortSignal): Promise<Conversation> {
  return parseConversation(await request(project, "", signal, { title }));
}

export async function openConversation(project: string, chat: string, signal: AbortSignal): Promise<ConversationHistory> {
  return parseHistory(await request(project, `/${encodeURIComponent(chat)}`, signal));
}

export async function sendMessage(
  project: string, chat: string, content: string, connector: string, model: string | null,
  confirmed: boolean, signal: AbortSignal,
): Promise<ConversationHistory> {
  return parseHistory(await request(project, `/${encodeURIComponent(chat)}/messages`, signal, {
    content, connector, model, confirm_subscription_use: confirmed,
  }));
}
