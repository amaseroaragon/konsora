import { useEffect, useState } from "react";
import { createProject, deleteProject, listProjects, openProject, renameProject } from "./api";
import type { Project } from "./api";
import ProjectDialog from "./ProjectDialog";
import type { ProjectDialogState } from "./ProjectDialog";
import ProjectContent from "./ProjectContent";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "No se pudo completar la operación. Vuelve a intentarlo.";
}

export default function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<ProjectDialogState | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    async function load() {
      try {
        const data = await listProjects(controller.signal);
        if (active) {
          setProjects(data);
          setSelected((current) => data.find((project) => project.id === current?.id) ?? data[0] ?? null);
          setLoadError(null);
        }
      } catch (error: unknown) {
        if (active) setLoadError(errorMessage(error));
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; controller.abort(); };
  }, [revision]);

  function refresh() {
    setLoading(true);
    setActionError(null);
    setRevision((value) => value + 1);
  }

  function showDialog(value: ProjectDialogState) {
    setDialogError(null);
    setActionError(null);
    setDialog(value);
  }

  async function open(project: Project) {
    setPending(true);
    setActionError(null);
    try {
      const data = await openProject(project.id);
      setSelected(data);
      setProjects((items) => items.map((item) => item.id === data.id ? data : item));
    } catch (error: unknown) {
      setActionError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  async function confirm(name: string) {
    if (!dialog || pending) return;
    setPending(true);
    setDialogError(null);
    try {
      if (dialog.kind === "create") {
        const project = await createProject(name);
        setProjects((items) => [project, ...items]);
        setSelected(project);
      } else if (dialog.kind === "rename") {
        const project = await renameProject(dialog.project.id, name);
        setProjects((items) => items.map((item) => item.id === project.id ? project : item));
        setSelected((current) => current?.id === project.id ? project : current);
      } else {
        await deleteProject(dialog.project.id);
        setProjects((items) => items.filter((item) => item.id !== dialog.project.id));
        setSelected((current) => current?.id === dialog.project.id
          ? projects.find((project) => project.id !== dialog.project.id) ?? null : current);
      }
      setDialog(null);
    } catch (error: unknown) {
      setDialogError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="projects-layout">
      <aside className="project-sidebar">
        <div className="sidebar-heading"><h2>Proyectos</h2><span>{projects.length}</span></div>
        <button className="primary-button" disabled={pending || loading || loadError !== null}
          onClick={() => showDialog({ kind: "create" })}>+ Nuevo proyecto</button>
        <button className="quiet-button" disabled={pending || loading} onClick={refresh}>Actualizar proyectos</button>
        {loading ? <p role="status">Cargando proyectos…</p> : null}
        {loadError ? <div className="error-panel" role="alert"><p>{loadError}</p><button disabled={loading} onClick={refresh}>Reintentar proyectos</button></div> : null}
        <nav aria-label="Proyectos guardados"><ul className="sidebar-projects" aria-busy={loading}>
          {projects.map((project) => <li key={project.id}><button disabled={pending || loading}
            aria-label={`Abrir ${project.name}`} aria-current={selected?.id === project.id ? "page" : undefined}
            onClick={() => { void open(project); }}><span className="project-initial" aria-hidden="true">{Array.from(project.name)[0]}</span>
            <span>{project.name}</span></button></li>)}
        </ul></nav>
      </aside>
      <div className="project-main">
        {pending && !dialog ? <p role="status">Abriendo proyecto…</p> : null}
        {actionError ? <p className="error-panel" role="alert">{actionError}</p> : null}
        {selected ? <section className="project-workspace" aria-labelledby="project-title">
          <div className="projects-heading">
            <div><span className="eyebrow">PROYECTO ABIERTO</span><h1 id="project-title" className="project-title">{selected.name}</h1></div>
            <div className="project-actions">
              <button disabled={pending} onClick={() => showDialog({ kind: "rename", project: selected })}>Renombrar</button>
              <button className="danger-text" disabled={pending} onClick={() => showDialog({ kind: "delete", project: selected })}>Eliminar</button>
            </div>
          </div>
          <ProjectContent key={selected.id} project={selected} pending={pending} onUpdated={(project) => {
            setSelected((current) => current?.id === project.id ? project : current);
            setProjects((items) => items.map((item) => item.id === project.id ? project : item));
          }} />
        </section> : !loading && !loadError ? <section className="empty-state"><span className="empty-symbol" aria-hidden="true">k.</span>
          <h1>Tu primer proyecto empieza aquí</h1><p>Crea un proyecto para organizar sus tareas en el tablero.</p>
          <button className="primary-button" disabled={pending} onClick={() => showDialog({ kind: "create" })}>Crear mi primer proyecto</button>
        </section> : null}
      </div>
      {dialog ? <ProjectDialog dialog={dialog} pending={pending} error={dialogError}
        onCancel={() => setDialog(null)} onConfirm={confirm} /> : null}
    </div>
  );
}
