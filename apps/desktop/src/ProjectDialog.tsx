import { useEffect, useRef, useState } from "react";
import type { Project } from "./api";

export type ProjectDialogState =
  | { kind: "create" }
  | { kind: "rename" | "delete"; project: Project };

interface Props {
  dialog: ProjectDialogState;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (name: string) => Promise<void>;
}

export default function ProjectDialog({ dialog, pending, error, onCancel, onConfirm }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(dialog.kind === "create" ? "" : dialog.project.name);
  const deleting = dialog.kind === "delete";
  const title = dialog.kind === "create" ? "Nuevo proyecto" : deleting ? "Eliminar proyecto" : "Renombrar proyecto";

  useEffect(() => {
    const element = ref.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  return (
    <dialog ref={ref} className="project-dialog" aria-labelledby="dialog-title"
      aria-describedby={deleting ? "delete-description" : undefined}
      onCancel={(event) => { event.preventDefault(); if (!pending) onCancel(); }}>
      <form onSubmit={(event) => { event.preventDefault(); void onConfirm(name.trim()); }}>
        <span className="eyebrow">TUS PROYECTOS</span>
        <h2 id="dialog-title">{title}</h2>
        {deleting ? (
          <p id="delete-description">
            ¿Quieres eliminar <strong>{dialog.project.name}</strong>?
            {" "}El proyecto y todo su historial local, incluidos chats y registros históricos, se borrarán de este equipo. Esta acción no se puede deshacer.
            {" "}La carpeta de trabajo y sus archivos se conservarán.
          </p>
        ) : (
          <label className="name-field">
            Nombre del proyecto
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)}
              maxLength={120} required disabled={pending} autoComplete="off" />
            <span className="field-hint">Entre 1 y 120 caracteres.</span>
          </label>
        )}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" autoFocus={deleting} onClick={onCancel} disabled={pending}>Cancelar</button>
          <button type="submit" className={deleting ? "danger-button" : "primary-button"}
            disabled={pending || (!deleting && !name.trim())}>
            {pending ? "Guardando…" : deleting ? "Eliminar definitivamente" : dialog.kind === "create" ? "Crear proyecto" : "Guardar nombre"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
