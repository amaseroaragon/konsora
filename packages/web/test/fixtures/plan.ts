import type { LayoutTask } from "../../src/shell/graph-model.ts";

/** A layered plan like a real backlog: each task depends on up to 3 tasks of earlier layers. */
export function generatedPlan(count: number): LayoutTask[] {
  const tasks: LayoutTask[] = [];
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  for (let i = 0; i < count; i++) {
    const deps = new Set<string>();
    const n = i < 5 ? 0 : Math.floor(rand() * 4);
    for (let d = 0; d < n; d++) deps.add(`T-${String(Math.floor(rand() * i)).padStart(3, "0")}`);
    tasks.push({ id: `T-${String(i).padStart(3, "0")}`, deps: [...deps] });
  }
  return tasks;
}
