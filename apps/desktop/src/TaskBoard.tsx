import { useEffect, useState } from "react";
import type { Task, TaskStatus } from "./tasks";
import { listTasks } from "./tasks";
import { attemptLabels, filterTasks, selectTasks, selectionSummary, taskLabels, taskStates } from "./board";
import TaskDialog from "./TaskDialog";

export default function TaskBoard({ projectId }: { projectId: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<TaskStatus | "all">("all");
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<{ id: string | null } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    let current = true;
    void listTasks(projectId, controller.signal).then((items) => {
      if (!current) return;
      setTasks(items); setError(null);
      setSelected((previous) => new Set(items.filter((task) => previous.has(task.id)).map((task) => task.id)));
    }).catch((cause: unknown) => {
      if (current) setError(cause instanceof Error ? cause.message : "No se pudieron cargar las tareas.");
    }).finally(() => { window.clearTimeout(timeout); if (current) setLoading(false); });
    return () => { current = false; window.clearTimeout(timeout); controller.abort(); };
  }, [projectId, revision]);

  function refresh() { setLoading(true); setRevision((value) => value + 1); }
  const visible = filterTasks(tasks, query, status, blockedOnly);
  const summary = selectionSummary(tasks, selected, visible);
  const visibleIds = visible.map((task) => task.id);
  const allVisibleSelected = visible.length > 0 && visible.every((task) => selected.has(task.id));

  return (
    <section className="task-board" aria-labelledby="board-title">
      <div className="board-heading">
        <div><h2 id="board-title">Tablero de tareas</h2><p>Organiza el trabajo y revisa sus resultados.</p></div>
        <div className="workspace-actions">
          <button disabled={loading} onClick={refresh}>Actualizar tareas</button>
          <button className="primary-button" disabled={loading || error !== null} onClick={() => setDialog({ id: null })}>+ Nueva tarea</button>
        </div>
      </div>
      <div className="board-filters">
        <label className="name-field">Buscar tareas
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Título o descripción" />
        </label>
        <label className="name-field">Filtrar por estado
          <select value={status} onChange={(event) => setStatus(event.target.value as TaskStatus | "all")}>
            <option value="all">Todos los estados</option>
            {taskStates.map((state) => <option key={state} value={state}>{taskLabels[state]}</option>)}
          </select>
        </label>
        <label className="check-label"><input type="checkbox" checked={blockedOnly} onChange={(event) => setBlockedOnly(event.target.checked)} />Solo bloqueadas</label>
      </div>
      <div className="board-selection-tools">
        <span>{visible.length} de {tasks.length} tareas visibles</span>
        <button disabled={loading || !visible.length || allVisibleSelected}
          onClick={() => setSelected((previous) => selectTasks(previous, visibleIds, true))}>Seleccionar visibles</button>
        <button disabled={loading || !visible.some((task) => selected.has(task.id))}
          onClick={() => setSelected((previous) => selectTasks(previous, visibleIds, false))}>Deseleccionar visibles</button>
      </div>
      {loading ? <p role="status">Cargando tareas…</p> : null}
      {error ? <div className="error-panel" role="alert"><p>{error}</p><button disabled={loading} onClick={refresh}>Reintentar</button></div> : null}
      {!loading && !error && tasks.length === 0 ? <div className="empty-state"><h3>Tu tablero está listo</h3><p>Crea tu primera tarea con su descripción y criterios de aceptación.</p></div> : null}
      {!loading && tasks.length > 0 && !visible.length ? <p role="status">Ninguna tarea coincide con los filtros. Las seleccionadas siguen en el resumen.</p> : null}
      <div className="kanban-scroll" role="region" aria-label="Columnas del tablero; usa las flechas para desplazarte" tabIndex={0} aria-busy={loading}>
        <div className="kanban-columns">
          {taskStates.map((state) => {
            const column = visible.filter((task) => task.status === state);
            return <section key={state} className={`kanban-column column-${state}`} aria-labelledby={`column-${state}`}>
              <h3 id={`column-${state}`}>{taskLabels[state]} <span>{column.length}</span></h3>
              <ul className="task-cards">
                {column.map((task) => <li key={task.id} className={`task-card ${selected.has(task.id) ? "is-selected" : ""}`}>
                  <div className="card-meta"><label className="check-label">
                    <input type="checkbox" aria-label={`Seleccionar ${task.title}`} checked={selected.has(task.id)} disabled={loading}
                      onChange={(event) => setSelected((previous) => selectTasks(previous, [task.id], event.target.checked))} />
                    <span>v{task.version}</span></label><span>Orden {task.sort_order}</span></div>
                  <h4><button className="task-open" aria-label={`Abrir tarea ${task.title}`} onClick={() => setDialog({ id: task.id })}>{task.title}</button></h4>
                  {task.description ? <p className="card-description">{task.description}</p> : null}
                  {task.blocked ? <p className="task-badge blocked-badge">Bloqueada · {task.blocked_by.length} sin aceptar</p> : null}
                  {task.last_attempt_status ? <p className="task-badge">Intento: {attemptLabels[task.last_attempt_status]}</p> : null}
                  {task.last_attempt_error ? <p className="card-description form-error">{task.last_attempt_error}</p> : null}
                  <time dateTime={task.updated_at}>Actualizada {new Date(task.updated_at).toLocaleDateString("es")}</time>
                </li>)}
              </ul>
              {!column.length ? <p className="column-empty">Sin tareas</p> : null}
            </section>;
          })}
        </div>
      </div>
      <section className="selection-summary" aria-labelledby="selection-title">
        <div className="board-heading"><h3 id="selection-title" aria-live="polite">{summary.chosen.length} seleccionadas · {summary.hidden} ocultas por filtros</h3>
          <button disabled={!summary.chosen.length} onClick={() => setSelected(new Set())}>Limpiar selección</button></div>
        <p>{summary.eligible} pendientes sin bloqueos · {summary.blocked} bloqueadas · {summary.other} en otros estados</p>
        {summary.chosen.length ? <ul className="selected-tasks" aria-label="Todas las tareas seleccionadas">
          {summary.chosen.map((task) => <li key={task.id}>{task.title} <span>· {taskLabels[task.status]}{task.blocked ? " · Bloqueada" : ""}</span>
            <button className="quiet-button" aria-label={`Quitar ${task.title} de la selección`}
              onClick={() => setSelected((previous) => selectTasks(previous, [task.id], false))}>Quitar</button></li>)}
        </ul> : null}
        <button className="primary-button" disabled aria-describedby="execution-unavailable">Ejecutar seleccionadas</button>
        <p id="execution-unavailable">La ejecución aún no está disponible. Seleccionar no autoriza ni inicia trabajo.</p>
      </section>
      {dialog ? <TaskDialog key={dialog.id ?? "new"} projectId={projectId} taskId={dialog.id} tasks={tasks}
        onClose={() => setDialog(null)} onChanged={refresh} /> : null}
    </section>
  );
}
