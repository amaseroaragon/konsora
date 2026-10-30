import type { Project } from "./api";
import TaskBoard from "./TaskBoard";
import ProjectWorkspace from "./ProjectWorkspace";

export default function ProjectContent({ project, pending, onUpdated }: {
  project: Project; pending: boolean; onUpdated: (project: Project) => void;
}) {
  return <>
    <details className="project-settings"><summary>Carpeta y proyecto</summary>
      <div className="project-details"><span className="saved-label">Guardado en este equipo</span><dl>
        <div><dt>Creado</dt><dd>{new Date(project.created_at).toLocaleString("es")}</dd></div>
        <div><dt>Última modificación</dt><dd>{new Date(project.updated_at).toLocaleString("es")}</dd></div>
      </dl></div>
      <ProjectWorkspace project={project} disabled={pending} onUpdated={onUpdated} />
    </details>
    <TaskBoard projectId={project.id} />
  </>;
}
