/**
 * Konsora's own data directory (docs/arquitectura.md §3): outside every project.
 * `KONSORA_DATA_DIR` overrides it (tests, portable setups); otherwise XDG_DATA_HOME, else
 * ~/.local/share/konsora.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.KONSORA_DATA_DIR) return env.KONSORA_DATA_DIR;
  const base = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "konsora");
}

export const PROJECTS_FILE = "projects.json";
export const DAEMON_FILE = "daemon.json";
