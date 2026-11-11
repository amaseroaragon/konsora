/**
 * Starts the daemon: 127.0.0.1 only, a free port, a fresh 256-bit token, and
 * `daemon.json` {url, token, pid, started_at} (0600) in the data dir so `konsora ui` can find it.
 * One daemon per data dir: a live daemon recorded in daemon.json is never duplicated.
 */
import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { createApp } from "./app.ts";
import { ChatManager, type ChatManagerOptions } from "./chat.ts";
import { EventHub } from "./events.ts";
import { ensurePrivateDir, readJson, writePrivateFile } from "./files.ts";
import { createOversights } from "./oversight.ts";
import { codeStamp, DAEMON_FILE, dataDir as defaultDataDir } from "./paths.ts";
import { Registry } from "./registry.ts";

export type DaemonInfo = {
  url: string;
  token: string;
  pid: number;
  started_at: string;
  /** `codeStamp()` when it started; absent in daemons older than this field. */
  code?: number;
};

export type StartOptions = {
  dataDir?: string;
  /** 0 = pick a free port (default). */
  port?: number;
  /** Extra allowed browser origins, e.g. the Vite dev server http://127.0.0.1:5173. */
  extraOrigins?: string[];
  /** Folder with the built web UI to serve outside `/api`. */
  webDir?: string;
  /** The AI panel's Claude Code binary and MCP command (tests pass fakes). */
  chat?: Pick<ChatManagerOptions, "command" | "mcp" | "env">;
  /** The code stamp to record; default `codeStamp()` of this checkout. */
  code?: number;
};

export type RunningDaemon = DaemonInfo & {
  dataDir: string;
  chats: ChatManager;
  close: () => Promise<void>;
};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The running daemon recorded in the data dir, if its process is alive. */
export async function findDaemon(dir: string = defaultDataDir()): Promise<DaemonInfo | undefined> {
  const info = await readJson<DaemonInfo>(join(dir, DAEMON_FILE)).catch(() => undefined);
  return info && isAlive(info.pid) ? info : undefined;
}

/** The daemon runs code older than this checkout's (or too old to say): restart it. */
export function daemonIsStale(info: DaemonInfo, current: number = codeStamp()): boolean {
  return info.code === undefined || current > info.code;
}

/** Stops a running daemon (SIGTERM, which closes it cleanly) and waits for it to exit. */
export async function stopDaemon(info: DaemonInfo, timeoutMs = 10_000): Promise<boolean> {
  try {
    process.kill(info.pid, "SIGTERM");
  } catch {
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(info.pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(info.pid);
}

export async function startDaemon(options: StartOptions = {}): Promise<RunningDaemon> {
  const dir = options.dataDir ?? defaultDataDir();
  await ensurePrivateDir(dir);
  const existing = await findDaemon(dir);
  if (existing)
    throw new Error(`A Konsora daemon is already running at ${existing.url} (pid ${existing.pid})`);

  const token = randomBytes(32).toString("hex");
  const registry = new Registry(dir);
  // Host/Origin checks need the real port, known only once listening; until then refuse.
  let app: Hono | undefined;
  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve(
      {
        fetch: (request) => (app ? app.fetch(request) : new Response("Starting", { status: 503 })),
        hostname: "127.0.0.1",
        port: options.port ?? 0,
      },
      () => resolve(s),
    );
    s.on("error", reject);
  });
  const port = (server.address() as AddressInfo).port;
  const oversight = createOversights(dir);
  const auth = { token, port, extraOrigins: options.extraOrigins ?? [] };
  let hub: EventHub | undefined;
  const url = `http://127.0.0.1:${port}`;
  const chats = new ChatManager({
    publish: (project, payload) => hub?.publish(project, payload),
    ...options.chat,
  });
  app = createApp({
    ...auth,
    registry,
    oversight,
    chats,
    ...(options.webDir ? { webDir: options.webDir } : {}),
  });
  const events = new EventHub({ ...auth, registry, oversight });
  hub = events;
  server.on("upgrade", events.handleUpgrade);

  const info: DaemonInfo = {
    url,
    token,
    pid: process.pid,
    started_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    code: options.code ?? codeStamp(),
  };
  await writePrivateFile(join(dir, DAEMON_FILE), `${JSON.stringify(info, null, 2)}\n`);

  return {
    ...info,
    dataDir: dir,
    chats,
    close: async () => {
      chats.close();
      events.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const current = await readJson<DaemonInfo>(join(dir, DAEMON_FILE)).catch(() => undefined);
      if (current?.token === token) await unlink(join(dir, DAEMON_FILE)).catch(() => undefined);
    },
  };
}
