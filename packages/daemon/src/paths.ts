/**
 * Konsora's own data directory (docs/arquitectura.md §3): outside every project.
 * `KONSORA_DATA_DIR` overrides it (tests, portable setups); otherwise XDG_DATA_HOME, else
 * ~/.local/share/konsora.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
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

/** The packages whose code a running daemon executes (the CLI too: AI chats launch its MCP). */
const CODE_PACKAGES = ["core", "daemon", "cli"];

/**
 * Newest modification time (ms) of this checkout's daemon-side sources. A daemon records it when
 * it starts; a newer one means the daemon runs old code (`konsora ui` then restarts it).
 */
export function codeStamp(): number {
  let newest = 0;
  for (const name of CODE_PACKAGES) {
    const src = fileURLToPath(new URL(`../../${name}/src`, import.meta.url));
    if (!existsSync(src)) continue;
    for (const entry of readdirSync(src, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".ts")) {
        newest = Math.max(newest, statSync(join(entry.parentPath, entry.name)).mtimeMs);
      }
    }
  }
  return Math.floor(newest);
}

/** Daemon logs (docs/arquitectura.md §3): XDG_STATE_HOME, else ~/.local/state/konsora/logs. */
export function logDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "konsora", "logs");
}

/**
 * How the AI panel's chats launch Konsora's MCP server: this checkout's CLI (`packages/cli/src/bin.ts mcp`) with
 * the Node running the daemon. `KONSORA_MCP_BIN` points to another `bin.ts`.
 */
export function mcpCommand(env: NodeJS.ProcessEnv = process.env): {
  command: string;
  args: string[];
} {
  const bin =
    env.KONSORA_MCP_BIN || fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url));
  return { command: process.execPath, args: [bin, "mcp"] };
}
