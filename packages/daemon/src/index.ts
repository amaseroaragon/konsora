/** Konsora daemon: loopback HTTP API over the project registry and plans (DMN-01). */

export { createApp, VERSION } from "./app.ts";
export { type AuthConfig, checkRequest } from "./auth.ts";
export { diffTasks, EventHub, WS_PATH } from "./events.ts";
export { dataDir } from "./paths.ts";
export { type Project, projectId, Registry, RegistryError } from "./registry.ts";
export { type DaemonInfo, findDaemon, type RunningDaemon, startDaemon } from "./server.ts";
