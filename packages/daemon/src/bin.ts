#!/usr/bin/env node
// Daemon entry point. `konsora ui` runs it detached; it can also be started by hand:
// node packages/daemon/src/bin.ts   (KONSORA_DEV_ORIGIN=http://127.0.0.1:5173 for `vite dev`)
import { webDir } from "./paths.ts";
import { startDaemon } from "./server.ts";

const origins = process.env.KONSORA_DEV_ORIGIN ? [process.env.KONSORA_DEV_ORIGIN] : [];
const daemon = await startDaemon({ extraOrigins: origins, webDir: webDir() });
console.log(
  `Konsora daemon listening on ${daemon.url} (pid ${daemon.pid}, data: ${daemon.dataDir})`,
);
const stop = async () => {
  await daemon.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
