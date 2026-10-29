import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { generate, listProviders } from "./providers";
import type { Generation, ProviderInfo } from "./providers";

function message(error: unknown) {
  return error instanceof Error ? error.message : "No se pudo completar la petición.";
}

export default function ModelConnections() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providerId, setProviderId] = useState("mock");
  const [modelChoice, setModelChoice] = useState("");
  const [prompt, setPrompt] = useState("");
  const [tokenLimit, setTokenLimit] = useState("512");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Generation | null>(null);
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef<AbortController | null>(null);
  const provider = providers.find((item) => item.id === providerId);
  const model = provider?.models.includes(modelChoice) ? modelChoice : provider?.models[0] ?? "";

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    let active = true;
    async function load() {
      try {
        const data = await listProviders(controller.signal);
        if (active) { setProviders(data); setLoadError(null); }
      } catch (cause: unknown) {
        if (active) setLoadError(message(cause));
      } finally {
        window.clearTimeout(timeout);
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; window.clearTimeout(timeout); controller.abort(); };
  }, [revision]);

  useEffect(() => () => { generation.current?.abort(); }, []);

  function refresh() {
    setLoading(true);
    setError(null);
    setRevision((value) => value + 1);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (generation.current || !provider?.available || !model || !prompt.trim()) return;
    const controller = new AbortController();
    generation.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 55000);
    setPending(true);
    setResult(null);
    setError(null);
    try {
      setResult(await generate(provider.id, model, prompt.trim(), Number(tokenLimit), controller.signal));
    } catch (cause: unknown) {
      setError(message(cause));
    } finally {
      window.clearTimeout(timeout);
      generation.current = null;
      setPending(false);
    }
  }

  return (
    <section className="model-connections" aria-labelledby="models-title">
      <div className="projects-heading">
        <div>
          <span className="eyebrow">CONEXIONES</span>
          <h2 id="models-title">Prueba un modelo</h2>
          <p className="intro-copy">Envía un prompt para comprobar la conexión. Esta prueba no guarda conversaciones.</p>
        </div>
        <button className="quiet-button" disabled={loading || pending} onClick={refresh}>Actualizar proveedores</button>
      </div>
      {loading ? <p role="status">Cargando proveedores…</p> : null}
      {loadError ? <div className="error-panel" role="alert"><p>{loadError}</p>
        <button disabled={loading || pending} onClick={refresh}>Reintentar conexión</button></div> : null}
      {!loading && !loadError ? (
        <form className="model-form" onSubmit={(event) => { void submit(event); }}>
          <fieldset disabled={pending}>
            <legend className="sr-only">Proveedor y prompt de prueba</legend>
            <div className="model-options">
              <div className="name-field">
                <label htmlFor="model-provider">Proveedor</label>
                <select id="model-provider" value={providerId} onChange={(event) => {
                  setProviderId(event.target.value); setModelChoice(""); setResult(null); setError(null);
                }}>
                  {providers.map((item) => <option key={item.id} value={item.id}>
                    {item.name}{item.available ? "" : " · sin configurar"}
                  </option>)}
                </select>
              </div>
              <div className="name-field">
                <label htmlFor="provider-model">Modelo</label>
                <select id="provider-model" value={model} disabled={!provider?.available} onChange={(event) => {
                  setModelChoice(event.target.value); setResult(null); setError(null);
                }}>
                  {provider?.models.length ? provider.models.map((item) => <option key={item}>{item}</option>)
                    : <option value="">Sin modelo configurado</option>}
                </select>
              </div>
              <label className="name-field">Máximo de tokens de salida
                <input type="number" required min={16} max={2048} step={1} value={tokenLimit}
                  onChange={(event) => setTokenLimit(event.target.value)} />
              </label>
            </div>
            <p id="provider-detail" className="provider-detail">{provider?.detail}</p>
            {providerId === "openai" ? <p className="provider-notice">
              OpenAI recibe el prompt al enviarlo. Necesitas una clave y saldo o créditos de API;
              ChatGPT Plus no incluye este consumo. La clave se configura solo en el backend.
            </p> : null}
            <label className="name-field">Prompt de prueba
              <textarea value={prompt} required maxLength={16000} rows={4} aria-describedby="provider-detail"
                placeholder="Escribe algo para comprobar la respuesta…" onChange={(event) => setPrompt(event.target.value)} />
            </label>
            <button className="primary-button" type="submit" disabled={!provider?.available || !model || !prompt.trim()}>
              {pending ? "Esperando respuesta…" : providerId === "openai" ? "Enviar a OpenAI · consume saldo" : "Probar sin conexión"}
            </button>
          </fieldset>
        </form>
      ) : null}
      {pending ? <p role="status">Esperando la respuesta del modelo…</p> : null}
      {error ? <p className="error-panel" role="alert">{error}</p> : null}
      {result ? <div className="model-result" role="status">
        <h3>Respuesta · {result.provider === "mock" ? "Simulado" : "OpenAI"} / {result.model}</h3>
        <p>{result.text}</p>
      </div> : null}
    </section>
  );
}
