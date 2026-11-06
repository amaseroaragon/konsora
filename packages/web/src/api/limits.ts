/**
 * `GET /api/limits` (DMN-06): each provider's rate limits, read without a run, with their source
 * and date. `limits.updated` on the WebSocket replaces them in the cache without refetching.
 */
import type { ProviderLimits } from "@konsora/core";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { useApi } from "./projects.ts";

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
