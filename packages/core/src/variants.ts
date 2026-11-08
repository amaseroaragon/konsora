/**
 * Variants of a task, best-of-N (docs/esquema-tareas.md §6, CORE-12): several runs of the same
 * task at once, each with its own agent, worktree and branch. Every run of a group carries
 * `variant_of` = the id of its first run (the first one included).
 *
 * - A group counts as one active run: its variants may be active together, and no other run of
 *   the task may start while any of them is.
 * - The task stays doing until every variant has closed (its checks done); then it goes to review
 *   if at least one succeeded.
 * - Choosing the winner discards the others (`integration = discarded`; their run and diff stay)
 *   and leaves the winner `pending`. Only the winner is integrated on accept, and accepting with
 *   more than one candidate left is an error.
 *
 * Pure: the runner and the daemon apply what these rules decide.
 */
import {
  isActiveRunState,
  isFinishedRunState,
  isReviewRun,
  type Run,
  type RunId,
  transitionIntegration,
} from "./run.ts";

/** How many variants a group has: at least 2, at most 3. */
export const MIN_VARIANTS = 2;
export const MAX_VARIANTS = 3;

export type VariantError = {
  code: /** Another run of the task is active and is not a variant of the same group. */
    | "active_run"
    /** The group already has `MAX_VARIANTS` runs, or it is not open to new variants. */
    | "variant_group_closed"
    /** The run is not a variant, or not of this task. */
    | "not_a_variant"
    /** Some variant of the group has not closed yet. */
    | "variants_running"
    /** The chosen variant did not succeed, or was discarded. */
    | "not_choosable"
    /** More than one variant could be integrated: the human must choose first. */
    | "variant_not_chosen";
  message: string;
  /** For `active_run`: the run that occupies the task. */
  run?: RunId;
  /** For `variant_not_chosen`: the variants to choose from. */
  variants?: RunId[];
};

export type VariantResult<T> = ({ ok: true } & T) | { ok: false; error: VariantError };

const fail = (error: VariantError): { ok: false; error: VariantError } => ({ ok: false, error });

/** The runs of the variant group `group` (oldest first, as given). */
export function variantGroup(runs: readonly Run[], group: RunId): Run[] {
  return runs.filter((run) => run.variant_of === group);
}

/**
 * Whether `candidate` (a new run of the task) may start, given the task's runs. Without
 * `variant_of` it needs no active run. A variant may start alongside the active runs of its own
 * group, and only that group: it founds the group (`variant_of` is its own id) or joins one whose
 * runs exist, none chosen or discarded yet, up to `MAX_VARIANTS`.
 */
export function canAddRun(
  taskRuns: readonly Run[],
  candidate: Pick<Run, "id" | "variant_of" | "kind" | "review_of">,
): VariantResult<object> {
  // Review runs (CORE-13) never occupy the task: one at a time per reviewed run.
  const live = (run: Run) => run.id !== candidate.id && isActiveRunState(run.state);
  if (isReviewRun(candidate)) {
    const twin = taskRuns.find(
      (run) => live(run) && isReviewRun(run) && run.review_of === candidate.review_of,
    );
    return twin
      ? fail({
          code: "active_run",
          message: `Run ${candidate.review_of} is already being reviewed by ${twin.id}`,
          run: twin.id,
        })
      : { ok: true };
  }
  const group = candidate.variant_of;
  const active = taskRuns.filter((run) => live(run) && !isReviewRun(run));
  const other = active.find((run) => group === undefined || run.variant_of !== group);
  if (other) {
    return fail({
      code: "active_run",
      message: `The task already has an active run (${other.id}, ${other.state}); wait for it to finish or cancel it first`,
      run: other.id,
    });
  }
  if (group === undefined || group === candidate.id) return { ok: true };
  const members = variantGroup(taskRuns, group).filter((run) => run.id !== candidate.id);
  if (!members.some((run) => run.id === group)) {
    return fail({
      code: "not_a_variant",
      message: `Run ${group} does not exist or does not start a variant group of this task`,
    });
  }
  if (members.length >= MAX_VARIANTS) {
    return fail({
      code: "variant_group_closed",
      message: `Variant group ${group} already has ${MAX_VARIANTS} runs, the most a task can have at once`,
    });
  }
  if (members.some((run) => run.integration !== undefined)) {
    return fail({
      code: "variant_group_closed",
      message: `Variant group ${group} has already been decided; run the task again instead`,
    });
  }
  return { ok: true };
}

