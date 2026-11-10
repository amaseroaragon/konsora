/**
 * The agent selector (UI-13) as a pure model: where it starts, what it offers from the catalog
 * of `GET /api/agents`, and how a change keeps the choice consistent. Whether an agent can run
 * is `checkAgent` of core, the same rule the daemon applies at launch.
 */
import {
  type AgentCatalogEntry,
  type AgentCheck,
  type AgentSpec,
  agentChoice,
  checkAgent,
  type Difficulty,
  type Effort,
  EffortSchema,
  type Project,
  type Provider,
  type Task,
} from "@konsora/core";
import { type MessageKey, t } from "../i18n/index.ts";

export type ProviderOption = { provider: Provider; disabled: boolean; reason?: string };
export type ModelOption = { id: string; label: string };

const isEffort = (value: string): value is Effort => EffortSchema.safeParse(value).success;

/** The first runnable agent the catalog offers (Claude first), with the default profile. */
function firstAgent(catalog: readonly AgentCatalogEntry[]): AgentSpec | undefined {
  const entry = catalog.find((e) => e.installed && e.models.length > 0);
  const model = entry?.models[0];
  return entry && model
    ? { provider: entry.provider, model: model.id, permissions: entry.profiles[0] ?? "default" }
    : undefined;
}

/** Where a task's run agent comes from, as the UI explains it (`first`: nothing set anywhere). */
export type TaskAgent = {
  agent: AgentSpec;
  source: "task" | "recommended" | "defaults" | "first";
  difficulty?: Difficulty;
};

/**
 * The agent a run of the task uses unless the human picks another, and why: core's order (the
 * task's, the one recommended for its difficulty, the project's default), else the first the
 * catalog can run. Always with a permission profile.
 */
export function taskAgent(
  task: Pick<Task, "agent" | "difficulty">,
  plan: Pick<Project, "defaults" | "recommended">,
  catalog: readonly AgentCatalogEntry[],
): TaskAgent | undefined {
  const choice = agentChoice(task, plan);
  if (choice && choice.source !== "requested") {
    const agent = { ...choice.agent, permissions: choice.agent.permissions ?? "default" };
    return choice.source === "recommended"
      ? { agent, source: "recommended", difficulty: choice.difficulty }
      : { agent, source: choice.source };
  }
  const first = firstAgent(catalog);
  return first && { agent: first, source: "first" };
}

/** Where the selector starts: the agent `taskAgent` resolves. */
export function initialAgent(
  task: Pick<Task, "agent" | "difficulty">,
  plan: Pick<Project, "defaults" | "recommended">,
  catalog: readonly AgentCatalogEntry[],
): AgentSpec | undefined {
  return taskAgent(task, plan, catalog)?.agent;
}

/** "Dificultad alta": a task's difficulty as cards and the panel show it. */
export function difficultyText(difficulty: Difficulty): string {
  return `${t("difficulty.label")} ${t(`difficulty.${difficulty}`).toLowerCase()}`;
}

/** "claude · opus · high": the agent as the reasons write it. */
export function agentLabel(agent: AgentSpec): string {
  return [agent.provider, agent.model, agent.effort].filter(Boolean).join(" · ");
}

/** Why a task runs with its agent, e.g. «Recomendado para dificultad alta: claude · opus · high». */
export function agentReason(choice: TaskAgent): string {
  const agent = agentLabel(choice.agent);
  if (choice.source === "recommended" && choice.difficulty) {
    return t("agent.reason.recommended", {
      difficulty: t(`difficulty.${choice.difficulty}`).toLowerCase(),
      agent,
    });
  }
  return t(`agent.reason.${choice.source}`, { agent });
}

/**
 * The agent each task Run or Queue launches: the one the human chose for all, else the task's
 * own (`taskAgent`). Without the catalog none is sent, and the daemon resolves it the same way.
 */
export function launchItems(
  ids: readonly string[],
  agents: readonly { id: string; choice: TaskAgent | undefined }[] | undefined,
  chosen: AgentSpec | undefined,
): { task: string; agent: AgentSpec | undefined }[] {
  return ids.map((task) => ({
    task,
    agent: agents ? (chosen ?? agents.find((row) => row.id === task)?.choice?.agent) : undefined,
  }));
}

