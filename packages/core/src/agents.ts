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

/**
 * The shell commands the `default` permission profile lets a run's agent use without asking the
 * human (besides the project's checks): `prefix` commands take any arguments, the others only as
 * written. Any other command waits for the human's approval. The Claude adapter turns them into
 * `--allowedTools` rules and the run's prompt names them.
 */
export const DEFAULT_PROFILE_COMMANDS: readonly { command: string; prefix: boolean }[] = [
  { command: "npm run", prefix: true },
  { command: "npm test", prefix: true },
  { command: "npm ci", prefix: false },
  { command: "git status", prefix: true },
  { command: "git diff", prefix: true },
  { command: "git log", prefix: true },
  { command: "git add", prefix: true },
  { command: "git commit", prefix: true },
];

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

export type AgentCheck =
  | { ok: true }
  | {
      ok: false;
      code: "no_adapter" | "not_installed" | "profile" | "model" | "effort";
      /** What is available instead (profiles, models or efforts). */
      options?: string[];
      /** In English, for the API and logs; the UI words it from `code` and `options`. */
      reason: string;
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
export function checkAgent(agent: AgentSpec, entry: AgentCatalogEntry | undefined): AgentCheck {
  const provider = agent.provider;
  if (!entry)
    return { ok: false, code: "no_adapter", reason: `Konsora cannot run ${provider} yet` };
  if (!entry.installed) {
    return {
      ok: false,
      code: "not_installed",
      reason: `${provider} is not installed or not on PATH; install it and log in with its own CLI`,
    };
  }
  const profile = agent.permissions ?? "default";
  if (!entry.profiles.includes(profile)) {
    return {
      ok: false,
      code: "profile",
      options: [...entry.profiles],
      reason: `${provider} has no permission profile "${profile}"; use ${list(entry.profiles)}`,
    };
  }
  const model = entry.models.find((m) => m.id === agent.model);
  if (!model) {
    // Without a list there is nothing to check against; the provider will say if it is wrong.
    if (entry.open_models || entry.models_error !== undefined) return { ok: true };
    return {
      ok: false,
      code: "model",
      options: entry.models.map((m) => m.id),
      reason: `${provider} has no model "${agent.model}"; use ${list(entry.models.map((m) => m.id))}`,
    };
  }
  if (agent.effort && !model.efforts.includes(agent.effort)) {
    const allowed = model.efforts.filter((e) => EffortSchema.safeParse(e).success);
    return {
      ok: false,
      code: "effort",
      options: allowed,
      reason: `${model.id} does not take effort "${agent.effort}"; use ${list(allowed)} or none`,
    };
  }
  return { ok: true };
}

function list(items: readonly string[]): string {
  if (items.length === 0) return "none (the provider declares nothing)";
  return items.map((item) => `"${item}"`).join(", ");
}