/**
 * Where a group stands once one of its variants closes: `running` while any variant is still
 * active (the task stays doing); then `review` if at least one succeeded, else `failed` (the
 * task goes back to todo, as after a single failed run).
 */
export function variantsOutcome(
  taskRuns: readonly Run[],
  group: RunId,
): "running" | "review" | "failed" {
  const members = variantGroup(taskRuns, group);
  if (members.some((run) => !isFinishedRunState(run.state))) return "running";
  return members.some((run) => run.state === "succeeded") ? "review" : "failed";
}

/** The variants of a group that could still be integrated: succeeded and not discarded. */
export function variantCandidates(taskRuns: readonly Run[], group: RunId): Run[] {
  return variantGroup(taskRuns, group).filter(
    (run) =>
      run.state === "succeeded" &&
      run.integration?.state !== "discarded" &&
      run.integration?.state !== "merged",
  );
}

/**
 * The human chooses the winning variant: every variant of its group must have closed, and the
 * winner must have succeeded. Returns the runs to write: the winner `pending`, every other
 * variant `discarded` (its run and diff are kept). Choosing the same winner again changes nothing.
 */
export function chooseVariant(
  taskRuns: readonly Run[],
  winner: RunId,
): VariantResult<{ runs: Run[] }> {
  const chosen = taskRuns.find((run) => run.id === winner);
  const group = chosen?.variant_of;
  if (!chosen || group === undefined) {
    return fail({ code: "not_a_variant", message: `Run ${winner} is not a variant of this task` });
  }
  if (variantsOutcome(taskRuns, group) === "running") {
    return fail({
      code: "variants_running",
      message: `Some variants of ${chosen.task} are still running; wait for all of them to finish`,
    });
  }
  const state = chosen.integration?.state;
  if (chosen.state !== "succeeded" || (state !== undefined && state !== "pending")) {
    return fail({
      code: "not_choosable",
      message: `Run ${winner} is ${state ?? chosen.state}; only a succeeded variant that is still undecided can win`,
    });
  }
  const changed: Run[] = [];
  if (state === undefined) {
    const pending = transitionIntegration(chosen, "pending");
    if (!pending.ok) return fail({ code: "not_choosable", message: pending.error.message });
    changed.push(pending.run);
  }
  for (const run of variantGroup(taskRuns, group)) {
    if (run.id === winner) continue;
    const other = run.integration?.state;
    if (other === "discarded") continue;
    if (other === "merged") {
      return fail({
        code: "not_choosable",
        message: `Variant ${run.id} is already integrated; the group cannot change its winner`,
      });
    }
    const discarded = transitionIntegration(run, "discarded");
    if (!discarded.ok) return fail({ code: "not_choosable", message: discarded.error.message });
    changed.push(discarded.run);
  }
  return { ok: true, runs: changed };
}

/**
 * The run whose work `accept` integrates: the task's latest succeeded, unintegrated run (`null`
 * if there is none). A rebase run that did not succeed leaves the run it rebased as the one. In a
 * variant group, the only candidate left; with more than one, the human must choose first.
 * Review runs are left out.
 */
export function integrableRun(runs: readonly Run[]): VariantResult<{ run: Run | null }> {
  // Review runs (CORE-13) only leave notes: they are never integrated.
  const taskRuns = runs.filter((r) => !isReviewRun(r));
  let run = taskRuns.at(-1);
  if (run?.rebase_of && run.state !== "succeeded") {
    const of = run.rebase_of;
    run = taskRuns.find((r) => r.id === of);
  }
  if (run?.variant_of !== undefined) {
    const candidates = variantCandidates(taskRuns, run.variant_of);
    if (candidates.length > 1) {
      return fail({
        code: "variant_not_chosen",
        message: `${run.task} has ${candidates.length} variants to choose from; choose the winner before accepting`,
        variants: candidates.map((r) => r.id),
      });
    }
    run = candidates[0];
  }
  if (run?.state !== "succeeded") return { ok: true, run: null };
  const state = run.integration?.state;
  return { ok: true, run: state === "merged" || state === "discarded" ? null : run };
}
