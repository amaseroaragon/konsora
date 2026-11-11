/** A project's board over the daemon: the plan with derived flags, live events and moves. */
import type { Op, Task, TaskAction, TaskFlags, TasksDocument } from "@konsora/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { applyChatMessage } from "./chat.ts";
import { type ProjectSummary, projectsKey, useApi } from "./projects.ts";
import { reconnectDelay, TOKEN_KEY } from "./session.ts";

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

export { reconnectDelay } from "./session.ts";

/**
 * Subscribes to the daemon's events for a project: `board.*` refetch the board and
 * `chat.updated` replaces the AI panel's conversation (everything is refetched after
 * reconnecting, in case events were missed). Returns the connection state.
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
    const resync = () => {
      refresh();
      client.invalidateQueries({ queryKey: ["chat", projectId] });
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
        const message = JSON.parse(String(event.data)) as {
          type: string;
          project?: string;
          chat?: unknown;
        };
        if (message.type === "ready")
          socket?.send(JSON.stringify({ type: "subscribe", project: projectId }));
        else if (message.type === "subscribed") {
          if (attempt > 0) resync();
          attempt = 0;
          setState("live");
        } else if (message.project !== projectId) {
          return;
        } else if (message.type.startsWith("board.")) refresh();
        else if (message.type === "chat.updated") applyChatMessage(client, projectId, message);
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

/** A human action from the task panel, conditioned on the task as the panel showed it. */
export type TaskActionInput = { task: BoardTask; action: TaskAction; text?: string };

export function actionBody({ task, action, text }: TaskActionInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    op: action,
    task: task.id,
    expect: { [task.id]: task.hash },
  };
  const value = text?.trim();
  if (action === "send-back") body.feedback = value ?? "";
  else if (action === "answer" || (action === "reopen" && value)) body.text = value ?? "";
  return body;
}

export function useTaskAction(projectId: string) {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TaskActionInput) =>
      api.post(`/projects/${encodeURIComponent(projectId)}/ops`, actionBody(input)),
    onSettled: () => client.invalidateQueries({ queryKey: boardKey(projectId) }),
  });
}

/** Confirms (keeps, logged as yours) or reverts an unapproved external change on a task. */
export function useResolveExternal(projectId: string) {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ task, how }: { task: string; how: "confirm" | "revert" }) =>
      api.post(
        `/projects/${encodeURIComponent(projectId)}/external/${encodeURIComponent(task)}/${how}`,
      ),
    onSettled: () => client.invalidateQueries({ queryKey: boardKey(projectId) }),
  });
}

/** A human edit of a task's content or links, conditioned on the version the human saw. */
export type EditInput =
  | { op: "edit"; task: string; hash: string; changes: Record<string, unknown> }
  | { op: "depend" | "undepend"; task: string; hash: string; on: string };

export function editBody(input: EditInput): Record<string, unknown> {
  const expect = { [input.task]: input.hash };
  return input.op === "edit"
    ? { op: "edit", task: input.task, expect, changes: input.changes }
    : { op: input.op, task: input.task, expect, on: input.on };
}

export function useEditTask(projectId: string) {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: EditInput) =>
      api.post(`/projects/${encodeURIComponent(projectId)}/ops`, editBody(input)),
    onSettled: () => client.invalidateQueries({ queryKey: boardKey(projectId) }),
  });
}

/** A project-wide human op from the settings, such as `set-templates`. */
export function useProjectOp(projectId: string) {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (op: Record<string, unknown>) =>
      api.post(`/projects/${encodeURIComponent(projectId)}/ops`, op),
    onSettled: () => client.invalidateQueries({ queryKey: boardKey(projectId) }),
  });
}
