import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openProject, setProjectWorkspace } from "./api";
import type { Project } from "./api";

const statusLabels: Record<Project["workspace_status"], string> = {
  unassigned: "Sin carpeta asociada",
  ready: "Carpeta disponible",
  missing: "Carpeta perdida o no disponible. Vuelve a comprobarla o elige otra.",
  inaccessible: "Sin acceso a la carpeta. Revisa los permisos o elige otra.",
  unsafe: "La ruta ha cambiado o no es segura. Selecciona una carpeta de proyecto concreta.",
};

export default function ProjectWorkspace({ project, disabled, onUpdated }: {
  project: Project; disabled: boolean; onUpdated: (project: Project) => void;
}) {
  const [path, setPath] = useState(project.workspace_path ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const native = "__TAURI_INTERNALS__" in window;

  async function choose() {
    setBusy(true); setError(null);
    try {
      const selected = await open({ directory: true, multiple: false, title: "Seleccionar carpeta del proyecto" });
      if (selected !== null) setPath(selected);
    } catch {
      setError("No se pudo abrir el selector de carpetas. Vuelve a intentarlo.");
    } finally { setBusy(false); }
  }

  async function update(action: "save" | "remove" | "refresh") {
    setBusy(true); setError(null);
    try {
      const updated = action === "refresh" ? await openProject(project.id)
        : await setProjectWorkspace(project.id, action === "remove" ? null : path);
      onUpdated(updated);
      setPath(updated.workspace_path ?? "");
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "No se pudo guardar la carpeta. Vuelve a intentarlo.");
    } finally { setBusy(false); }
  }

  return (
    <section className="workspace-folder" aria-labelledby="workspace-title" aria-busy={busy}>
      <h2 id="workspace-title">Carpeta de trabajo</h2>
      <p role="status">{statusLabels[project.workspace_status]}</p>
      {project.workspace_path ? <p className="workspace-path">{project.workspace_path}</p> : null}
      <form onSubmit={(event) => { event.preventDefault(); void update("save"); }}>
        <fieldset disabled={disabled || busy}>
          <label className="name-field">Ruta de la carpeta
            <input value={path} readOnly={native} onChange={(event) => setPath(event.target.value)}
              placeholder="/ruta/a/tu/proyecto" maxLength={4096} required autoComplete="off" />
          </label>
          <div className="workspace-actions">
            {native ? <button type="button" onClick={() => { void choose(); }}>Seleccionar carpeta…</button> : null}
            <button type="submit" disabled={!path || path === project.workspace_path}>Guardar carpeta</button>
            <button type="button" onClick={() => { void update("refresh"); }}>Comprobar carpeta</button>
            {project.workspace_path ? <button type="button" onClick={() => { void update("remove"); }}>Desvincular carpeta</button> : null}
          </div>
        </fieldset>
      </form>
      <p>Asociar una carpeta no modifica sus archivos ni inicia agentes. La ejecución requerirá su propia aprobación.</p>
      {busy ? <p role="status">Comprobando carpeta…</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </section>
  );
}
