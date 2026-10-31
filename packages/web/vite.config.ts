import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

/**
 * `npm run dev -w @konsora/web`: hot reload against the running daemon (start it with
 * `konsora ui`). `/api` and its WebSocket are proxied to the daemon, presenting the daemon's own
 * Host and Origin; open http://127.0.0.1:5173/#token=<token from daemon.json>.
 */
function daemonProxy(): Record<string, ProxyOptions> {
  const dir =
    process.env.KONSORA_DATA_DIR ||
    join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "konsora");
  try {
    const { url } = JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8")) as { url: string };
    return { "/api": { target: url, changeOrigin: true, ws: true, headers: { origin: url } } };
  } catch {
    return {};
  }
}

export default defineConfig(({ command }) => ({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    ...(command === "serve" ? { proxy: daemonProxy() } : {}),
  },
}));
