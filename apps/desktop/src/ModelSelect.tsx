import { useEffect, useState } from "react";
import { listModels } from "./connectors";
import type { ConnectorInfo, ConnectorModel } from "./connectors";

export default function ModelSelect({ connector, value, disabled, revision, onChange }: {
  connector: ConnectorInfo | undefined; value: string; disabled: boolean;
  revision: number; onChange: (model: string) => void;
}) {
  const [models, setModels] = useState<ConnectorModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const id = connector?.id;
  const ready = connector?.status === "ready";

  useEffect(() => {
    if (!id || !ready) { setModels([]); setLoading(false); setError(null); return; }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 40000);
    let current = true;
    setLoading(true); setError(null);
    void listModels(id, controller.signal).then((data) => {
      if (current) setModels(data);
    }).catch((cause: unknown) => {
      if (current) setError(cause instanceof Error ? cause.message : "No se pudo cargar el catálogo.");
    }).finally(() => {
      window.clearTimeout(timeout);
      if (current) setLoading(false);
    });
    return () => { current = false; window.clearTimeout(timeout); controller.abort(); };
  }, [id, ready, revision, attempt]);

  return (
    <div className="name-field"><label htmlFor="chat-model">Modelo de Codex</label>
      <select id="chat-model" aria-describedby="chat-model-hint" value={value} disabled={disabled || loading}
        onChange={(event) => onChange(event.target.value)}>
        <option value="">{connector?.model ?? "Predeterminado de Codex"}</option>
        {value && !models.some((item) => item.id === value) ? <option value={value}>{value} · Guardado en este chat</option> : null}
        {models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <span id="chat-model-hint" className="field-hint">El acceso al modelo se comprueba al enviar.</span>
      {loading ? <span className="field-hint" role="status">Cargando modelos…</span> : null}
      {error ? <span className="form-error" role="alert">{error}</span> : null}
      {error ? <button type="button" className="quiet-button" disabled={disabled || loading} onClick={() => setAttempt((item) => item + 1)}>Reintentar modelos</button> : null}
    </div>
  );
}
