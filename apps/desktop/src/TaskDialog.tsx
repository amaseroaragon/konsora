import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { changeTaskStatus, createTask, deleteTask, editTask, openTask } from "./tasks";
import type { Task, TaskDetails, TaskFields, TaskStatus } from "./tasks";
import { attemptLabels, taskLabels, transitions } from "./board";

function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : "No se pudo guardar la tarea."; }
const activityLabels: Record<string, string> = {
  created: "Tarea creada", updated: "Tarea editada", status_changed: "Estado actualizado",
  attempt_started: "Intento iniciado", attempt_finished: "Intento terminado",
};

export default function TaskDialog({ projectId, taskId, tasks, readOnly, sourceRevision, onClose, onChanged }: {
  projectId: string; taskId: string | null; tasks: Task[]; onClose: () => void; onChanged: () => void;
  readOnly: boolean; sourceRevision: string | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const active = useRef<AbortController | null>(null);
  const [details, setDetails] = useState<TaskDetails | null>(null);
  const [loading, setLoading] = useState(taskId !== null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [criteria, setCriteria] = useState("");
  const [order, setOrder] = useState(0);
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const element = ref.current; element?.showModal();
    return () => { element?.close(); active.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!taskId) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    let current = true;
    void openTask(projectId, taskId, controller.signal).then((data) => {
      if (!current) return;
      setDetails(data); setTitle(data.task.title); setDescription(data.task.description);
      setCriteria(data.task.acceptance_criteria); setOrder(data.task.sort_order); setDependencies(data.task.dependencies); setError(null);
    }).catch((cause: unknown) => { if (current) setError(errorMessage(cause)); })
      .finally(() => { window.clearTimeout(timeout); if (current) setLoading(false); });
    return () => { current = false; window.clearTimeout(timeout); controller.abort(); };
  }, [projectId, taskId, revision]);

  const task = details?.task;
  const fields: TaskFields = { title: title.trim(), description, acceptance_criteria: criteria, sort_order: order, dependencies };
  const dirty = !!task && (title.trim() !== task.title || description !== task.description || criteria !== task.acceptance_criteria ||
    order !== task.sort_order || [...dependencies].sort().join() !== [...task.dependencies].sort().join());
  const activeAttempt = details?.attempts.some((attempt) => attempt.status === "running") ?? false;
  const editable = !readOnly && !details?.read_only && (!task || (task.status !== "in_progress" && !activeAttempt));

  async function mutate(action: (signal: AbortSignal) => Promise<unknown>, close: boolean) {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    setBusy(true); setError(null);
    try {
      await action(controller.signal);
      onChanged();
      if (close) onClose();
      else { setLoading(true); setRevision((value) => value + 1); setComment(""); }
    } catch (cause: unknown) {
      setError(controller.signal.aborted ? "El resultado no se pudo confirmar. Actualiza los datos antes de repetir la operación." : errorMessage(cause));
    } finally { window.clearTimeout(timeout); active.current = null; setBusy(false); }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!fields.title || !editable) return;
    void mutate((signal) => task ? editTask(projectId, task.id, task.version, fields, signal, task.source_revision)
      : createTask(projectId, { title: fields.title, description, acceptance_criteria: criteria, dependencies }, signal, sourceRevision), true);
  }

  function move(status: TaskStatus) {
    if (!task || dirty) return;
    void mutate((signal) => changeTaskStatus(projectId, task.id, task.version, status, comment, signal, task.source_revision), false);
  }

  return (
    <dialog ref={ref} className="task-dialog" aria-labelledby="task-dialog-title"
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
      <div className="board-heading"><h2 id="task-dialog-title">{taskId ? "Detalle de tarea" : "Nueva tarea"}</h2>
        <button type="button" disabled={busy} onClick={onClose}>Cerrar detalle</button></div>
      {loading ? <p role="status">Cargando detalle…</p> : null}
      {error ? <p className="error-panel" role="alert">{error}</p> : null}
      {taskId ? <button disabled={busy || loading} title="Descarta los cambios sin guardar y relee el archivo"
        onClick={() => { setLoading(true); setRevision((value) => value + 1); }}>Recargar detalle</button> : null}
      {readOnly || details?.read_only ? <p>Datos de solo lectura. Asocia una carpeta y migra sus tareas o corrige el archivo de origen.</p> : null}
      {task?.review_required ? <p className="blocked-badge">El archivo declara la tarea hecha. Revisa el resultado y acéptalo en esta carpeta.</p> : null}
      {taskId && !loading && !details ? <button onClick={() => { setLoading(true); setRevision((value) => value + 1); }}>Reintentar detalle</button> : null}
      {(!taskId || details) ? <>
        {task ? <p className="task-detail-state">{taskLabels[task.status]} · versión {task.version}{task.blocked ? " · Bloqueada" : ""}</p> : null}
        <form onSubmit={save}>
          <fieldset disabled={busy || loading || !editable} className="task-fields">
            <label className="name-field">Título de la tarea<input autoFocus={!taskId} value={title} maxLength={120} required onChange={(event) => setTitle(event.target.value)} /></label>
            <label className="name-field">Descripción<textarea value={description} maxLength={16000} onChange={(event) => setDescription(event.target.value)} /></label>
            <label className="name-field">Criterios de aceptación<textarea value={criteria} maxLength={16000} onChange={(event) => setCriteria(event.target.value)} /></label>
            {task ? <label className="name-field">Orden en el tablero<input type="number" min={0} max={2147483647} step={1} required value={order}
              onChange={(event) => setOrder(event.target.valueAsNumber)} /></label> : null}
            <fieldset className="dependency-options"><legend>Dependencias del proyecto</legend>
              {tasks.filter((item) => item.id !== taskId).map((item) => <label className="check-label" key={item.id}>
                <input type="checkbox" checked={dependencies.includes(item.id)} onChange={(event) => setDependencies((previous) => event.target.checked
                  ? [...previous, item.id] : previous.filter((id) => id !== item.id))} />
                <span>{item.title} · {taskLabels[item.status]}{task?.blocked_by.includes(item.id) ? " · Sin aceptar" : ""}</span>
              </label>)}
              {tasks.every((item) => item.id === taskId) ? <p>No hay otras tareas en este proyecto.</p> : null}
            </fieldset>
            {task && ["done", "in_review"].includes(task.status) ? <p>Cambiar el alcance devolverá la tarea a pendiente para revisarla de nuevo.</p> : null}
            <button type="submit" className="primary-button" disabled={!title.trim() || (task !== undefined && !dirty)}>{busy ? "Guardando…" : taskId ? "Guardar cambios" : "Crear tarea"}</button>
          </fieldset>
        </form>
        {task ? <section className="task-status-actions" aria-label="Cambiar estado de la tarea">
          <h3>Estado y revisión</h3>
          <p>Los estados se actualizan manualmente. Marca una tarea como hecha después de revisar su resultado.</p>
          {task.blocked ? <p className="blocked-badge">Sin aceptar: {task.blocked_by.map((id) => tasks.find((item) => item.id === id)?.title ?? id).join(", ")}</p> : null}
          {dirty ? <p>Guarda los cambios antes de cambiar el estado.</p> : null}
          <label className="name-field">Comentario de revisión<textarea value={comment} maxLength={4000} disabled={busy || activeAttempt} onChange={(event) => setComment(event.target.value)} /></label>
          <div className="workspace-actions">{transitions[task.status].map((transition) => <button key={transition.status}
            disabled={readOnly || details?.read_only || busy || loading || dirty || activeAttempt || (task.blocked && transition.status !== "pending")}
            onClick={() => move(transition.status)}>{transition.label}</button>)}</div>
          {activeAttempt ? <p>El intento activo impide editar, mover o borrar la tarea.</p> : null}
          <details className="task-evidence"><summary>Intentos y resultados ({details?.attempts.length ?? 0})</summary>
            {!details?.attempts.length ? <p>No hay intentos de ejecución.</p> : details.attempts.map((attempt) => <article key={attempt.id}>
              <h4>{attemptLabels[attempt.status]} · versión {attempt.task_version}</h4>
              <p>{attempt.connector} · {attempt.model ?? "Modelo predeterminado"} · {new Date(attempt.started_at).toLocaleString("es")}</p>
              {attempt.result ? <p className="evidence-text">{attempt.result}</p> : null}
              {attempt.error ? <p className="evidence-text form-error">{attempt.error}</p> : null}
            </article>)}
          </details>
          <details className="task-evidence"><summary>Actividad ({details?.activity.length ?? 0})</summary>
            <ol>{details?.activity.map((event) => <li key={event.id}><strong>{activityLabels[event.event] ?? "Actividad de tarea"}</strong>
              <span> · Actor declarado: {event.actor === "user" ? "Usuario" : event.actor === "supervisor" ? "Supervisor" : "Externo"} · {new Date(event.created_at).toLocaleString("es")}</span>
              {event.detail ? <p className="evidence-text">{event.detail}</p> : null}</li>)}</ol>
          </details>
          <button className="danger-text" disabled={readOnly || details?.read_only || busy || loading || activeAttempt || task.status === "in_progress"}
            onClick={() => setConfirmDelete((value) => !value)}>Eliminar tarea</button>
          {confirmDelete ? <div className="error-panel"><p>Se eliminarán esta tarea y su historial local. Sus archivos se conservan.</p>
            <button className="danger-button" disabled={busy || readOnly} onClick={() => { void mutate((signal) => deleteTask(projectId, task.id, task.version, signal, task.source_revision), true); }}>Confirmar eliminación</button></div> : null}
        </section> : null}
      </> : null}
    </dialog>
  );
}
