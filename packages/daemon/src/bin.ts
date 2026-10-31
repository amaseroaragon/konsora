#!/usr/bin/env node
// Manual entry point until `konsora ui` (UI-01) manages the daemon: node packages/daemon/src/bin.ts
import { startDaemon } from "./server.ts";

const origins = process.env.KONSORA_DEV_ORIGIN ? [process.env.KONSORA_DEV_ORIGIN] : [];
const daemon = await startDaemon({ extraOrigins: origins });
console.log(
  `Konsora daemon listening on ${daemon.url} (data: ${daemon.dataDir}; token in daemon.json)`,
);
const stop = async () => {
  await daemon.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
