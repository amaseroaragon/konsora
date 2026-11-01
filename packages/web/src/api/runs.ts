/** Runs over the daemon (DMN-04): launch, cancel, the run list and each run's events. */
import type { AgentSpec, Run } from "@konsora/core";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { appendEvent, type RunEventRecord, upsertRun } from "../shell/run-model.ts";
import { boardKey } from "./board.ts";
import type { Api } from "./client.ts";
import { useApi } from "./projects.ts";

export const runsKey = (project: string) => ["runs", project] as const;
export const runEventsKey = (project: string, run: string) =>
  ["runs", project, run, "events"] as const;

const base = (project: string) => `/projects/${encodeURIComponent(project)}/runs`;

/** Every run of the project, oldest first; kept live by `run.state` over the WebSocket. */
export function useRuns(project: string) {
  const api = useApi();
  return useQuery({
    queryKey: runsKey(project),
    queryFn: async () => (await api.get<{ runs: Run[] }>(base(project))).runs,
  });
}

/** A run's events so far; `run.event` appends the new ones live. */
export function useRunEvents(project: string, run: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: runEventsKey(project, run ?? ""),
    enabled: run !== undefined,
    queryFn: async () =>
      (
        await api.get<{ events: RunEventRecord[] }>(
          `${base(project)}/${encodeURIComponent(run ?? "")}/events`,
        )
      ).events,
  });
}

export type StartRunInput = { task: string; agent?: AgentSpec | undefined };

/** `POST /projects/:id/runs`: the human launches one task. */
export async function startRunRequest(
  api: Api,
  project: string,
  input: StartRunInput,
): Promise<Run> {
  const body = { task: input.task, ...(input.agent ? { agent: input.agent } : {}) };
  return (await api.post<{ run: Run }>(base(project), body)).run;
}

/** `POST /projects/:id/runs/:run/cancel`. */
export async function cancelRunRequest(api: Api, project: string, run: string): Promise<Run> {
  return (await api.post<{ run: Run }>(`${base(project)}/${encodeURIComponent(run)}/cancel`)).run;
}

export function useStartRun(project: string) {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: StartRunInput) => startRunRequest(api, project, input),
    onSuccess: (run) =>
      client.setQueryData<Run[]>(runsKey(project), (runs) => upsertRun(runs, run)),
    onSettled: () => {
      client.invalidateQueries({ queryKey: runsKey(project) });
      client.invalidateQueries({ queryKey: boardKey(project) });
    },
  });
}

export function useCancelRun(project: string) {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (run: string) => cancelRunRequest(api, project, run),
    onSuccess: (run) =>
      client.setQueryData<Run[]>(runsKey(project), (runs) => upsertRun(runs, run)),
    onSettled: () => {
      client.invalidateQueries({ queryKey: runsKey(project) });
      client.invalidateQueries({ queryKey: boardKey(project) });
    },
  });
}

/**
 * Applies a `run.*` WebSocket message to the cache, without refetching: `run.state` replaces the
 * run in the list, `run.event` appends to its events if they are loaded.
 */
export function applyRunMessage(
  client: QueryClient,
  project: string,
  message: { type: string; run?: unknown; event?: unknown },
): void {
  if (message.type === "run.state" && message.run && typeof message.run === "object") {
    const run = message.run as Run;
    client.setQueryData<Run[]>(runsKey(project), (runs) =>
      runs === undefined ? runs : upsertRun(runs, run),
    );
  } else if (message.type === "run.event" && typeof message.run === "string" && message.event) {
    client.setQueryData<RunEventRecord[]>(runEventsKey(project, message.run), (events) =>
      events === undefined ? events : appendEvent(events, message.event as RunEventRecord),
    );
  }
}
