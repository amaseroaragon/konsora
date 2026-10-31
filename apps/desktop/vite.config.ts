import react from "@vitejs/plugin-react";
import { readFileSync, statSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

// Solo desarrollo: autenticación HTTP del navegador y proxy privado del servidor.
function localApi(): Plugin {
  return { name: "konsora-local-api", configureServer(server) {
    server.middlewares.use("/api", async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      const deny = (status: number, message: string) => {
        response.statusCode = status;
        response.end(JSON.stringify({ detail: message }));
      };
      try {
        const file = process.env.KONSORA_DEV_SESSION_FILE ?? resolve("../../.local/dev-session.json");
        const stat = statSync(file);
        if ((stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error();
        const session = JSON.parse(readFileSync(file, "utf8"));
        const origin = new URL(session.web_origin);
        if (request.headers.host !== origin.host ||
            (request.headers.origin && request.headers.origin !== origin.origin) ||
            (request.headers["sec-fetch-site"] && !["same-origin", "none"].includes(String(request.headers["sec-fetch-site"])))) {
          deny(403, "Origen de desarrollo no autorizado."); return;
        }
        const expected = Buffer.from(`Basic ${Buffer.from(`konsora:${session.token}`).toString("base64")}`);
        const supplied = Buffer.from(request.headers.authorization ?? "");
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
          response.setHeader("WWW-Authenticate", 'Basic realm="Konsora local"');
          deny(401, "Autentica la sesión local de desarrollo."); return;
        }
        if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(session.url) || !request.url?.startsWith("/")) throw new Error();
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) { deny(413, "Petición demasiado grande."); return; }
          chunks.push(Buffer.from(chunk));
        }
        const result = await fetch(session.url + request.url, {
          method: request.method, headers: { Authorization: `Bearer ${session.token}`, Origin: origin.origin, "Content-Type": "application/json" },
          body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: "error", signal: AbortSignal.timeout(8000),
        });
        response.statusCode = result.status;
        response.setHeader("Content-Type", "application/json");
        response.end(Buffer.from(await result.arrayBuffer()));
      } catch { deny(503, "Inicia el servicio privado de desarrollo y revisa sus permisos."); }
    });
  } };
}
export default defineConfig({
  plugins: [react(), localApi()], envDir: "../..", clearScreen: false,
  server: { host: "127.0.0.1", port: Number(process.env.KONSORA_WEB_PORT ?? 1420), strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "es2022" },
});
