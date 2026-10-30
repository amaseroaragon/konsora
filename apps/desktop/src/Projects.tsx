import { useEffect, useState } from "react";
import { createProject, deleteProject, listProjects, openProject, renameProject } from "./api";
import type { Project } from "./api";
import ProjectDialog from "./ProjectDialog";
import type { ProjectDialogState } from "./ProjectDialog";
import Conversations from "./Conversations";
import ProjectWorkspace from "./ProjectWorkspace";

const dateFormat = new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" });
function formatDate(value: string) { return dateFormat.format(new Date(value)); }
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
        setSelected((current) => current?.id === dialog.project.id ? null : current);
      }
      setDialog(null);
    } catch (error: unknown) {
      setDialogError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      {selected ? (
        <section className="project-workspace" aria-labelledby="project-title">
          <button className="quiet-button back-button" disabled={pending} onClick={() => {
            setSelected(null); refresh();
          }}>← Todos los proyectos</button>
          <div className="projects-heading">
            <div>
              <span className="eyebrow">PROYECTO ABIERTO</span>
              <h1 id="project-title" className="project-title">{selected.name}</h1>
            </div>
            <div className="project-actions">
              <button disabled={pending} onClick={() => showDialog({ kind: "rename", project: selected })}>Renombrar</button>
              <button className="danger-text" disabled={pending} onClick={() => showDialog({ kind: "delete", project: selected })}>Eliminar</button>
            </div>
          </div>
          <div className="project-details">
            <span className="saved-label">Guardado en este equipo</span>
            <dl>
              <div><dt>Creado</dt><dd>{formatDate(selected.created_at)}</dd></div>
              <div><dt>Última modificación</dt><dd>{formatDate(selected.updated_at)}</dd></div>
            </dl>
          </div>
          <ProjectWorkspace key={selected.id} project={selected} disabled={pending} onUpdated={(project) => {
            setSelected((current) => current?.id === project.id ? project : current);
            setProjects((items) => items.map((item) => item.id === project.id ? project : item));
          }} />
          <Conversations key={selected.id} projectId={selected.id} />
        </section>
      ) : (
        <section aria-labelledby="projects-title">
          <div className="projects-heading">
            <div>
              <span className="eyebrow">TU ESPACIO DE TRABAJO</span>
              <h1 id="projects-title">Tus proyectos</h1>
              <p className="intro-copy">Un lugar para cada idea. Tus proyectos permanecen en este equipo.</p>
            </div>
            <button className="primary-button" disabled={pending || loading || loadError !== null}
              onClick={() => showDialog({ kind: "create" })}>+ Nuevo proyecto</button>
          </div>
          <div className="projects-toolbar">
            <span>{projects.length} {projects.length === 1 ? "proyecto" : "proyectos"}</span>
            <button className="quiet-button" disabled={pending || loading} onClick={refresh}>Actualizar proyectos</button>
          </div>
          {loading ? <p className="loading-state" role="status">Cargando proyectos…</p> : null}
          {loadError ? (
            <div className="error-panel" role="alert">
              <p>{loadError}</p>
              <button disabled={loading || pending} onClick={refresh}>Reintentar</button>
            </div>
          ) : null}
          {!loading && !loadError && projects.length === 0 ? (
            <div className="empty-state">
              <span className="empty-symbol" aria-hidden="true">k.</span>
              <h2>Tu primer proyecto empieza aquí</h2>
              <p>Dale un nombre a lo que quieres construir.</p>
              <button className="primary-button" disabled={pending} onClick={() => showDialog({ kind: "create" })}>Crear mi primer proyecto</button>
            </div>
          ) : null}
          <ul className="project-list" aria-label="Proyectos guardados" aria-busy={loading}>
            {projects.map((project) => (
              <li key={project.id}>
                <button className="project-open" disabled={pending || loading}
                  onClick={() => { void open(project); }} aria-label={`Abrir ${project.name}`}>
                  <span className="project-initial" aria-hidden="true">{Array.from(project.name)[0]}</span>
                  <span className="project-summary">
                    <span className="project-name">{project.name}</span>
                    <span className="project-date">Modificado {formatDate(project.updated_at)}</span>
                  </span>
                  <span className="open-label" aria-hidden="true">Abrir →</span>
                </button>
                <div className="project-row-actions">
                  <button disabled={pending || loading} onClick={() => showDialog({ kind: "rename", project })}
                    aria-label={`Renombrar ${project.name}`}>Renombrar</button>
                  <button className="danger-text" disabled={pending || loading} onClick={() => showDialog({ kind: "delete", project })}
                    aria-label={`Eliminar ${project.name}`}>Eliminar</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {pending && !dialog ? <p role="status">Abriendo proyecto…</p> : null}
      {actionError ? <p className="error-panel" role="alert">{actionError}</p> : null}
      {dialog ? <ProjectDialog dialog={dialog} pending={pending} error={dialogError}
        onCancel={() => setDialog(null)} onConfirm={confirm} /> : null}
    </>
  );
}
