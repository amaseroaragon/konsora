/** The AI panel's planning chat over the daemon: its messages, sending, stopping and resetting. */
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "./projects.ts";

export type ChatRole = "human" | "agent" | "tool" | "error";
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

export function useSendChat(projectId: string) {
  const api = useApi();
  return useChatMutation(
    projectId,
    async (text: string) => (await api.post<{ chat: Chat }>(path(projectId), { text })).chat,
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
