/**
 * The automatic reviewer in the UI (UI-25) as a pure model: the settings draft and the
 * `set-reviewer` op it becomes, the catalog the reviewer's agent is picked from (only the
 * `readonly` profile), and a run's reviews (its review runs and the `review` notes they left).
 */
import {
  type AgentCatalogEntry,
  type AgentSpec,
  isActiveRunState,
  isReviewRun,
  type Note,
  READONLY_PROFILE,
  type Reviewer,
  type Run,
} from "@konsora/core";
import { t } from "../i18n/index.ts";
import { agentProblem } from "./agent-model.ts";

/** `none`: no reviewer; `manual`: only when the human asks; `auto`: when a task reaches review. */
export type ReviewerLaunch = "none" | Reviewer["launch"];
export type ReviewerDraft = { launch: ReviewerLaunch; agent: AgentSpec | undefined };

/** The reviewer's agent always runs read-only: the picker offers that profile alone. */
export function reviewerCatalog(catalog: readonly AgentCatalogEntry[]): AgentCatalogEntry[] {
  return catalog.map((entry) => ({ ...entry, profiles: [READONLY_PROFILE] }));
}

const readonly = (agent: AgentSpec): AgentSpec => ({ ...agent, permissions: READONLY_PROFILE });

/** Where the form starts: the project's reviewer, else (to pick one) the project's default. */
export function reviewerFrom(
  reviewer: Reviewer | undefined,
  fallback: AgentSpec | undefined,
): ReviewerDraft {
  if (reviewer) return { launch: reviewer.launch, agent: readonly(reviewer.agent) };
  return { launch: "none", agent: fallback ? readonly(fallback) : undefined };
}

/** The agent as saved: its profile is implied (`readonly`), so it is left out. */
function saved(agent: AgentSpec): AgentSpec {
  const { permissions: _profile, ...rest } = agent;
  return rest;
}

export type ReviewerOp = { op: "set-reviewer"; reviewer: Reviewer | null };

/**
 * The `set-reviewer` op for the draft, or null when it changes nothing. With a reviewer, its
 * agent must be one the catalog can run (the daemon checks it again when it launches).
 */
export function reviewerOp(
  draft: ReviewerDraft,
  base: Reviewer | undefined,
  catalog: readonly AgentCatalogEntry[] | undefined,
): { ok: true; op: ReviewerOp | null } | { ok: false; error: string } {
  let reviewer: Reviewer | null = null;
  if (draft.launch !== "none") {
    const problem = agentProblem(draft.agent, catalog && reviewerCatalog(catalog));
    if (!draft.agent || problem) return { ok: false, error: problem ?? t("agent.none") };
    reviewer = { agent: saved(draft.agent), launch: draft.launch };
  }
  const before = base ? { agent: saved(base.agent), launch: base.launch } : null;
  if (JSON.stringify(before) === JSON.stringify(reviewer)) return { ok: true, op: null };
  return { ok: true, op: { op: "set-reviewer", reviewer } };
}

/** One review of a run: the note its review run left (if any yet) and that run. */
export type RunReview = { run: Run; note: Note | undefined };

/** The reviews of `reviewed`, oldest first: each review run with the `review` note it left. */
export function runReviews(
  runs: readonly Run[] | undefined,
  notes: readonly Note[] | undefined,
  reviewed: string,
): RunReview[] {
  const reviewRuns = (runs ?? []).filter((run) => isReviewRun(run) && run.review_of === reviewed);
  const reviewNotes = (notes ?? []).filter((note) => note.kind === "review");
  return reviewRuns.map((run) => ({
    run,
    note: reviewNotes.findLast((note) => note.run === run.id),
  }));
}

/** A review of the run is under way: asking for another one waits for it. */
export function reviewActive(reviews: readonly RunReview[]): boolean {
  return reviews.some((review) => isActiveRunState(review.run.state));
}

/** Why asking for a review failed, in Spanish and with what to do next. */
export function reviewErrorText(code: string, id: string, message: string): string {
  switch (code) {
    case "invalid_agent":
      return t("reviewer.error.invalid_agent");
    case "not_reviewable":
      return t("reviewer.error.not_reviewable", { id });
    case "active_run":
      return t("reviewer.error.active_run", { id });
    case "no_adapter":
    case "wrong_provider":
      return t("reviewer.error.no_adapter");
    default:
      return t("reviewer.error.other", { id, message });
  }
}
