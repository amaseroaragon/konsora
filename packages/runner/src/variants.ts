/**
 * Variant groups in the runner (RUN-28, rules in `@konsora/core` variants.ts): the task stays
 * doing while any variant is active, and the last variant to close settles the group. If one or
 * more succeeded, `complete` (with the group's runs) moves the task to review, where the human
 * chooses the winner; if none did, the task goes back to todo.
 */
import { checksPassed, type Run, variantGroup, variantsOutcome } from "@konsora/core";
import { mutate, readTasks } from "@konsora/core/store";
import type { RunStore } from "./run-store.ts";

/**
 * Settles `run`'s variant group once it has closed: nothing while another variant is active.
 * Two variants closing at once may both get here; only the first `complete` or `pause` applies,
 * since the task is no longer doing for the second. Never throws.
 */
export async function settleVariants(input: {
  root: string;
  store: RunStore;
  run: Run;
  at: string;
}): Promise<"running" | "review" | "failed" | null> {
  const group = input.run.variant_of;
  if (group === undefined) return null;
  try {
    const { runs } = await input.store.list({ task: input.run.task });
    const outcome = variantsOutcome(runs, group);
    if (outcome === "running") return outcome;
    const plan = await readTasks(input.root);
    const task = plan.ok ? plan.document.tasks.find((t) => t.id === input.run.task) : undefined;
    if (task?.state !== "doing") return outcome;
    const members = variantGroup(runs, group);
    const states = members.map((r) => `${r.id} ${r.state}`).join(", ");
    const ctx = { actor: "konsora", at: input.at, run: input.run.id };
    if (outcome === "review") {
      const passed = members.some((r) => r.state === "succeeded" && checksPassed(r.checks ?? []));
      await mutate(
        input.root,
        {
          op: "complete",
          task: task.id,
          checks_passed: passed,
          variants: members.map((r) => r.id),
          text: `Konsora: the ${members.length} variants of ${task.id} have finished (${states}). Choose the winner, then accept it.`,
        },
        ctx,
      );
    } else {
      await mutate(
        input.root,
        {
          op: "pause",
          task: task.id,
          text: `Konsora: none of the ${members.length} variants of ${task.id} succeeded (${states}). Their work is kept on their branches.`,
        },
        ctx,
      );
    }
    return outcome;
  } catch {
    return null;
  }
}
