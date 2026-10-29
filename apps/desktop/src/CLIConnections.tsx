import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { listConnectors, sendPrompt } from "./connectors";
import type { ConnectorInfo, PromptResult } from "./connectors";

const statuses: Record<ConnectorInfo["status"], string> = {
  ready: "Sesión de ChatGPT detectada", simulated: "Disponible sin conexión",
  missing: "CLI no instalado", login_required: "Falta iniciar sesión",
  api_login: "Sesión de API rechazada", unsupported: "Configuración no compatible",
  error: "No se pudo comprobar el CLI",
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "No se pudo completar la consulta.";
}

export default function CLIConnections() {
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [selected, setSelected] = useState("mock");
  const [prompt, setPrompt] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PromptResult | null>(null);
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const active = useRef<AbortController | null>(null);
  const connector = connectors.find((item) => item.id === selected);
  const available = connector?.status === "ready" || connector?.status === "simulated";

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    let mounted = true;
    async function load() {
      try {
        const data = await listConnectors(controller.signal);
        if (mounted) { setConnectors(data); setLoadError(null); }
      } catch (cause: unknown) {
        if (mounted) setLoadError(errorMessage(cause));
      } finally {
        window.clearTimeout(timeout);
        if (mounted) setLoading(false);
      }
    }
    void load();
    return () => { mounted = false; window.clearTimeout(timeout); controller.abort(); };
  }, [revision]);

  useEffect(() => () => { active.current?.abort(); }, []);

  function refresh() {
    setLoading(true); setError(null);
    setRevision((value) => value + 1);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current || !available || !prompt.trim() || (selected !== "mock" && !confirmed)) return;
    const controller = new AbortController();
    active.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 140000);
    setPending(true); setError(null); setResult(null);
    try {
      setResult(await sendPrompt(selected, prompt.trim(), confirmed, controller.signal));
    } catch (cause: unknown) {
      setError(timedOut ? "La consulta tardó demasiado. El CLI puede haber consumido cuota."
        : controller.signal.aborted ? "Consulta cancelada. La cuota ya utilizada no se recupera."
        : errorMessage(cause));
    } finally {
      window.clearTimeout(timeout);
      active.current = null;
      setPending(false); setConfirmed(false);
    }
  }

  return (
    <section className="cli-connections" aria-labelledby="cli-title">
      <div className="projects-heading">
        <div>
          <span className="eyebrow">HERRAMIENTAS OFICIALES</span>
          <h2 id="cli-title">Consulta con tu suscripción</h2>
          <p className="intro-copy">Prueba Codex CLI con tu sesión de ChatGPT. Las conversaciones de esta prueba no se guardan.</p>
        </div>
        <button className="quiet-button" disabled={loading || pending} onClick={refresh}>Actualizar conectores</button>
      </div>
      {loading ? <p role="status">Comprobando instalación y sesión…</p> : null}
      {loadError ? <div className="error-panel" role="alert"><p>{loadError}</p>
        <button disabled={loading || pending} onClick={refresh}>Reintentar conexión</button></div> : null}
      {!loading && !loadError ? (
        <form className="cli-form" onSubmit={(event) => { void submit(event); }}>
          <fieldset disabled={pending}>
            <legend className="sr-only">Conector y consulta de texto</legend>
            <div className="cli-options">
              <div className="name-field">
                <label htmlFor="cli-connector">Conector</label>
                <select id="cli-connector" value={selected} onChange={(event) => {
                  setSelected(event.target.value); setConfirmed(false); setError(null); setResult(null);
                }}>
                  {connectors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </div>
              <div className="cli-model"><span>Modelo</span><strong>{connector?.model}</strong></div>
            </div>
            {connector ? <p className="cli-state">{statuses[connector.status]}</p> : null}
            <p id="cli-detail" className="cli-detail">{connector?.detail}</p>
            <label className="name-field">Prompt de prueba
              <textarea value={prompt} required maxLength={16000} rows={4} aria-describedby="cli-detail"
                placeholder="Escribe tu consulta…" onChange={(event) => setPrompt(event.target.value)} />
            </label>
            {selected !== "mock" ? <label className="subscription-confirmation">
              <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
              <span>Confirmo enviar este prompt a Codex y utilizar la cuota de mi suscripción de ChatGPT.</span>
            </label> : null}
            <button className="primary-button" type="submit"
              disabled={!available || !prompt.trim() || (selected !== "mock" && !confirmed)}>
              {pending ? "Esperando respuesta…" : selected === "mock" ? "Probar sin conexión" : "Consultar Codex con ChatGPT"}
            </button>
          </fieldset>
        </form>
      ) : null}
      {pending ? <div className="cli-pending" role="status"><span>Codex está respondiendo…</span>
        <button type="button" onClick={() => active.current?.abort()}>Cancelar consulta</button></div> : null}
      {error ? <p className="error-panel" role="alert">{error}</p> : null}
      {result ? <div className="cli-result" role="status">
        <h3>Respuesta · {result.connector === "mock" ? "Simulado" : "Codex CLI"} · {result.model}</h3>
        <p>{result.text}</p>
      </div> : null}
    </section>
  );
}
