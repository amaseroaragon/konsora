/** Konsora daemon: loopback HTTP API over the project registry and plans (DMN-01). */

export { createApp, VERSION } from "./app.ts";
export { type AuthConfig, checkRequest } from "./auth.ts";
export {
  ChatError,
  ChatManager,
  type ChatManagerOptions,
  type ChatMessage,
  type ChatView,
} from "./chat.ts";
export { diffTasks, EventHub, WS_PATH } from "./events.ts";
export { codeStamp, dataDir, logDir, mcpCommand, webDir } from "./paths.ts";
export { type Project, projectId, Registry, RegistryError } from "./registry.ts";
export {
  type DaemonInfo,
  daemonIsStale,
  findDaemon,
  type RunningDaemon,
  startDaemon,
  stopDaemon,
} from "./server.ts";
