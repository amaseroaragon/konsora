/** Runs over the daemon (DMN-04): launch, cancel, the run list and each run's events. */
import type { AgentSpec, ChecksFile, Run } from "@konsora/core";
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
    // A check that ended (or a retry) changes checks.json: read it again.
    const event = message.event as RunEventRecord;
    if ((event.t === "check" && event.phase === "end") || event.t === "retry") {
      client.invalidateQueries({ queryKey: runChecksKey(project, message.run) });
    }
  }
}

export const runDiffKey = (project: string, run: string) => ["runs", project, run, "diff"] as const;
export const runChecksKey = (project: string, run: string) =>
  ["runs", project, run, "checks"] as const;

/** The run's `checks.json`: every attempt (null before its checks ran). */
export function useRunChecks(project: string, run: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: runChecksKey(project, run),
    enabled,
    queryFn: async () =>
      (
        await api.get<{ checks: ChecksFile | null }>(
          `${base(project)}/${encodeURIComponent(run)}/checks`,
        )
      ).checks,
  });
}

/** The run's `diff.patch` (null until it closes). */
export function useRunDiff(project: string, run: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: runDiffKey(project, run),
    enabled,
    queryFn: async () =>
      (await api.get<{ diff: string | null }>(`${base(project)}/${encodeURIComponent(run)}/diff`))
        .diff,
  });
}

/** `POST /projects/:id/runs/:run/resume`: the human resumes an interrupted run (RUN-27). */
export async function resumeRunRequest(api: Api, project: string, run: string): Promise<Run> {
  return (await api.post<{ run: Run }>(`${base(project)}/${encodeURIComponent(run)}/resume`)).run;
}

/** Resume keeps the same run: the cache takes its new state, and its log keeps growing. */
export function useResumeRun(project: string) {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (run: string) => resumeRunRequest(api, project, run),
    onSuccess: (run) =>
      client.setQueryData<Run[]>(runsKey(project), (runs) => upsertRun(runs, run)),
    onSettled: () => {
      client.invalidateQueries({ queryKey: runsKey(project) });
      client.invalidateQueries({ queryKey: boardKey(project) });
    },
  });
}

/**
 * `POST /projects/:id/runs/:run/review`: the human asks for a read-only review of a succeeded
 * run (RUN-29), by `agent` or else the project's reviewer. Resolves with the new review run.
 */
export async function requestReviewRequest(
  api: Api,
  project: string,
  run: string,
  agent?: AgentSpec,
): Promise<Run> {
  const url = `${base(project)}/${encodeURIComponent(run)}/review`;
  return (await api.post<{ run: Run }>(url, agent ? { agent } : {})).run;
}

export function useRequestReview(project: string) {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (run: string) => requestReviewRequest(api, project, run),
    onSuccess: (run) =>
      client.setQueryData<Run[]>(runsKey(project), (runs) => upsertRun(runs, run)),
    onSettled: () => client.invalidateQueries({ queryKey: runsKey(project) }),
  });
}

/** `POST /projects/:id/runs/:run/discard`: the human drops a finished run's work. */
export async function discardRunRequest(api: Api, project: string, run: string): Promise<Run> {
  return (await api.post<{ run: Run }>(`${base(project)}/${encodeURIComponent(run)}/discard`)).run;
}

export function useDiscardRun(project: string) {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (run: string) => discardRunRequest(api, project, run),
    onSuccess: (run) =>
      client.setQueryData<Run[]>(runsKey(project), (runs) => upsertRun(runs, run)),
    onSettled: () => client.invalidateQueries({ queryKey: runsKey(project) }),
  });
}

export type OrphanWorktree = {
  worktree?: string;
  branch?: string;
  reason: "no_run" | "run_closed" | "missing_dir" | "stray_dir";
};

export const orphansKey = (project: string) => ["runs", project, "orphans"] as const;

/** Konsora worktrees and branches no run needs any more (refetched with the runs). */
export function useOrphans(project: string) {
  const api = useApi();
  return useQuery({
    queryKey: orphansKey(project),
    queryFn: async () =>
      (
        await api.get<{ orphans: OrphanWorktree[] }>(
          `/projects/${encodeURIComponent(project)}/worktrees/orphans`,
        )
      ).orphans,
  });
}
