import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { listConnectors } from "./connectors";
import type { ConnectorInfo } from "./connectors";
import { openConversation, sendMessage } from "./conversations";
import type { Conversation, ConversationHistory } from "./conversations";

const dateFormat = new Intl.DateTimeFormat("es", { dateStyle: "short", timeStyle: "short" });
function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "No se pudo completar la consulta.";
}

export default function Chat({ projectId, chatId, onSaved }: {
  projectId: string; chatId: string; onSaved: (conversation: Conversation) => void;
}) {
  const [history, setHistory] = useState<ConversationHistory | null>(null);
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [selected, setSelected] = useState("mock");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const active = useRef<AbortController | null>(null);
  const messageList = useRef<HTMLOListElement | null>(null);
  const mounted = useRef(true);
  const connector = connectors.find((item) => item.id === selected);
  const available = connector?.status === "ready" || connector?.status === "simulated";

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    let current = true;
    void Promise.all([
      openConversation(projectId, chatId, controller.signal), listConnectors(controller.signal),
    ]).then(([data, options]) => {
      if (current) {
        setHistory(data); setConnectors(options); setSelected(data.conversation.connector);
        setModel(data.conversation.model ?? ""); setLoadError(null); setConfirmed(false);
      }
    }).catch((cause: unknown) => {
      if (current) setLoadError(errorMessage(cause));
    }).finally(() => {
      window.clearTimeout(timeout);
      if (current) setLoading(false);
    });
    return () => { current = false; window.clearTimeout(timeout); controller.abort(); };
  }, [projectId, chatId, revision]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.abort(); };
  }, []);

  useEffect(() => {
    const list = messageList.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [history?.messages.length]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current || !history || !available || !prompt.trim() || (selected !== "mock" && !confirmed)) return;
    const controller = new AbortController();
    active.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 140000);
    setPending(true); setError(null);
    try {
      const data = await sendMessage(projectId, chatId, prompt.trim(), selected,
        selected === "mock" ? null : model.trim() || null, confirmed, controller.signal);
      if (mounted.current) { setHistory(data); setPrompt(""); onSaved(data.conversation); }
    } catch (cause: unknown) {
      if (mounted.current) setError(timedOut ? "La consulta tardó demasiado. Actualiza el historial antes de reenviar; puede haber consumido cuota."
        : controller.signal.aborted ? "Consulta cancelada. Actualiza el historial antes de reenviar; la cuota ya utilizada no se recupera."
        : errorMessage(cause));
    } finally {
      window.clearTimeout(timeout); active.current = null;
      if (mounted.current) { setPending(false); setConfirmed(false); }
    }
  }

  return (
    <section className="chat-panel" aria-labelledby="chat-heading">
      <div className="projects-heading"><h3 id="chat-heading">{history?.conversation.title ?? "Chat"}</h3>
        <button className="quiet-button" disabled={loading || pending} onClick={() => {
          setLoading(true); setRevision((value) => value + 1);
        }}>Actualizar historial y conectores</button></div>
      {loading ? <p role="status">Cargando historial y conectores…</p> : null}
      {loadError ? <p className="error-panel" role="alert">{loadError}</p> : null}
      {history ? <>
        <ol ref={messageList} className="message-list" aria-label="Historial del chat" aria-live="polite">
          {history.messages.map((message) => <li key={message.id} className={`message message-${message.role}`}>
            <div className="message-meta"><strong>{message.role === "user" ? "Tú" : `${message.connector === "mock" ? "Simulado" : "Codex CLI"} · ${message.model}`}</strong>
              <time dateTime={message.created_at}>{dateFormat.format(new Date(message.created_at))}</time></div>
            <p>{message.content}</p>
          </li>)}
        </ol>
        {history.messages.length === 0 ? <p className="cli-detail">Este chat todavía no tiene mensajes.</p> : null}
        <form className="cli-form" onSubmit={(event) => { void submit(event); }}>
          <fieldset disabled={pending || loading || loadError !== null}>
            <legend className="sr-only">Enviar mensaje al chat</legend>
            <div className="cli-options">
              <div className="name-field"><label htmlFor="chat-connector">Conector del chat</label>
                <select id="chat-connector" value={selected} onChange={(event) => { setSelected(event.target.value); setModel(""); setConfirmed(false); }}>
                  {connectors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </div>
              {selected !== "mock" ? <div className="name-field"><label htmlFor="chat-model">Modelo de Codex</label>
                <input id="chat-model" aria-describedby="chat-model-hint" value={model} maxLength={120} pattern="[A-Za-z0-9][A-Za-z0-9._\-]*"
                  placeholder={connector?.model} onChange={(event) => { setModel(event.target.value); setConfirmed(false); }} />
                <span id="chat-model-hint" className="field-hint">Vacío: {connector?.model}. Escribe un identificador disponible en tu cuenta.</span>
              </div> : <div className="cli-model"><span>Modelo</span><strong>Simulado local</strong></div>}
            </div>
            <p className="cli-detail">{connector?.detail}</p>
            <label className="name-field">Mensaje
              <textarea required rows={4} maxLength={16000} value={prompt} placeholder="Continúa la conversación…"
                onChange={(event) => { setPrompt(event.target.value); setConfirmed(false); }} />
            </label>
            <p className="cli-detail">Se envía el historial completo de este chat como contexto, hasta 64000 caracteres. Los mensajes se guardan juntos al recibir la respuesta. Cambiar de chat o proyecto cancela la consulta en curso.</p>
            {selected !== "mock" ? <label className="subscription-confirmation">
              <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
              <span>Confirmo enviar este mensaje y el historial a Codex y utilizar la cuota de mi suscripción de ChatGPT.</span>
            </label> : null}
            <button className="primary-button" disabled={!available || !prompt.trim() || (selected !== "mock" && !confirmed)}>
              {pending ? "Esperando respuesta…" : selected === "mock" ? "Enviar al simulador" : "Enviar a Codex"}
            </button>
          </fieldset>
        </form>
      </> : null}
      {pending ? <div className="cli-pending" role="status"><span>Esperando respuesta…</span>
        <button type="button" onClick={() => active.current?.abort()}>Cancelar mensaje</button></div> : null}
      {error ? <p className="error-panel" role="alert">{error}</p> : null}
    </section>
  );
}
