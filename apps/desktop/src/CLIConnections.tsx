import { useEffect, useState } from "react";
import { listConnectors } from "./connectors";
import type { ConnectorInfo } from "./connectors";

const statuses: Record<ConnectorInfo["status"], string> = {
  ready: "Codex conectado · ChatGPT", simulated: "Simulado disponible",
  missing: "Codex no instalado", login_required: "Codex necesita iniciar sesión",
  api_login: "Codex: sesión de API rechazada", unsupported: "Codex no compatible",
  error: "No se pudo comprobar Codex",
};

export default function CLIConnections() {
  const [connector, setConnector] = useState<ConnectorInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    let current = true;
    void listConnectors(controller.signal).then((data) => {
      if (current) { setConnector(data.find((item) => item.id === "codex") ?? null); setError(null); }
    }).catch((cause: unknown) => {
      if (current) { setConnector(null); setError(cause instanceof Error ? cause.message : "No se pudo comprobar Codex."); }
    }).finally(() => {
      window.clearTimeout(timeout);
      if (current) setLoading(false);
    });
    return () => { current = false; window.clearTimeout(timeout); controller.abort(); };
  }, [revision]);

  const ready = connector?.status === "ready";
  return (
    <div className="connection-bar" aria-label="Conexión de Codex">
      <span className={`connection-status ${loading ? "loading" : ready ? "connected" : "error"}`}
        role="status" title={connector?.detail}>
        <span className="status-dot" aria-hidden="true" />
        {loading ? "Comprobando Codex…" : connector ? statuses[connector.status] : "Codex no disponible"}
      </span>
      <button className="quiet-button" disabled={loading} onClick={() => {
        setLoading(true); setRevision((value) => value + 1);
      }}>Comprobar Codex</button>
      {!loading && (error || (connector && !ready)) ? <span className="connection-hint" role="alert">{error ?? connector?.detail}</span> : null}
    </div>
  );
}
