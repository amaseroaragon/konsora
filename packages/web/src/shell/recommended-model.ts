/**
 * The agent the project recommends for each difficulty (UI-21), as a pure model: the draft the
 * settings hold and the `set-recommended` op it becomes (only the human sets it).
 */
import {
  type AgentCatalogEntry,
  type AgentSpec,
  type Difficulty,
  DifficultySchema,
  type Project,
} from "@konsora/core";
import { agentProblem } from "./agent-model.ts";

export type RecommendedDraft = Partial<Record<Difficulty, AgentSpec>>;
type Recommended = NonNullable<Project["recommended"]>;

export const DIFFICULTIES: readonly Difficulty[] = DifficultySchema.options;

export function recommendedFrom(recommended: Recommended | undefined): RecommendedDraft {
  const draft: RecommendedDraft = {};
  for (const difficulty of DIFFICULTIES) {
    const agent = recommended?.[difficulty];
    if (agent) draft[difficulty] = agent;
  }
  return draft;
}

export type RecommendedOp = { op: "set-recommended"; recommended: Recommended | null };

/**
 * The `set-recommended` op for the draft (the whole map, or null to remove it), or null when it
 * changes nothing. Every agent in it must be one the catalog can run.
 */
export function recommendedOp(
  draft: RecommendedDraft,
  base: Recommended | undefined,
  catalog: readonly AgentCatalogEntry[] | undefined,
):
  | { ok: true; op: RecommendedOp | null }
  | { ok: false; errors: Partial<Record<Difficulty, string>> } {
  const errors: Partial<Record<Difficulty, string>> = {};
  const recommended: Recommended = {};
  for (const difficulty of DIFFICULTIES) {
    const agent = draft[difficulty];
    if (!agent) continue;
    const problem = agentProblem(agent, catalog);
    if (problem) errors[difficulty] = problem;
    recommended[difficulty] = agent;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const empty = Object.keys(recommended).length === 0;
  const same = JSON.stringify(recommended) === JSON.stringify(recommendedFrom(base));
  if (same) return { ok: true, op: null };
  return { ok: true, op: { op: "set-recommended", recommended: empty ? null : recommended } };
}
