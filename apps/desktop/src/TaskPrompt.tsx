import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { prepareTaskPrompt, saveTaskPrompt, validateTaskPrompt } from "./tasks";
import type { PreparedPrompt, PromptRequest, Task } from "./tasks";

interface Preview { data: PreparedPrompt; input: PromptRequest; identity: string }

export default function TaskPrompt({ projectId, tasks, revision, disabled, onBusy }: {
  projectId: string; tasks: Task[]; revision: string | null; disabled: boolean; onBusy: (busy: boolean) => void;
}) {
  const [context, setContext] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [invalidated, setInvalidated] = useState(false);
  const [filename, setFilename] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const identity = JSON.stringify({ ids: tasks.map((task) => task.id), revision, context, disabled });
  const currentIdentity = useRef(identity);
  useEffect(() => { currentIdentity.current = identity; }, [identity]);
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    if (preview && preview.identity !== identity) { setInvalidated(true); setMessage(null); }
  }, [identity, preview]);
  const stale = invalidated || (!!preview && preview.identity !== identity);

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    setBusy(true); onBusy(true); setError(null); setMessage(null);
    try { await action(controller.signal); }
    catch (cause: unknown) {
      setError(controller.signal.aborted ? "No se pudo confirmar la operación. Revisa el origen y los archivos antes de repetir."
        : cause instanceof Error ? cause.message : "No se pudo preparar el prompt.");
    } finally { window.clearTimeout(timeout); active.current = null; setBusy(false); onBusy(false); }
  }

  function checkCurrent(expected: string) {
    if (currentIdentity.current !== expected) throw new Error("La selección, el contexto o el archivo cambió. Prepara otra vista previa.");
  }

  function prepare() {
    if (!revision || disabled || !tasks.length) return;
    const input = { task_ids: tasks.map((task) => task.id), expected_revision: revision, context };
    void run(async (signal) => {
      const data = await prepareTaskPrompt(projectId, input, signal);
      checkCurrent(identity); setPreview({ data, input, identity }); setInvalidated(false);
    });
  }

  function copy() {
    if (!preview || stale || disabled) return;
    void run(async (signal) => {
      const data = await validateTaskPrompt(projectId, preview.input, preview.data.fingerprint, signal);
      checkCurrent(preview.identity);
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Portapapeles no disponible");
        await navigator.clipboard.writeText(data.text);
        setMessage("Prompt revalidado y copiado. Su ejecución requerirá tu autorización en la herramienta que uses.");
      } catch {
        textRef.current?.focus(); textRef.current?.select();
        setMessage("Prompt revalidado y seleccionado. Pulsa Ctrl+C para copiarlo.");
      }
    });
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview || stale || disabled) return;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.md$/.test(filename)) {
      setError("Elige un nombre simple acabado en .md, sin carpetas ni espacios."); return;
    }
    void run(async (signal) => {
      checkCurrent(preview.identity);
      const path = await saveTaskPrompt(projectId, preview.input, preview.data.fingerprint, filename, signal);
      setMessage(`Prompt guardado en ${path}. No se ha ejecutado ninguna tarea.`);
    });
  }

  return <section className="task-prompt" aria-labelledby="prompt-title" aria-busy={busy}>
    <h3 id="prompt-title">Prompt de las tareas seleccionadas</h3>
    <p>Prepara una instantánea para una IA externa. No requiere login ni inicia agentes.</p>
    <label className="name-field">Contexto adicional que autorizas incluir
      <textarea value={context} maxLength={16000} disabled={busy} placeholder="Solo se añade el texto que escribas aquí."
        onChange={(event) => setContext(event.target.value)} /></label>
    <button disabled={busy || disabled || !revision || !tasks.length} onClick={prepare}>Preparar prompt</button>
    {busy ? <p role="status">Comprobando el archivo y la selección…</p> : null}
    {error ? <p className="error-panel" role="alert">{error}</p> : null}
    {preview ? <>
      <p className="workspace-path">Origen: {preview.data.source}</p>
      <p className="prompt-revision">Revisión: {preview.data.revision}</p>
      {stale ? <p className="blocked-badge" role="status">Vista previa desactualizada. Revisa la selección y prepara el prompt de nuevo.</p> : null}
      {preview.data.blocked.length ? <ul className="prompt-blocks" aria-label="Dependencias sin aceptar del prompt">
        {preview.data.blocked.map((block) => <li key={`${block.task_id}:${block.dependency_id}`}>
          {block.task_id} espera a {block.dependency_id}{block.selected ? " (seleccionada; requiere aceptación humana)" : " (fuera de la selección; no se añade su trabajo)"}.
        </li>)}</ul> : null}
      {preview.data.other_states.length ? <p>Estas tareas están en otros estados y requieren revisión: {preview.data.other_states.join(", ")}.</p> : null}
      <label className="name-field">Vista previa del prompt
        <textarea ref={textRef} readOnly disabled={stale || disabled} value={preview.data.text} rows={16} /></label>
      <button disabled={busy || stale || disabled} onClick={copy}>Revalidar y copiar prompt</button>
      <form className="prompt-export" onSubmit={save}>
        <label className="name-field">Nombre del archivo .md
          <input value={filename} disabled={busy || stale || disabled} maxLength={103} required placeholder="mi-seleccion.md" onChange={(event) => setFilename(event.target.value)} />
        </label>
        <p>Destino: .konsora/prompts/ dentro del proyecto. Los archivos existentes se conservan.</p>
        <button type="submit" disabled={busy || stale || disabled || !filename}>Guardar prompt nuevo</button>
      </form>
    </> : null}
    {message && !stale ? <p role="status">{message}</p> : null}
  </section>;
}
