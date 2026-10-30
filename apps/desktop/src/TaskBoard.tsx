import { useEffect, useRef, useState } from "react";
import type { MigrationPreview, Task, TaskSource, TaskStatus } from "./tasks";
import { initializeTaskFile, loadTaskBoard, previewTaskMigration } from "./tasks";
import { attemptLabels, filterTasks, selectTasks, selectionSummary, taskLabels, taskStates } from "./board";
import TaskDialog from "./TaskDialog";
import TaskPrompt from "./TaskPrompt";

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
  const [source, setSource] = useState<TaskSource | null>(null);
  const sourceRef = useRef<TaskSource | null>(null);
  const [notice, setNotice] = useState(false);
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const [promptBusy, setPromptBusy] = useState(false);
  const setupRequest = useRef<AbortController | null>(null);

  useEffect(() => () => setupRequest.current?.abort(), []);

  useEffect(() => {
    let current = true;
    let controller: AbortController | null = null;
    let inFlight = false;
    async function load() {
      if (inFlight) return;
      inFlight = true;
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 8000);
      try {
        const data = await loadTaskBoard(projectId, controller.signal);
        if (!current) return;
        const previous = sourceRef.current;
        if (previous?.mode === "files" && data.source.mode !== "files" && previous.file_path === data.source.file_path) {
          setSource(data.source); setError("El archivo de tareas ha desaparecido. Se muestra la última lectura, sin permitir cambios. Restáuralo o revisa la inicialización.");
          return;
        }
        if (previous && previous.file_path !== data.source.file_path) setSelected(new Set());
        else setSelected((chosen) => new Set(data.tasks.filter((task) => chosen.has(task.id)).map((task) => task.id)));
        if (previous?.revision && previous.revision !== data.source.revision) setNotice(true);
        sourceRef.current = data.source;
        setSource(data.source); setTasks(data.tasks); setError(null);
      } catch (cause: unknown) {
        if (current) {
          setError(cause instanceof Error ? cause.message : "No se pudieron cargar las tareas.");
          setSource((previous) => previous ? { ...previous, can_write: false } : null);
        }
      } finally { window.clearTimeout(timeout); inFlight = false; if (current) setLoading(false); }
    }
    void load();
    const interval = window.setInterval(() => { void load(); }, 2500);
    return () => { current = false; window.clearInterval(interval); controller?.abort(); };
  }, [projectId, revision]);

  async function setup(confirm: boolean) {
    if (setupRequest.current) return;
    const controller = new AbortController(); setupRequest.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    setSettingUp(true); setError(null);
    try {
      if (confirm && preview) { await initializeTaskFile(projectId, preview, controller.signal); setPreview(null); refresh(); }
      else setPreview(await previewTaskMigration(projectId, controller.signal));
    } catch (cause: unknown) { setError(cause instanceof Error ? cause.message : "No se pudo preparar el archivo."); }
    finally { window.clearTimeout(timeout); setupRequest.current = null; setSettingUp(false); }
  }

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
          <button className="primary-button" disabled={loading || error !== null || !source?.can_write} onClick={() => setDialog({ id: null })}>+ Nueva tarea</button>
        </div>
      </div>
      <div className="task-file-source">
        {source?.mode === "files" ? <p>Fuente: <span className="workspace-path">{source.file_path}</span></p>
          : <p>{source?.mode === "legacy" ? "Tareas anteriores de solo lectura. Migra su historial a la carpeta para editarlas." : "El tablero necesita un archivo de tareas en la carpeta del proyecto."}</p>}
        {source?.mode !== "files" && source?.file_path ? <button disabled={settingUp || loading} onClick={() => { void setup(false); }}>
          {source.legacy_count ? "Revisar migración a archivos" : "Preparar archivo de tareas"}</button> : null}
        {source && !source.file_path ? <p>Asocia una carpeta desde «Carpeta y proyecto».</p> : null}
        {source?.mode === "files" && source.legacy_count > 0 ? <p>Se conservan {source.legacy_count} tareas anteriores en el almacenamiento local; este tablero usa el archivo.</p> : null}
        {notice ? <p role="status">El archivo se ha actualizado. Revisa las tareas seleccionadas antes de preparar su prompt.</p> : null}
        {preview ? <div className="file-setup-preview"><h3>Revisar archivo de destino</h3><p className="workspace-path">{preview.target}</p>
          <p>{preview.task_count} tareas · {preview.attempt_count} intentos · {preview.activity_count} eventos. Los datos anteriores se conservan.</p>
          {preview.file_exists ? <p>El archivo ya existe y no se sobrescribirá. Cierra esta vista y revisa sus tareas.</p>
            : <button disabled={settingUp} onClick={() => { void setup(true); }}>{preview.task_count ? "Confirmar migración a la carpeta" : "Crear archivo vacío en la carpeta"}</button>}
          <button disabled={settingUp} onClick={() => setPreview(null)}>Cerrar vista previa</button></div> : null}
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
        <button disabled={promptBusy || loading || !visible.length || allVisibleSelected}
          onClick={() => setSelected((previous) => selectTasks(previous, visibleIds, true))}>Seleccionar visibles</button>
        <button disabled={promptBusy || loading || !visible.some((task) => selected.has(task.id))}
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
                    <input type="checkbox" aria-label={`Seleccionar ${task.title}`} checked={selected.has(task.id)} disabled={loading || promptBusy}
                      onChange={(event) => setSelected((previous) => selectTasks(previous, [task.id], event.target.checked))} />
                    <span>v{task.version}</span></label><span>Orden {task.sort_order}</span></div>
                  <h4><button className="task-open" aria-label={`Abrir tarea ${task.title}`} onClick={() => setDialog({ id: task.id })}>{task.title}</button></h4>
                  {task.description ? <p className="card-description">{task.description}</p> : null}
                  {task.blocked ? <p className="task-badge blocked-badge">Bloqueada · {task.blocked_by.length} sin aceptar</p> : null}
                  {task.last_attempt_status ? <p className="task-badge">Intento: {attemptLabels[task.last_attempt_status]}</p> : null}
                  {task.last_attempt_error ? <p className="card-description form-error">{task.last_attempt_error}</p> : null}
                  <time dateTime={task.updated_at}>{Date.parse(task.updated_at) === 0 ? "Sin fecha registrada" : `Actualizada ${new Date(task.updated_at).toLocaleDateString("es")}`}</time>
                </li>)}
              </ul>
              {!column.length ? <p className="column-empty">Sin tareas</p> : null}
            </section>;
          })}
        </div>
      </div>
      <section className="selection-summary" aria-labelledby="selection-title">
        <div className="board-heading"><h3 id="selection-title" aria-live="polite">{summary.chosen.length} seleccionadas · {summary.hidden} ocultas por filtros</h3>
          <button disabled={promptBusy || !summary.chosen.length} onClick={() => setSelected(new Set())}>Limpiar selección</button></div>
        <p>{summary.eligible} pendientes sin bloqueos · {summary.blocked} bloqueadas · {summary.other} en otros estados</p>
        {summary.chosen.length ? <ul className="selected-tasks" aria-label="Todas las tareas seleccionadas">
          {summary.chosen.map((task) => <li key={task.id}>{task.title} <span>· {taskLabels[task.status]}{task.blocked ? " · Bloqueada" : ""}</span>
            <button className="quiet-button" disabled={promptBusy} aria-label={`Quitar ${task.title} de la selección`}
              onClick={() => setSelected((previous) => selectTasks(previous, [task.id], false))}>Quitar</button></li>)}
        </ul> : null}
        <TaskPrompt projectId={projectId} tasks={summary.chosen} revision={source?.revision ?? null}
          disabled={!source?.can_write || error !== null || loading} onBusy={setPromptBusy} />
        <button className="primary-button" disabled aria-describedby="execution-unavailable">Ejecutar seleccionadas</button>
        <p id="execution-unavailable">La ejecución aún no está disponible. Seleccionar no autoriza ni inicia trabajo.</p>
      </section>
      {dialog ? <TaskDialog key={dialog.id ?? "new"} projectId={projectId} taskId={dialog.id} tasks={tasks}
        readOnly={!source?.can_write || error !== null} sourceRevision={source?.revision ?? null}
        onClose={() => setDialog(null)} onChanged={refresh} /> : null}
    </section>
  );
}
