import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { createDebate, listDebates } from "./debates";
import type { Debate } from "./debates";
import DebateView from "./DebateView";

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : "No se pudieron cargar los debates.";
}

export default function Debates({ projectId }: { projectId: string }) {
  const [debates, setDebates] = useState<Debate[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const [context, setContext] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const active = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    let mounted = true;
    void listDebates(projectId, controller.signal).then((data) => {
      if (mounted) { setDebates(data); setError(null); }
    }).catch((cause: unknown) => { if (mounted) setError(message(cause)); })
      .finally(() => { window.clearTimeout(timeout); if (mounted) setLoading(false); });
    return () => { mounted = false; window.clearTimeout(timeout); controller.abort(); };
  }, [projectId, revision]);

  useEffect(() => () => active.current?.abort(), []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current || !problem.trim()) return;
    const controller = new AbortController();
    active.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    setCreating(true); setError(null);
    try {
      const data = await createDebate(projectId, problem.trim(), context.trim(), controller.signal);
      setDebates((items) => [data.debate, ...items]); setSelected(data.debate.id);
      setProblem(""); setContext("");
    } catch (cause: unknown) {
      setError(controller.signal.aborted ? "No se pudo confirmar la creación. Actualiza los debates antes de reintentar." : message(cause));
    } finally {
      window.clearTimeout(timeout); active.current = null; setCreating(false);
    }
  }

  return (
    <section className="debates" aria-labelledby="debates-title">
      <div className="projects-heading"><h2 id="debates-title">Debates del proyecto</h2>
        <button className="quiet-button" disabled={loading || creating} onClick={() => {
          setLoading(true); setRevision((value) => value + 1);
        }}>Actualizar debates</button></div>
      <div className="simulation-notice">
        <strong>Modo simulado · sin consumo de cuota</strong>
        <p>Simulado A y Simulado B reciben el mismo problema y contexto por separado. Sus propuestas son ejemplos fijos de demostración.</p>
        <p>Claude Code no está disponible: pendiente de configurar y validar.</p>
        <button type="button" disabled>Debate real · no disponible</button>
      </div>
      <form className="new-debate" onSubmit={(event) => { void create(event); }}>
        <fieldset disabled={creating}>
          <legend>Nuevo debate simulado</legend>
          <label className="name-field">Problema
            <textarea required maxLength={16000} rows={3} value={problem}
              placeholder="¿Qué problema quieres plantear?" onChange={(event) => setProblem(event.target.value)} />
          </label>
          <label className="name-field">Contexto para ambos participantes (opcional)
            <textarea maxLength={32000} rows={3} value={context} onChange={(event) => setContext(event.target.value)} />
            <span className="field-hint">Solo se incluye este texto. El problema y el contexto quedan guardados sin cambios al crear el debate.</span>
          </label>
          <button className="primary-button" disabled={loading || creating || !problem.trim()}>
            {creating ? "Creando…" : "Crear debate simulado"}
          </button>
        </fieldset>
      </form>
      {loading ? <p role="status">Cargando debates…</p> : null}
      {error ? <p className="error-panel" role="alert">{error}</p> : null}
      {!loading && !error && debates.length === 0 ? <p className="cli-detail">Todavía no hay debates en este proyecto.</p> : null}
      <div className="debate-layout">
        <nav aria-label="Debates guardados"><ul className="chat-list">
          {debates.map((debate) => <li key={debate.id}>
            <button aria-current={selected === debate.id ? "page" : undefined}
              aria-label={`Abrir debate ${debate.problem.slice(0, 80)}`} onClick={() => setSelected(debate.id)}>
              <span className="debate-list-problem">{debate.problem.slice(0, 80)}{debate.problem.length > 80 ? "…" : ""}</span>
              <small>Simulado · {new Date(debate.created_at).toLocaleDateString("es")}</small>
            </button>
          </li>)}
        </ul></nav>
        {selected ? <DebateView key={selected} projectId={projectId} debateId={selected} />
          : <p className="cli-detail">Crea o abre un debate para ver sus propuestas.</p>}
      </div>
    </section>
  );
}
