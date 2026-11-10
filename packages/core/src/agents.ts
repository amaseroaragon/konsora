/**
 * The agent catalog (DMN-05): what each provider's adapter declares (installed, version, models
 * with their efforts, permission profiles), and the rule that checks a run's agent against it.
 */
import type { RunTransport } from "./run.ts";
import {
  type AgentSpec,
  type Difficulty,
  EffortSchema,
  type Project,
  type Provider,
  type Task,
  type TasksDocument,
} from "./schema.ts";

/**
 * The shell commands the `default` permission profile lets a run's agent use without asking the
 * human (besides the project's checks): `prefix` commands take any arguments, the others only as
 * written. Any other command waits for the human's approval. The Claude adapter turns them into
 * `--allowedTools` rules and the run's prompt names them.
 *
 * The read-only ones (CORE-16) never include a command that can write (`sed -i`, `find`, `tee`,
 * redirections). `native` commands get no rule: Claude Code already allows them and checks their
 * options itself, and a prefix rule would skip that check (with Claude Code 2.1.322,
 * `Bash(rg:*)` let `rg --pre <program>` run and `Bash(sed -n:*)` let `sed -n '1w file'` write).
 */
export const DEFAULT_PROFILE_COMMANDS: readonly {
  command: string;
  prefix: boolean;
  native?: boolean;
}[] = [
  { command: "npm run", prefix: true },
  { command: "npm test", prefix: true },
  { command: "npm ci", prefix: false },
  { command: "git status", prefix: true },
  { command: "git diff", prefix: true },
  { command: "git log", prefix: true },
  { command: "git show", prefix: true },
  { command: "git blame", prefix: true },
  { command: "git add", prefix: true },
  { command: "git commit", prefix: true },
  { command: "ls", prefix: true },
  { command: "cat", prefix: true },
  { command: "head", prefix: true },
  { command: "tail", prefix: true },
  { command: "wc", prefix: true },
  { command: "grep", prefix: true },
  { command: "rg", prefix: true, native: true },
  { command: "sed -n", prefix: true, native: true },
];

/**
 * The shell commands the `readonly` profile (review runs, CORE-13) lets the agent use without
 * asking: reading the repository only. Nothing that writes runs in a review: anything else is
 * denied without asking the human.
 */
export const READONLY_PROFILE_COMMANDS: readonly { command: string; prefix: boolean }[] = [
  { command: "git status", prefix: true },
  { command: "git diff", prefix: true },
  { command: "git log", prefix: true },
  { command: "git show", prefix: true },
  { command: "git blame", prefix: true },
  { command: "ls", prefix: true },
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

/** Where a run's agent comes from, in `runAgentFor`'s order (the UI says it to the human). */
export type AgentSource =
  | { source: "requested" }
  | { source: "task" }
  | { source: "recommended"; difficulty: Difficulty }
  | { source: "defaults" };

/**
 * The agent a run of `task` uses and why: the one asked for, else the task's, else the one the
 * project recommends for the task's difficulty, else the project's default.
 */
export function agentChoice(
  task: Pick<Task, "agent" | "difficulty">,
  project: Pick<Project, "recommended" | "defaults">,
  requested?: AgentSpec,
): ({ agent: AgentSpec } & AgentSource) | undefined {
  if (requested) return { agent: requested, source: "requested" };
  if (task.agent) return { agent: task.agent, source: "task" };
  const recommended = task.difficulty ? project.recommended?.[task.difficulty] : undefined;
  if (recommended && task.difficulty) {
    return { agent: recommended, source: "recommended", difficulty: task.difficulty };
  }
  if (project.defaults) return { agent: project.defaults, source: "defaults" };
  return undefined;
}

/** The agent a run of `task` uses (`agentChoice` without the reason). */
export function runAgentFor(
  task: Task,
  doc: TasksDocument,
  requested?: AgentSpec,
): AgentSpec | undefined {
  return agentChoice(task, doc.project, requested)?.agent;
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
