/** The user's environment without Konsora's own variables (tokens, run ids, roots). */
export function agentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("KONSORA_")) clean[key] = value;
  }
  return clean;
}
