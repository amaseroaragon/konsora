import { useEffect, useRef, useState } from "react";
import { openDebate, runDebate } from "./debates";
import type { DebateHistory, ProposalStatus } from "./debates";

const statuses: Record<ProposalStatus, string> = {
  pending: "Pendiente", running: "Preparando propuesta…", completed: "Completada",
  failed: "Fallida", cancelled: "Cancelada",
};
const dateFormat = new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "medium" });
function formatDate(value: string) { return dateFormat.format(new Date(value)); }
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : "No se pudo completar la simulación.";
}

export default function DebateView({ projectId, debateId }: { projectId: string; debateId: string }) {
  const [history, setHistory] = useState<DebateHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const active = useRef<AbortController | null>(null);

  useEffect(() => {
    let mounted = true;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    let timeout: number | undefined;
    async function load() {
      controller = new AbortController();
      const current = controller;
      timeout = window.setTimeout(() => current.abort(), 8000);
      let polling = pending;
      try {
        const data = await openDebate(projectId, debateId, current.signal);
        polling ||= data.proposals.some((proposal) => proposal.status === "running");
        if (mounted) { setHistory(data); setLoadError(null); }
      } catch (cause: unknown) {
        if (mounted) setLoadError(message(cause));
        polling = false;
      } finally {
        window.clearTimeout(timeout);
        if (mounted) {
          setLoading(false);
          if (polling) timer = window.setTimeout(() => { void load(); }, 350);
        }
      }
    }
    void load();
    return () => { mounted = false; window.clearTimeout(timer); window.clearTimeout(timeout); controller?.abort(); };
  }, [projectId, debateId, revision, pending]);

  useEffect(() => () => active.current?.abort(), []);

  async function start() {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
    setPending(true); setError(null); setNotice(null);
    try {
      setHistory(await runDebate(projectId, debateId, controller.signal));
    } catch (cause: unknown) {
      if (controller.signal.aborted) {
        setNotice(timedOut ? "La simulación tardó demasiado. Actualiza el historial para consultar los resultados guardados."
          : "Simulación cancelada. Las propuestas terminadas se conservan.");
      } else setError(message(cause));
    } finally {
      window.clearTimeout(timeout); active.current = null;
      setPending(false); setRevision((value) => value + 1);
    }
  }

  const ready = history?.proposals.every((proposal) => proposal.status === "pending");
  const running = history?.proposals.some((proposal) => proposal.status === "running");
  return (
    <section className="debate-panel" aria-labelledby="debate-history-title">
      <div className="projects-heading"><h3 id="debate-history-title">Propuestas iniciales · Simulación</h3>
        <button className="quiet-button" disabled={loading} onClick={() => setRevision((value) => value + 1)}>Actualizar propuestas</button></div>
      {loading ? <p role="status">Cargando propuestas…</p> : null}
      {loadError ? <p className="error-panel" role="alert">{loadError}</p> : null}
      {history ? <>
        <details className="debate-input" open>
          <summary>Problema y contexto guardados</summary>
          <h4>Problema</h4><p>{history.debate.problem}</p>
          <h4>Contexto</h4><p>{history.debate.context || "Sin contexto adicional."}</p>
          <small>Creado {formatDate(history.debate.created_at)}</small>
        </details>
        {ready ? <button className="primary-button" disabled={pending || loading || loadError !== null}
          onClick={() => { void start(); }}>Iniciar simulación</button> : null}
        {pending ? <div className="cli-pending" role="status"><span>Simulación en curso…</span>
          <button onClick={() => active.current?.abort()}>Cancelar simulación</button></div>
          : running ? <p role="status">Hay propuestas en curso. El historial se actualiza automáticamente.</p> : null}
        <div className="proposal-grid">
          {history.proposals.map((proposal) => <article className={`proposal proposal-${proposal.status}`}
            key={proposal.id} aria-label={`Propuesta de ${proposal.name}`}>
            <span className="simulation-badge">Simulado · ejemplo local</span>
            <h4>{proposal.name}</h4>
            <p className="proposal-state" role="status">{statuses[proposal.status]}</p>
            <p className="proposal-identity">Conector: {proposal.connector}<br />Modelo: {proposal.model}</p>
            <dl className="proposal-dates">
              <div><dt>Creada</dt><dd>{formatDate(proposal.created_at)}</dd></div>
              {proposal.started_at ? <div><dt>Inicio</dt><dd>{formatDate(proposal.started_at)}</dd></div> : null}
              {proposal.finished_at ? <div><dt>Fin</dt><dd>{formatDate(proposal.finished_at)}</dd></div> : null}
            </dl>
            {proposal.content ? <p className="proposal-content">{proposal.content}</p> : null}
            {proposal.error ? <p className="proposal-error">{proposal.error}</p> : null}
          </article>)}
        </div>
      </> : null}
      {notice ? <p className="cli-detail" role="status">{notice}</p> : null}
      {error ? <p className="error-panel" role="alert">{error}</p> : null}
    </section>
  );
}
