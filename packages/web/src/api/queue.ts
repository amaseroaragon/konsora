/**
 * The run queue over the daemon (DMN-08): each project's queue with why each entry waits, the
 * parallelism limits, and asking the agent to rebase a conflicting run (RUN-24). `queue.*` on the
 * WebSocket keeps them live.
 */
import type {
  AgentSpec,
  ParallelLimits,
  QueueEntryStatus,
  QueueFile,
  Run,
  SlotUsage,
} from "@konsora/core";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { upsertRun } from "../shell/run-model.ts";
import { boardKey } from "./board.ts";
import { useApi } from "./projects.ts";
import { applyRunMessage, runsKey } from "./runs.ts";
import { reconnectDelay, TOKEN_KEY } from "./session.ts";

export type QueueView = {
  queue: QueueFile;
  status: QueueEntryStatus[];
  limits: ParallelLimits;
  usage: SlotUsage;
};

export const queueKey = (project: string) => ["queue", project] as const;
export const parallelKey = ["parallel"] as const;

const base = (project: string) => `/projects/${encodeURIComponent(project)}/queue`;

export function useQueue(project: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: queueKey(project),
    enabled,
    queryFn: () => api.get<QueueView>(base(project)),
  });
}

export type QueueItem = { task: string; agent?: AgentSpec | undefined };

/** Every change of the queue answers with the new view; it replaces the cache. */
function useQueueMutation<T, R extends QueueView>(
  project: string,
  request: (input: T) => Promise<R>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (view) => client.setQueryData(queueKey(project), view),
    onSettled: () => client.invalidateQueries({ queryKey: queueKey(project) }),
  });
}

/** `POST /projects/:id/queue`: the human queues the selected tasks with the chosen agent. */
export function useEnqueue(project: string) {
  const api = useApi();
  return useQueueMutation(project, (items: readonly QueueItem[]) =>
    api.post<QueueView & { added: string[]; already: string[] }>(base(project), {
      items: items.map((item) => ({
        task: item.task,
        ...(item.agent ? { agent: item.agent } : {}),
      })),
    }),
  );
}

export function useDequeue(project: string) {
  const api = useApi();
  return useQueueMutation(project, async (task: string) => {
    await api.del(`${base(project)}/${encodeURIComponent(task)}`);
    return api.get<QueueView>(base(project));
  });
}

export function useQueueAction(project: string) {
  const api = useApi();
  return useQueueMutation(project, (action: "pause" | "resume" | "clear") =>
    api.post<QueueView>(`${base(project)}/${action}`),
  );
}

export function useParallel() {
  const api = useApi();
  return useQuery({
    queryKey: parallelKey,
    queryFn: async () => (await api.get<{ limits: ParallelLimits }>("/settings/parallel")).limits,
  });
}

export function useSetParallel() {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (limits: ParallelLimits) =>
      (await api.put<{ limits: ParallelLimits }>("/settings/parallel", limits)).limits,
    onSuccess: (limits) => {
      client.setQueryData(parallelKey, limits);
      client.invalidateQueries({ queryKey: ["queue"] });
    },
  });
}

/** `POST /projects/:id/runs/:run/rebase`: the agent rebases a run whose integration conflicts. */
export function useRebaseRun(project: string) {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (run: string) =>
      (
        await api.post<{ run: Run }>(
          `/projects/${encodeURIComponent(project)}/runs/${encodeURIComponent(run)}/rebase`,
        )
      ).run,
    onSuccess: (run) =>
      client.setQueryData<Run[]>(runsKey(project), (runs) => upsertRun(runs, run)),
    onSettled: () => {
      client.invalidateQueries({ queryKey: runsKey(project) });
      client.invalidateQueries({ queryKey: boardKey(project) });
    },
  });
}

/**
 * Applies a `queue.*` message: `queue.limits` replaces the limits; any change of a project's
 * queue reads its view again (the waiting reasons depend on the plan and the runs too).
 */
export function applyQueueMessage(
  client: QueryClient,
  message: { type: string; project?: string; limits?: unknown },
): void {
  if (message.type === "queue.limits" && message.limits && typeof message.limits === "object") {
    client.setQueryData(parallelKey, message.limits as ParallelLimits);
    client.invalidateQueries({ queryKey: ["queue"] });
  } else if (message.type.startsWith("queue.") && message.project) {
    client.invalidateQueries({ queryKey: queueKey(message.project) });
  }
}

/**
 * Keeps the queue view live for several projects: one authenticated WebSocket subscribed to
 * each. Runs changing state also change why entries wait, so they refresh the queue too.
 */
export function useQueueEvents(projects: readonly string[]): void {
  const client = useQueryClient();
  const key = projects.join(",");
  useEffect(() => {
    const ids = key ? key.split(",") : [];
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
        const message = JSON.parse(String(event.data)) as {
          type: string;
          project?: string;
          run?: unknown;
          event?: unknown;
          limits?: unknown;
        };
        if (message.type === "ready") {
          for (const project of ids) socket?.send(JSON.stringify({ type: "subscribe", project }));
          if (attempt > 0) client.invalidateQueries({ queryKey: ["queue"] });
          attempt = 0;
        } else if (message.type.startsWith("queue.")) {
          applyQueueMessage(client, message);
        } else if (message.type === "run.state" && message.project) {
          applyRunMessage(client, message.project, message);
          client.invalidateQueries({ queryKey: queueKey(message.project) });
        } else if (message.type === "board.changed" && message.project) {
          client.invalidateQueries({ queryKey: queueKey(message.project) });
        }
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
  }, [client, key]);
}
