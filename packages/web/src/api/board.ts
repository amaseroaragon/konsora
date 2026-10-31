/** A project's board over the daemon: the plan with derived flags, live events and moves. */
import type { Op, Task, TaskFlags, TasksDocument } from "@konsora/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type ProjectSummary, projectsKey, useApi } from "./projects.ts";
import { TOKEN_KEY } from "./session.ts";

export type BoardTask = Task & TaskFlags & { hash: string };
export type ExternalFlag = {
  task: string;
  kind: string;
  message: string;
  from?: string;
  to?: string;
  detected_at: string;
};
type ProjectInfo = Omit<ProjectSummary, "plan">;
export type Issue = { path: string; code: string; message: string };

export type BoardOk = {
  status: "ok";
  project: ProjectInfo;
  hash: string;
  external: ExternalFlag[];
  plan: Pick<TasksDocument, "schema" | "project" | "groups" | "seq">;
  tasks: BoardTask[];
};
export type BoardUnavailable = {
  status: "missing" | "invalid" | "unsafe_path" | "lock_timeout" | "io";
  project: ProjectInfo;
  message: string;
  issues: Issue[];
};
export type Board = BoardOk | BoardUnavailable;

/** The stored plan behind a board, for core's rules (derived fields stripped). */
export function toDocument(board: BoardOk): TasksDocument {
  return {
    ...board.plan,
    tasks: board.tasks.map(
      ({ blockers: _b, blocked: _bl, ready: _r, waiting: _w, hash: _h, ...task }) => task,
    ),
  };
}

export const boardKey = (id: string) => ["board", id] as const;

export function useBoard(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: boardKey(id),
    queryFn: () => api.get<Board>(`/projects/${encodeURIComponent(id)}/board`),
  });
}

/** A move as sent to the daemon: one human op, conditioned on the task as the board saw it. */
export type Move = { task: BoardTask; op: Op["op"]; to: Task["state"]; feedback?: string };

export function moveBody(move: Move): Record<string, unknown> {
  return {
    op: move.op,
    task: move.task.id,
    expect: { [move.task.id]: move.task.hash },
    ...(move.feedback ? { feedback: move.feedback } : {}),
  };
}

/** Applies a move optimistically, then lets the daemon's answer (or the file) have the last word. */
export function useMoveTask(projectId: string) {
  const api = useApi();
  const client = useQueryClient();
  const key = boardKey(projectId);
  return useMutation({
    mutationFn: (move: Move) =>
      api.post(`/projects/${encodeURIComponent(projectId)}/ops`, moveBody(move)),
    onMutate: async (move) => {
      await client.cancelQueries({ queryKey: key });
      const before = client.getQueryData<Board>(key);
      if (before?.status === "ok") {
        const next: BoardOk = {
          ...before,
          tasks: before.tasks.map(
            (t): BoardTask => (t.id === move.task.id ? { ...t, state: move.to } : t),
          ),
        };
        client.setQueryData<Board>(key, next);
      }
      return { before };
    },
    onError: (_error, _move, context) => {
      if (context?.before) client.setQueryData(key, context.before);
    },
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
}

export type LiveState = "connecting" | "live" | "offline";

/** Mirrors a reconnect delay schedule: 0.5 s, 1 s, 2 s … capped at 10 s. */
export const reconnectDelay = (attempt: number) => Math.min(10_000, 500 * 2 ** attempt);

/**
 * Subscribes to the daemon's `board.*` events for a project and refetches the board on each one
 * (also after reconnecting, in case events were missed). Returns the connection state.
 */
export function useBoardEvents(projectId: string): LiveState {
  const client = useQueryClient();
  const [state, setState] = useState<LiveState>("connecting");
  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: number | undefined;
    let attempt = 0;
    let closed = false;
    const refresh = () => {
      client.invalidateQueries({ queryKey: boardKey(projectId) });
      client.invalidateQueries({ queryKey: projectsKey });
    };
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
        const message = JSON.parse(String(event.data)) as { type: string; project?: string };
        if (message.type === "ready")
          socket?.send(JSON.stringify({ type: "subscribe", project: projectId }));
        else if (message.type === "subscribed") {
          if (attempt > 0) refresh();
          attempt = 0;
          setState("live");
        } else if (message.type.startsWith("board.") && message.project === projectId) refresh();
      };
      socket.onclose = (event) => {
        if (closed) return;
        setState("offline");
        // 4401: the token was refused; the next HTTP call reports the expired session.
        if (event.code === 4401) {
          refresh();
          return;
        }
        timer = window.setTimeout(connect, reconnectDelay(attempt++));
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      socket?.close();
    };
  }, [client, projectId]);
  return state;
}
