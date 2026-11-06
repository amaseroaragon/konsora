/**
 * `GET /api/limits` (DMN-06): each provider's rate limits, read without a run, with their source
 * and date. `limits.updated` on the WebSocket replaces them in the cache without refetching.
 */
import type { ProviderLimits } from "@konsora/core";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useApi } from "./projects.ts";
import { reconnectDelay, TOKEN_KEY } from "./session.ts";

export const limitsKey = ["limits"] as const;

/** How often the page asks again (the daemon reads the providers at most once a minute). */
const REFETCH_MS = 60_000;

export function useLimits() {
  const api = useApi();
  return useQuery({
    queryKey: limitsKey,
    queryFn: async () => (await api.get<{ limits: ProviderLimits[] }>("/limits")).limits,
    staleTime: REFETCH_MS,
    refetchInterval: REFETCH_MS,
  });
}

/** Applies a `limits.updated` message to the cache. */
export function applyLimitsMessage(client: QueryClient, message: { limits?: unknown }): void {
  if (Array.isArray(message.limits)) {
    client.setQueryData<ProviderLimits[]>(limitsKey, message.limits as ProviderLimits[]);
  }
}

/** `GET /api/limits?refresh=1`: the daemon reads the providers again now. */
export function useRefreshLimits() {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      (await api.get<{ limits: ProviderLimits[] }>("/limits?refresh=1")).limits,
    onSuccess: (limits) => client.setQueryData(limitsKey, limits),
  });
}

/**
 * Listens to `limits.updated` outside a project page: an authenticated WebSocket with no
 * subscription (limits describe the account). Reconnects like the board's, and asks again after
 * reconnecting in case an update was missed.
 */
export function useLimitsEvents(): void {
  const client = useQueryClient();
  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: number | undefined;
    let attempt = 0;
    let closed = false;
    const connect = () => {
      let token: string | null = null;
      try {
        token = window.sessionStorage.getItem(TOKEN_KEY);
      } catch {
        token = null;
      }
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${scheme}://${window.location.host}/api/ws`);
      socket.onopen = () => socket?.send(JSON.stringify({ type: "auth", token }));
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as { type: string; limits?: unknown };
        if (message.type === "ready") {
          if (attempt > 0) client.invalidateQueries({ queryKey: limitsKey });
          attempt = 0;
        } else if (message.type === "limits.updated") applyLimitsMessage(client, message);
      };
      socket.onclose = (event) => {
        if (closed || event.code === 4401) return;
        timer = window.setTimeout(connect, reconnectDelay(attempt++));
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      socket?.close();
    };
  }, [client]);
}
