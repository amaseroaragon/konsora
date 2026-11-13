/** The AI panel's planning chat over the daemon: its messages, sending, stopping and resetting. */
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "./projects.ts";

export type ChatRole = "human" | "agent" | "tool" | "error" | "stopped";
export type ChatMessage = { id: number; role: ChatRole; text: string; at: string };
export type Chat = { messages: ChatMessage[]; busy: boolean };

export const chatKey = (projectId: string) => ["chat", projectId] as const;

const path = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/chat`;

export function useChat(projectId: string) {
  const api = useApi();
  return useQuery({
    queryKey: chatKey(projectId),
    queryFn: async () => (await api.get<{ chat: Chat }>(path(projectId))).chat,
  });
}

/** A `chat.updated` event carries the whole conversation: it replaces the cached one. */
export function applyChatMessage(
  client: QueryClient,
  projectId: string,
  message: { chat?: unknown },
) {
  const chat = message.chat as Chat | undefined;
  if (chat && Array.isArray(chat.messages)) client.setQueryData(chatKey(projectId), chat);
}

function useChatMutation<T>(projectId: string, run: (input: T) => Promise<Chat | null>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (chat) => {
      client.setQueryData<Chat>(chatKey(projectId), chat ?? { messages: [], busy: false });
    },
  });
}

/** The models the panel offers (DMN-06); "" is Claude Code's own default. */
export const CHAT_MODELS = ["", "opus", "sonnet", "haiku"] as const;
export type ChatModel = (typeof CHAT_MODELS)[number];

const modelKey = (projectId: string) => `konsora.chat.model.${projectId}`;

/** The model chosen for this project's panel, remembered in this browser. */
export function readChatModel(projectId: string): ChatModel {
  try {
    const value = window.localStorage.getItem(modelKey(projectId)) ?? "";
    return (CHAT_MODELS as readonly string[]).includes(value) ? (value as ChatModel) : "";
  } catch {
    return "";
  }
}

export function writeChatModel(projectId: string, model: ChatModel) {
  try {
    if (model) window.localStorage.setItem(modelKey(projectId), model);
    else window.localStorage.removeItem(modelKey(projectId));
  } catch {
    // Not remembered; the choice still applies on this page.
  }
}

/** The body of one message: the text, and the model only when one was chosen. */
export function chatBody(text: string, model: ChatModel): { text: string; model?: string } {
  return model ? { text, model } : { text };
}

export function useSendChat(projectId: string) {
  const api = useApi();
  return useChatMutation(
    projectId,
    async ({ text, model = "" }: { text: string; model?: ChatModel }) =>
      (await api.post<{ chat: Chat }>(path(projectId), chatBody(text, model))).chat,
  );
}

export function useStopChat(projectId: string) {
  const api = useApi();
  return useChatMutation(
    projectId,
    async (_: undefined) => (await api.post<{ chat: Chat }>(`${path(projectId)}/stop`)).chat,
  );
}

export function useResetChat(projectId: string) {
  const api = useApi();
  return useChatMutation(projectId, async (_: undefined) => {
    await api.del(path(projectId));
    return null;
  });
}
