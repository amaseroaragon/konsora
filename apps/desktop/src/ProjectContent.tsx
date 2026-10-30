import { useState } from "react";
import type { Project } from "./api";
import TaskBoard from "./TaskBoard";
import Conversations from "./Conversations";
import ProjectWorkspace from "./ProjectWorkspace";

export default function ProjectContent({ project, pending, onUpdated }: {
  project: Project; pending: boolean; onUpdated: (project: Project) => void;
}) {
  const [view, setView] = useState<"board" | "chat" | "settings">("board");
  return <>
    <nav className="project-tabs" aria-label="Vistas del proyecto">
      <button aria-pressed={view === "board"} onClick={() => setView("board")}>Tablero</button>
      <button aria-pressed={view === "chat"} onClick={() => setView("chat")}>Chat de planificación</button>
      <button aria-pressed={view === "settings"} onClick={() => setView("settings")}>Carpeta y proyecto</button>
    </nav>
    <div hidden={view !== "board"}><TaskBoard projectId={project.id} /></div>
    {view === "chat" ? <Conversations projectId={project.id} /> : null}
    {view === "settings" ? <>
      <div className="project-details"><span className="saved-label">Guardado en este equipo</span><dl>
        <div><dt>Creado</dt><dd>{new Date(project.created_at).toLocaleString("es")}</dd></div>
        <div><dt>Última modificación</dt><dd>{new Date(project.updated_at).toLocaleString("es")}</dd></div>
      </dl></div>
      <ProjectWorkspace project={project} disabled={pending} onUpdated={onUpdated} />
    </> : null}
  </>;
}
