/**
 * `konsora ui` (UI-01): starts the daemon if none is running (detached, logging to the state dir),
 * links the current project, and opens `http://127.0.0.1:<port>/#token=…` in the browser. The
 * token travels in the fragment, so it never reaches the server's logs or history.
 *
 * In this checkout the web bundle is rebuilt first when its sources are newer than `dist/`.
 * `KONSORA_WEB_DIR` points at a prebuilt bundle instead and skips that step.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DaemonInfo } from "@konsora/daemon";
import type { Command } from "commander";
import { findRoot } from "./project.ts";
import { showData } from "./read.ts";
import { CliError, EXIT, type Io, load } from "./shared.ts";

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

type ProjectRow = {
  id: string;
  name: string;
  path: string;
  plan: { status: string; tasks?: number };
};

/** `konsora ui --status` (DMN-07): whether the daemon runs, its version, URL and projects. */
async function showStatus(lib: Daemon, io: Io) {
  const daemon = await lib.findDaemon(lib.dataDir(io.env));
  if (!daemon) {
    io.stdout("The Konsora daemon is not running. Start it with `konsora ui`.\n");
    return;
  }
  const health = await api<{ version: string }>(daemon, "/health");
  const { projects } = await api<{ projects: ProjectRow[] }>(daemon, "/projects");
  const lines = [
    `The Konsora daemon is running at ${daemon.url} (pid ${daemon.pid}, version ${health.version}, since ${daemon.started_at}).`,
  ];
  if (lib.daemonIsStale(daemon))
    lines.push("It runs code older than this checkout; `konsora ui` will restart it.");
  if (projects.length === 0) lines.push("No linked projects.");
  else {
    lines.push(`Linked projects (${projects.length}):`);
    for (const project of projects) {
      const plan =
        project.plan.status === "ok"
          ? `${project.plan.tasks} tasks`
          : `plan ${project.plan.status}`;
      lines.push(`  ${project.id}  ${project.name}  ${project.path}  (${plan})`);
    }
  }
  lines.push("Open it with `konsora ui` (the URL with your session token is printed there).");
  io.stdout(`${lines.join("\n")}\n`);
}

/** `konsora ui --stop` (DMN-07): stops the daemon and removes its daemon.json. */
async function stop(lib: Daemon, io: Io) {
  const dir = lib.dataDir(io.env);
  const file = join(dir, lib.DAEMON_FILE);
  const daemon = await lib.findDaemon(dir);
  if (!daemon) {
    // A daemon.json whose process is gone (a crash) is removed too.
    rmSync(file, { force: true });
    io.stdout("The Konsora daemon is not running.\n");
    return;
  }
  if (!(await lib.stopDaemon(daemon)))
    throw new CliError(
      `The Konsora daemon (pid ${daemon.pid}) did not stop.`,
      `Stop it by hand (kill ${daemon.pid}).`,
    );
  rmSync(file, { force: true });
  io.stdout(`Stopped the Konsora daemon (pid ${daemon.pid}).\n`);
}

/**
 * The URL `konsora ui` opens: the daemon with the session token in the fragment, and the project
 * and the task (CLI-11) whose panel the board opens with, when given.
 */
export function uiUrl(
  daemonUrl: string,
  token: string,
  target: { project?: string; task?: string } = {},
): string {
  const params = new URLSearchParams({ token });
  if (target.project) params.set("project", target.project);
  if (target.project && target.task) params.set("task", target.task);
  return `${daemonUrl}/#${params}`;
}

export function registerUi(program: Command, io: Io, root: () => string | undefined) {
  program
    .command("ui")
    .description(
      "start (or reuse) the local daemon and open the Konsora web UI in the browser; with a task id, its panel",
    )
    .argument("[id]", "a task of this project to open, e.g. CORE-01")
    .option("--no-open", "print the URL instead of opening the browser")
    .option("--no-link", "do not link the current project folder")
    .option("--restart", "restart the running daemon (open AI chats in the UI are closed)")
    .option("--status", "say whether the daemon is running, its version, URL and linked projects")
    .option("--stop", "stop the running daemon")
    .action(
      async (
        id: string | undefined,
        opts: {
          open: boolean;
          link: boolean;
          restart?: boolean;
          status?: boolean;
          stop?: boolean;
        },
      ) => {
        if (opts.status && opts.stop)
          throw new CliError("Use --status or --stop, not both.", undefined, EXIT.usage);
        let task: string | undefined;
        if (id !== undefined) {
          if (opts.status || opts.stop || !opts.link)
            throw new CliError(
              "A task id opens it in this project, so it does not go with --status, --stop or --no-link.",
              "Run `konsora ui <id>` from the project folder.",
              EXIT.usage,
            );
          // Checked before starting anything, so an unknown id opens nothing.
          const { doc } = await load(io, root());
          task = id.toUpperCase();
          if (doc.archived?.includes(task))
            throw new CliError(
              `${task} is archived, so the board has no panel for it.`,
              "See it in the History of `konsora ui`, or with `konsora show`.",
            );
          showData(doc, task);
        }
        const lib: Daemon = await import("@konsora/daemon");
        if (opts.status) return showStatus(lib, io);
        if (opts.stop) return stop(lib, io);
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
          // API: restart it.
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
        }
        if (daemon) io.stdout(`Using the Konsora daemon at ${daemon.url} (pid ${daemon.pid}).\n`);
        else {
          daemon = await startDetached(lib, io, web);
          io.stdout(`Started the Konsora daemon at ${daemon.url} (pid ${daemon.pid}).\n`);
        }

        const folder = opts.link ? findRoot(io.cwd, root(), io.env) : null;
        let project: string | undefined;
        if (folder) {
          const linked = await api<{ project: { id: string; name: string } }>(daemon, "/projects", {
            method: "POST",
            body: JSON.stringify({ path: folder }),
          });
          project = linked.project.id;
          io.stdout(`Linked project "${linked.project.name}" (${project}).\n`);
        }

        const url = uiUrl(daemon.url, daemon.token, {
          ...(project ? { project } : {}),
          ...(task ? { task } : {}),
        });
        if (opts.open && (await openBrowser(url))) {
          io.stdout(`Opened ${task ? `${task} in ` : ""}Konsora in your browser.\n`);
        } else {
          io.stdout(
            `Open this URL in your browser${task ? ` (it opens ${task})` : ""}; it carries your session token:\n  ${url}\n`,
          );
        }
      },
    );
}
