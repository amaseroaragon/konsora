/**
 * The agent selector (UI-13) as a pure model: where it starts, what it offers from the catalog
 * of `GET /api/agents`, and how a change keeps the choice consistent. Whether an agent can run
 * is `checkAgent` of core, the same rule the daemon applies at launch.
 */
import {
  type AgentCatalogEntry,
  type AgentCheck,
  type AgentSpec,
  checkAgent,
  type Effort,
  EffortSchema,
  type Provider,
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

/** Where the selector starts: the task's agent, the project's default, or the first available. */
export function initialAgent(
  task: { agent?: AgentSpec | undefined },
  plan: { defaults?: AgentSpec | undefined },
  catalog: readonly AgentCatalogEntry[],
): AgentSpec | undefined {
  const start = task.agent ?? plan.defaults;
  if (start) return { ...start, permissions: start.permissions ?? "default" };
  return firstAgent(catalog);
}

/**
 * Where the selection bar's selector starts: the agent the selected tasks share (their own or
 * the project's), else the project's default, else the first available.
 */
export function initialBatchAgent(
  tasks: readonly { agent?: AgentSpec | undefined }[],
  plan: { defaults?: AgentSpec | undefined },
  catalog: readonly AgentCatalogEntry[],
): AgentSpec | undefined {
  const agents = tasks.map((task) => initialAgent(task, plan, catalog));
  const first = agents[0];
  const shared = first && agents.every((a) => JSON.stringify(a) === JSON.stringify(first));
  return shared ? first : initialAgent({}, plan, catalog);
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
