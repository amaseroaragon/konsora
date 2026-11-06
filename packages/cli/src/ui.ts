/**
 * `konsora ui` (UI-01): starts the daemon if none is running (detached, logging to the state dir),
 * links the current project, and opens `http://127.0.0.1:<port>/#token=…` in the browser. The
 * token travels in the fragment, so it never reaches the server's logs or history.
 *
 * In this checkout the web bundle is rebuilt first when its sources are newer than `dist/`.
 * `KONSORA_WEB_DIR` points at a prebuilt bundle instead and skips that step.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DaemonInfo } from "@konsora/daemon";
import type { Command } from "commander";
import { findRoot } from "./project.ts";
import { CliError, type Io } from "./shared.ts";

const START_TIMEOUT_MS = 10_000;

/** Loaded lazily so other commands do not pay for the HTTP server's modules. */
type Daemon = typeof import("@konsora/daemon");

/** Newest modification time among the files that make up the web bundle's sources. */
function newestSource(webPackage: string): number {
  let newest = 0;
  const visit = (path: string) => {
    if (existsSync(path)) newest = Math.max(newest, statSync(path).mtimeMs);
  };
  for (const file of ["index.html", "vite.config.ts", "package.json"])
    visit(join(webPackage, file));
  for (const entry of readdirSync(join(webPackage, "src"), {
    recursive: true,
    withFileTypes: true,
  }))
    if (entry.isFile()) visit(join(entry.parentPath, entry.name));
  return newest;
}

/** True when `dist/index.html` is missing or older than any source file. */
export function bundleIsStale(webPackage: string): boolean {
  const index = join(webPackage, "dist", "index.html");
  if (!existsSync(index)) return true;
  return newestSource(webPackage) > statSync(index).mtimeMs;
}

function buildBundle(webPackage: string, io: Io) {
  const vitePackage = createRequire(join(webPackage, "package.json")).resolve("vite/package.json");
  const result = spawnSync(
    process.execPath,
    [join(dirname(vitePackage), "bin", "vite.js"), "build"],
    {
      cwd: webPackage,
      env: io.env,
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    io.stderr(`${result.stdout ?? ""}${result.stderr ?? ""}`);
    throw new CliError(
      "Building the web UI failed (output above).",
      "Fix the error and run `konsora ui` again, or build it with `npm run build -w @konsora/web`.",
    );
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function startDetached(lib: Daemon, io: Io, web: string): Promise<DaemonInfo> {
  const logs = lib.logDir(io.env);
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const logFile = join(logs, "daemon.log");
  const out = openSync(logFile, "a", 0o600);
  const bin = join(dirname(fileURLToPath(import.meta.resolve("@konsora/daemon"))), "bin.ts");
  const child = spawn(process.execPath, [bin], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...io.env, KONSORA_WEB_DIR: web },
  });
  let exited: number | null = null;
  child.on("exit", (code) => {
    exited = code ?? 1;
  });
  child.unref();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const info = await lib.findDaemon(lib.dataDir(io.env));
    if (info && info.pid === child.pid) return info;
    if (exited !== null) break;
    await delay(100);
  }
  throw new CliError(
    exited !== null
      ? "The Konsora daemon exited while starting."
      : "The Konsora daemon did not start in time.",
    `See ${logFile} for details.`,
  );
}

async function api<T>(daemon: DaemonInfo, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${daemon.url}/api${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${daemon.token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!response.ok)
    throw new CliError(`The daemon refused ${path}: ${body.error?.message ?? response.status}`);
  return body;
}

/** Runs alive in the daemon, or `null` if it does not say (older daemons). */
async function liveRuns(daemon: DaemonInfo): Promise<number | null> {
  const health = await api<{ live_runs?: unknown }>(daemon, "/health").catch(() => null);
  return typeof health?.live_runs === "number" ? health.live_runs : null;
}

/** Opens the URL with the desktop's handler; false when there is none. */
function openBrowser(url: string): Promise<boolean> {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  return new Promise((resolve) => {
    const child = spawn(command, [url], { detached: true, stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

export function registerUi(program: Command, io: Io, root: () => string | undefined) {
  program
    .command("ui")
    .description("start (or reuse) the local daemon and open the Konsora web UI in the browser")
    .option("--no-open", "print the URL instead of opening the browser")
    .option("--no-link", "do not link the current project folder")
    .option("--restart", "restart the running daemon (its live runs become interrupted)")
    .action(async (opts: { open: boolean; link: boolean; restart?: boolean }) => {
      const lib: Daemon = await import("@konsora/daemon");
      const web = lib.webDir(io.env);
      if (!io.env.KONSORA_WEB_DIR) {
        const webPackage = dirname(web);
        if (bundleIsStale(webPackage)) {
          io.stderr("Building the web UI…\n");
          buildBundle(webPackage, io);
        }
      }

      let daemon = await lib.findDaemon(lib.dataDir(io.env));
      if (daemon && (opts.restart || lib.daemonIsStale(daemon))) {
        // A daemon started before this checkout's code changed serves a newer web UI than its
        // API: restart it, unless that would interrupt runs nobody asked to interrupt.
        const live = opts.restart ? 0 : await liveRuns(daemon);
        if (live === 0) {
          if (!(await lib.stopDaemon(daemon))) {
            throw new CliError(
              `The Konsora daemon (pid ${daemon.pid}) did not stop.`,
              "Stop it by hand and run `konsora ui` again.",
            );
          }
          io.stdout(
            opts.restart
              ? "Stopped the Konsora daemon.\n"
              : "Stopped the Konsora daemon: it ran code older than this checkout.\n",
          );
          daemon = undefined;
        } else {
          io.stderr(
            `Warning: the Konsora daemon at ${daemon.url} runs code older than this checkout, so parts of the UI may fail. ${
              live === null
                ? "It is too old to say whether runs are alive in it."
                : `It has ${live} live run${live === 1 ? "" : "s"}.`
            } Run \`konsora ui --restart\` when you can (live runs become interrupted).\n`,
          );
        }
      }
      if (daemon) io.stdout(`Using the Konsora daemon at ${daemon.url} (pid ${daemon.pid}).\n`);
      else {
        daemon = await startDetached(lib, io, web);
        io.stdout(`Started the Konsora daemon at ${daemon.url} (pid ${daemon.pid}).\n`);
      }

      const params = new URLSearchParams({ token: daemon.token });
      const folder = opts.link ? findRoot(io.cwd, root(), io.env) : null;
      if (folder) {
        const { project } = await api<{ project: { id: string; name: string } }>(
          daemon,
          "/projects",
          { method: "POST", body: JSON.stringify({ path: folder }) },
        );
        params.set("project", project.id);
        io.stdout(`Linked project "${project.name}" (${project.id}).\n`);
      }

      const url = `${daemon.url}/#${params}`;
      if (opts.open && (await openBrowser(url))) {
        io.stdout("Opened Konsora in your browser.\n");
      } else {
        io.stdout(`Open this URL in your browser (it carries your session token):\n  ${url}\n`);
      }
    });
}
