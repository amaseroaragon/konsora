/**
 * Konsora's own data directory (docs/arquitectura.md §3): outside every project.
 * `KONSORA_DATA_DIR` overrides it (tests, portable setups); otherwise XDG_DATA_HOME, else
 * ~/.local/share/konsora.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.KONSORA_DATA_DIR) return env.KONSORA_DATA_DIR;
  const base = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "konsora");
}

export const PROJECTS_FILE = "projects.json";
export const DAEMON_FILE = "daemon.json";

/** The web UI bundle this checkout builds (`packages/web/dist`); `KONSORA_WEB_DIR` overrides it. */
export function webDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.KONSORA_WEB_DIR || fileURLToPath(new URL("../../web/dist", import.meta.url));
}

/** Daemon logs (docs/arquitectura.md §3): XDG_STATE_HOME, else ~/.local/state/konsora/logs. */
export function logDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "konsora", "logs");
}
