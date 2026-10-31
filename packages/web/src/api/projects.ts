/** Project registry over the daemon: list, link and unlink (TanStack Query). */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import type { Api } from "./client.ts";

export type PlanStatus =
  | { status: "ok"; tasks: number; hash: string }
  | { status: "missing" | "invalid" | "unsafe_path" | "lock_timeout" | "io"; message: string };

export type ProjectSummary = {
  id: string;
  name: string;
  path: string;
  added_at: string;
  plan: PlanStatus;
};

export const ApiContext = createContext<Api | null>(null);

export function useApi(): Api {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi must be used inside <ApiContext.Provider>");
  return api;
}

export const projectsKey = ["projects"] as const;

export function useProjects() {
  const api = useApi();
  return useQuery({
    queryKey: projectsKey,
    queryFn: async () => (await api.get<{ projects: ProjectSummary[] }>("/projects")).projects,
  });
}

export function useLinkProject() {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { path: string; name?: string }) =>
      (await api.post<{ project: Omit<ProjectSummary, "plan"> }>("/projects", input)).project,
    onSuccess: () => client.invalidateQueries({ queryKey: projectsKey }),
  });
}

export function useUnlinkProject() {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/projects/${encodeURIComponent(id)}`),
    onSuccess: () => client.invalidateQueries({ queryKey: projectsKey }),
  });
}
