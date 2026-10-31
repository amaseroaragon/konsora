/**
 * Live board events over WebSocket (DMN-03), at `/api/ws` on the daemon's server.
 *
 * Handshake: Host and Origin are checked on the HTTP upgrade (browsers cannot send an
 * Authorization header on a WebSocket); the first message must be `{type:"auth", token}` within
 * `authTimeoutMs`, otherwise the socket closes with 4401. Then the client subscribes to projects:
 * `{type:"subscribe", project}` / `{type:"unsubscribe", project}`.
 *
 * One core file watcher per project, shared by its subscribers. Events:
 * - `board.changed` {project, hash, changes: {added, removed, modified}, external}
 * - `board.invalid` {project, message, issues}
 * - `board.missing` {project}
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type Task, type TasksDocument, taskHash } from "@konsora/core";
import { readTasks, watchTasks } from "@konsora/core/store";
import { type WebSocket, WebSocketServer } from "ws";
import { type AuthConfig, allowedHosts, allowedOrigins, sameToken } from "./auth.ts";
import type { OversightFor } from "./oversight.ts";
import type { Registry } from "./registry.ts";

export const WS_PATH = "/api/ws";
const CLOSE_UNAUTHORIZED = 4401;

export type TaskChanges = { added: string[]; removed: string[]; modified: string[] };

/** Per-task diff by content hash. */
export function diffTasks(before: readonly Task[], after: readonly Task[]): TaskChanges {
  const old = new Map(before.map((t) => [t.id, taskHash(t)]));
  const now = new Map(after.map((t) => [t.id, taskHash(t)]));
  return {
    added: [...now.keys()].filter((id) => !old.has(id)),
    removed: [...old.keys()].filter((id) => !now.has(id)),
    modified: [...now.keys()].filter((id) => old.has(id) && old.get(id) !== now.get(id)),
  };
}

type Feed = {
  stop: () => void;
  clients: Set<WebSocket>;
  last: TasksDocument | undefined;
  ready: Promise<void>;
};

export type EventHubOptions = AuthConfig & {
  registry: Registry;
  oversight: OversightFor;
  now?: () => Date;
  authTimeoutMs?: number;
  debounceMs?: number;
};

export class EventHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly feeds = new Map<string, Feed>();
  private readonly options: EventHubOptions;

  constructor(options: EventHubOptions) {
    this.options = options;
  }

  private now() {
    return (this.options.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  /** Attach to the HTTP server's `upgrade` event. */
  handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const host = request.headers.host?.toLowerCase();
    const origin = request.headers.origin;
    const allowed =
      url.pathname === WS_PATH &&
      host !== undefined &&
      allowedHosts(this.options.port).has(host) &&
      (origin === undefined || allowedOrigins(this.options).has(origin));
    if (!allowed) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws));
  };

  private accept(ws: WebSocket) {
    let authed = false;
    const subscriptions = new Set<string>();
    const timer = setTimeout(() => {
      if (!authed) ws.close(CLOSE_UNAUTHORIZED, "Authenticate first");
    }, this.options.authTimeoutMs ?? 5000);

    ws.on("message", async (raw) => {
      let message: { type?: unknown; token?: unknown; project?: unknown };
      try {
        message = JSON.parse(String(raw));
      } catch {
        return send(ws, { type: "error", message: "Messages must be JSON" });
      }
      if (!authed) {
        if (
          message.type === "auth" &&
          typeof message.token === "string" &&
          sameToken(message.token, this.options.token)
        ) {
          authed = true;
          clearTimeout(timer);
          return send(ws, { type: "ready" });
        }
        return ws.close(CLOSE_UNAUTHORIZED, "Invalid token");
      }
      if (typeof message.project !== "string")
        return send(ws, { type: "error", message: "project is required" });
      if (message.type === "subscribe") {
        try {
          await this.options.registry.get(message.project);
        } catch {
          return send(ws, { type: "error", project: message.project, message: "Unknown project" });
        }
        if (!subscriptions.has(message.project)) {
          subscriptions.add(message.project);
          await this.subscribe(message.project, ws);
        }
        return send(ws, { type: "subscribed", project: message.project });
      }
      if (message.type === "unsubscribe") {
        subscriptions.delete(message.project);
        this.unsubscribe(message.project, ws);
        return send(ws, { type: "unsubscribed", project: message.project });
      }
      return send(ws, { type: "error", message: `Unknown message type ${String(message.type)}` });
    });

    ws.on("close", () => {
      clearTimeout(timer);
      for (const project of subscriptions) this.unsubscribe(project, ws);
    });
  }

  private async subscribe(projectId: string, ws: WebSocket) {
    const existing = this.feeds.get(projectId);
    if (existing) {
      existing.clients.add(ws);
      await existing.ready;
      return;
    }
    // Register the feed synchronously so concurrent subscribers share one watcher.
    const feed: Feed = {
      clients: new Set([ws]),
      last: undefined,
      stop: () => {},
      ready: Promise.resolve(),
    };
    this.feeds.set(projectId, feed);
    feed.ready = this.startFeed(projectId, feed);
    await feed.ready;
  }

  private async startFeed(projectId: string, feed: Feed) {
    const project = await this.options.registry.get(projectId);
    const initial = await readTasks(project.path);
    feed.last = initial.ok ? initial.document : undefined;
    const watcher = watchTasks(
      project.path,
      async (event) => {
        let payload: Record<string, unknown>;
        if (event.type === "changed") {
          const changes = diffTasks(feed.last?.tasks ?? [], event.document.tasks);
          feed.last = event.document;
          const external = await this.options
            .oversight(projectId)
            .check(event.document, event.hash, this.now());
          payload = {
            type: "board.changed",
            project: projectId,
            hash: event.hash,
            changes,
            external,
          };
        } else if (event.type === "invalid") {
          payload = {
            type: "board.invalid",
            project: projectId,
            message: event.error.message,
            issues: event.error.issues ?? [],
          };
        } else {
          payload = { type: "board.missing", project: projectId };
        }
        for (const client of feed.clients) send(client, payload);
      },
      { debounceMs: this.options.debounceMs ?? 100 },
    );
    feed.stop = watcher.close;
    await watcher.ready;
    // Everyone left while starting: stop right away.
    if (feed.clients.size === 0 && this.feeds.get(projectId) !== feed) watcher.close();
  }

  private unsubscribe(projectId: string, ws: WebSocket) {
    const feed = this.feeds.get(projectId);
    if (!feed) return;
    feed.clients.delete(ws);
    if (feed.clients.size === 0) {
      feed.stop();
      this.feeds.delete(projectId);
    }
  }

  /** Number of projects currently watched (for tests and diagnostics). */
  get watched(): number {
    return this.feeds.size;
  }

  close() {
    for (const feed of this.feeds.values()) feed.stop();
    this.feeds.clear();
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
  }
}

function send(ws: WebSocket, payload: unknown) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}
