import type { AttemptStatus, Task, TaskStatus } from "./tasks";

export const taskLabels: Record<TaskStatus, string> = {
  proposal: "Propuestas", pending: "Pendientes", in_progress: "En curso", in_review: "En revisión", done: "Hechas",
};
export const taskStates = Object.keys(taskLabels) as TaskStatus[];
export const attemptLabels: Record<AttemptStatus, string> = {
  running: "En curso", succeeded: "Correcto · pendiente de revisión", failed: "Fallido",
  cancelled: "Cancelado", interrupted: "Interrumpido",
};
export const transitions: Record<TaskStatus, { status: TaskStatus; label: string }[]> = {
  proposal: [{ status: "pending", label: "Aceptar propuesta" }],
  pending: [{ status: "in_progress", label: "Marcar en curso (manual)" }],
  in_progress: [{ status: "in_review", label: "Enviar a revisión" }, { status: "pending", label: "Volver a pendiente" }],
  in_review: [{ status: "done", label: "Aceptar resultado y marcar hecha" }, { status: "pending", label: "Volver a pendiente" }],
  done: [{ status: "pending", label: "Reabrir tarea" }],
};

export function filterTasks(tasks: Task[], query: string, status: TaskStatus | "all", blockedOnly: boolean): Task[] {
  const text = query.trim().toLocaleLowerCase("es");
  return tasks.filter((task) => (status === "all" || task.status === status) && (!blockedOnly || task.blocked) &&
    `${task.title} ${task.description}`.toLocaleLowerCase("es").includes(text));
}

export function selectTasks(previous: Set<string>, ids: string[], selected: boolean): Set<string> {
  const next = new Set(previous);
  for (const id of ids) { if (selected) next.add(id); else next.delete(id); }
  return next;
}

export function selectionSummary(tasks: Task[], selected: Set<string>, visible: Task[]) {
  const chosen = tasks.filter((task) => selected.has(task.id));
  const visibleIds = new Set(visible.map((task) => task.id));
  return {
    chosen, hidden: chosen.filter((task) => !visibleIds.has(task.id)).length,
    eligible: chosen.filter((task) => task.status === "pending" && !task.blocked).length,
    blocked: chosen.filter((task) => task.blocked).length,
    other: chosen.filter((task) => !task.blocked && task.status !== "pending").length,
  };
}
