/** `GET /api/agents`: what each provider offers (DMN-05), for the agent selector. */
import type { AgentCatalogEntry } from "@konsora/core";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "./projects.ts";

export const agentsKey = ["agents"] as const;

export function useAgents() {
  const api = useApi();
  return useQuery({
    queryKey: agentsKey,
    queryFn: async () => (await api.get<{ agents: AgentCatalogEntry[] }>("/agents")).agents,
    // The daemon keeps it for 30 s; the selector does not need it fresher.
    staleTime: 30_000,
  });
}
