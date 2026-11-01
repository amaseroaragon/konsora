/**
 * The agent catalog (DMN-05): what each provider's adapter declares (installed, version, models
 * with their efforts, permission profiles), and the rule that checks a run's agent against it.
 */
import type { RunTransport } from "./run.ts";
import {
  type AgentSpec,
  EffortSchema,
  type Provider,
  type Task,
  type TasksDocument,
} from "./schema.ts";

export type AgentModel = { id: string; label: string; efforts: string[] };

export type AgentCatalogEntry = {
  provider: Provider;
  installed: boolean;
  version?: string;
  /** The version Konsora's protocol types were made for (Codex). */
  expected_version?: string;
  version_matches?: boolean;
  /** Something the human should know (a version mismatch, the exec fallback…). */
  warning?: string;
  transport?: RunTransport;
  models: AgentModel[];
  /**
   * The provider also takes model ids it does not list (Claude Code accepts full ids such as
   * `claude-opus-5-5` besides its aliases); they are passed through with any effort.
   */
  open_models: boolean;
  profiles: string[];
  /** Why the models could not be listed, if they could not. */
  models_error?: string;
};

/** The agent a run of `task` uses: the one asked for, the task's, or the project's default. */
export function runAgentFor(
  task: Task,
  doc: TasksDocument,
  requested?: AgentSpec,
): AgentSpec | undefined {
  return requested ?? task.agent ?? doc.project.defaults;
}

/**
 * Whether `agent` is something its provider's adapter declares. The reason is actionable: it
 * says what is available instead.
 */
export function checkAgent(
  agent: AgentSpec,
  entry: AgentCatalogEntry | undefined,
): { ok: true } | { ok: false; reason: string } {
  const provider = agent.provider;
  if (!entry) return { ok: false, reason: `Konsora cannot run ${provider} yet` };
  if (!entry.installed) {
    return {
      ok: false,
      reason: `${provider} is not installed or not on PATH; install it and log in with its own CLI`,
    };
  }
  const profile = agent.permissions ?? "default";
  if (!entry.profiles.includes(profile)) {
    return {
      ok: false,
      reason: `${provider} has no permission profile "${profile}"; use ${list(entry.profiles)}`,
    };
  }
  const model = entry.models.find((m) => m.id === agent.model);
  if (!model) {
    // Without a list there is nothing to check against; the provider will say if it is wrong.
    if (entry.open_models || entry.models_error !== undefined) return { ok: true };
    return {
      ok: false,
      reason: `${provider} has no model "${agent.model}"; use ${list(entry.models.map((m) => m.id))}`,
    };
  }
  if (agent.effort && !model.efforts.includes(agent.effort)) {
    const allowed = model.efforts.filter((e) => EffortSchema.safeParse(e).success);
    return {
      ok: false,
      reason: `${model.id} does not take effort "${agent.effort}"; use ${list(allowed)} or none`,
    };
  }
  return { ok: true };
}

function list(items: readonly string[]): string {
  if (items.length === 0) return "none (the provider declares nothing)";
  return items.map((item) => `"${item}"`).join(", ");
}
