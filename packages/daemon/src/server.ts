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
import { Approvals } from "./approvals.ts";
import { EventHub } from "./events.ts";
import { ensurePrivateDir, readJson, writePrivateFile } from "./files.ts";
import { createOversights } from "./oversight.ts";
import { DAEMON_FILE, dataDir as defaultDataDir, mcpCommand } from "./paths.ts";
import { Registry } from "./registry.ts";
import { RunManager, type RunManagerOptions } from "./runs.ts";

export type DaemonInfo = { url: string; token: string; pid: number; started_at: string };

export type StartOptions = {
  dataDir?: string;
  /** 0 = pick a free port (default). */
  port?: number;
  /** Extra allowed browser origins, e.g. the Vite dev server http://127.0.0.1:5173. */
  extraOrigins?: string[];
  /** Folder with the built web UI to serve outside `/api`. */
  webDir?: string;
  /** Agent adapters by provider (tests pass fakes); default: the installed Claude Code. */
  adapters?: RunManagerOptions["adapters"];
  /** How runs launch `konsora mcp`; default: this checkout's CLI. */
  mcp?: RunManagerOptions["mcp"];
  /** Passed to the run supervisor (tests shorten it). */
  interruptGraceMs?: number;
};

export type RunningDaemon = DaemonInfo & {
  dataDir: string;
  /** Runs register here to get the token their MCP uses to ask for permissions (M6). */
  approvals: Approvals;
  runs: RunManager;
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
  let runs: RunManager | undefined;
  const approvals = new Approvals({
    onEvent: (event) => {
      hub?.publish(event.project, event);
      runs?.onApproval(event);
    },
  });
  const url = `http://127.0.0.1:${port}`;
  runs = new RunManager({
    registry,
    approvals,
    dataDir: dir,
    daemonUrl: () => url,
    mcp: options.mcp ?? mcpCommand(),
    publish: (project, payload) => hub?.publish(project, payload),
    ...(options.adapters ? { adapters: options.adapters } : {}),
    ...(options.interruptGraceMs !== undefined
      ? { interruptGraceMs: options.interruptGraceMs }
      : {}),
  });
  // Runs that were alive when the last daemon stopped: interrupted, never resumed on their own.
  await runs.recover();
  app = createApp({
    ...auth,
    registry,
    oversight,
    approvals,
    runs,
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
  };
  await writePrivateFile(join(dir, DAEMON_FILE), `${JSON.stringify(info, null, 2)}\n`);

  return {
    ...info,
    dataDir: dir,
    approvals,
    runs,
    close: async () => {
      approvals.close();
      events.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const current = await readJson<DaemonInfo>(join(dir, DAEMON_FILE)).catch(() => undefined);
      if (current?.token === token) await unlink(join(dir, DAEMON_FILE)).catch(() => undefined);
    },
  };
}
