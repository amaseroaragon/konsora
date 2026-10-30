import assert from "node:assert/strict";
import test from "node:test";
import { filterTasks, selectTasks, selectionSummary } from "../src/board.ts";

const tasks = [
  { id: "a", title: "Diseño inicial", description: "Interfaz", status: "pending", blocked: false },
  { id: "b", title: "Crear interfaz", description: "Depende de diseño", status: "pending", blocked: true },
  { id: "c", title: "Revisar", description: "", status: "in_review", blocked: false },
];

test("seleccionar y deseleccionar visibles conserva la selección oculta sin mutar la anterior", () => {
  const initial = new Set(["c"]);
  const selected = selectTasks(initial, ["a", "b"], true);
  assert.deepEqual([...initial], ["c"]);
  assert.deepEqual([...selectTasks(selected, ["b"], false)], ["c", "a"]);
});

test("el resumen cuenta las ocultas y distingue pendientes elegibles, bloqueadas y otros estados", () => {
  const summary = selectionSummary(tasks, new Set(["a", "b", "c", "eliminada"]), [tasks[0]]);
  assert.equal(summary.chosen.length, 3);
  assert.equal(summary.hidden, 2);
  assert.equal(summary.eligible, 1);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.other, 1);
});

test("los filtros combinan texto, estado y bloqueo sin alterar las tareas", () => {
  assert.deepEqual(filterTasks(tasks, "  DISEÑO ", "pending", true).map((task) => task.id), ["b"]);
  assert.deepEqual(filterTasks(tasks, "interfaz", "all", false).map((task) => task.id), ["a", "b"]);
  assert.deepEqual(filterTasks(tasks, "interfaz", "in_review", false), []);
  assert.equal(tasks.length, 3);
});