/** The agent the tasks all resolve to, if they share one. */
export function sharedAgent(choices: readonly (TaskAgent | undefined)[]): AgentSpec | undefined {
  const first = choices[0]?.agent;
  if (!first) return undefined;
  const key = JSON.stringify(first);
  return choices.every((c) => c && JSON.stringify(c.agent) === key) ? first : undefined;
}

/** Every provider; those not installed are disabled with the reason. */
export function providerOptions(catalog: readonly AgentCatalogEntry[]): ProviderOption[] {
  return catalog.map((entry) =>
    entry.installed
      ? { provider: entry.provider, disabled: false }
      : { provider: entry.provider, disabled: true, reason: t("agent.notInstalled") },
  );
}

/**
 * The models to offer: those the adapter declares, plus the current one if the provider takes
 * models it does not list (a full Claude id saved in the task).
 */
export function modelOptions(
  entry: AgentCatalogEntry | undefined,
  current?: string,
): ModelOption[] {
  if (!entry) return [];
  const listed = entry.models.map((m) => ({ id: m.id, label: m.label || m.id }));
  if (
    current &&
    !listed.some((m) => m.id === current) &&
    (entry.open_models || entry.models_error)
  ) {
    listed.push({ id: current, label: current });
  }
  return listed;
}

/** The efforts to offer for a model: those it declares that Konsora can ask for. */
export function effortOptions(entry: AgentCatalogEntry | undefined, model: string): Effort[] {
  const declared = entry?.models.find((m) => m.id === model)?.efforts;
  if (declared) return declared.filter(isEffort);
  // A model the provider takes without listing it: any effort Konsora knows.
  return entry?.open_models ? [...EffortSchema.options] : [];
}

/** Changes one field, keeping the rest valid: a new provider or model drops what it lacks. */
export function changeAgent(
  agent: AgentSpec,
  change:
    | { field: "provider"; value: Provider }
    | { field: "model"; value: string }
    | { field: "effort"; value: Effort | undefined }
    | { field: "permissions"; value: string },
  catalog: readonly AgentCatalogEntry[],
): AgentSpec {
  const entryOf = (provider: Provider) => catalog.find((e) => e.provider === provider);
  const fit = (next: AgentSpec): AgentSpec => {
    const entry = entryOf(next.provider);
    const efforts = effortOptions(entry, next.model);
    const { effort, ...rest } = next;
    return effort && efforts.includes(effort) ? { ...rest, effort } : rest;
  };
  switch (change.field) {
    case "provider": {
      if (change.value === agent.provider) return agent;
      const entry = entryOf(change.value);
      return fit({
        provider: change.value,
        model: entry?.models[0]?.id ?? "",
        permissions: entry?.profiles[0] ?? "default",
        ...(agent.effort ? { effort: agent.effort } : {}),
      });
    }
    case "model":
      return fit({ ...agent, model: change.value });
    case "effort": {
      const { effort: _, ...rest } = agent;
      return change.value ? { ...rest, effort: change.value } : rest;
    }
    case "permissions":
      return { ...agent, permissions: change.value };
  }
}

/** Why the agent cannot run, in Spanish; null when it can (or the catalog is still loading). */
export function agentProblem(
  agent: AgentSpec | undefined,
  catalog: readonly AgentCatalogEntry[] | undefined,
): string | null {
  if (!catalog) return null;
  if (!agent?.model) return t("agent.none");
  const check = checkAgent(
    agent,
    catalog.find((e) => e.provider === agent.provider),
  );
  if (check.ok) return null;
  const options = (check.options ?? []).join(", ") || "—";
  const values = { provider: agent.provider, model: agent.model, options };
  return t(PROBLEM[check.code], values);
}

const PROBLEM = {
  no_adapter: "agent.problem.no_adapter",
  not_installed: "agent.problem.not_installed",
  profile: "agent.problem.profile",
  model: "agent.problem.model",
  effort: "agent.problem.effort",
} as const satisfies Record<Exclude<AgentCheck, { ok: true }>["code"], MessageKey>;
