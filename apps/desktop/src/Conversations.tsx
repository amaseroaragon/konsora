import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { createConversation, listConversations } from "./conversations";
import type { Conversation } from "./conversations";
import Chat from "./Chat";

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "No se pudieron cargar los chats.";
}

export default function Conversations({ projectId }: { projectId: string }) {
  const [chats, setChats] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const active = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    let mounted = true;
    void listConversations(projectId, controller.signal).then((data) => {
      if (mounted) { setChats(data); setError(null); }
    }).catch((cause: unknown) => {
      if (mounted) setError(errorMessage(cause));
    }).finally(() => {
      window.clearTimeout(timeout);
      if (mounted) setLoading(false);
    });
    return () => { mounted = false; window.clearTimeout(timeout); controller.abort(); };
  }, [projectId, revision]);

  useEffect(() => () => active.current?.abort(), []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current || !title.trim()) return;
    const controller = new AbortController();
    active.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    setCreating(true); setError(null);
    try {
      const chat = await createConversation(projectId, title.trim(), controller.signal);
      setChats((items) => [chat, ...items]); setSelected(chat.id); setTitle("");
    } catch (cause: unknown) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
      else setError("No se pudo confirmar la creación. Actualiza los chats antes de reintentar.");
    } finally {
      window.clearTimeout(timeout); active.current = null; setCreating(false);
    }
  }

  return (
    <section className="conversations" aria-labelledby="conversations-title">
      <div className="projects-heading"><h2 id="conversations-title">Conversaciones</h2>
        <button className="quiet-button" disabled={loading || creating} onClick={() => {
          setLoading(true); setRevision((value) => value + 1);
        }}>Actualizar chats</button></div>
      <form className="new-chat" onSubmit={(event) => { void create(event); }}>
        <label className="name-field" htmlFor="chat-title">Nombre del nuevo chat
          <input id="chat-title" required maxLength={120} value={title} disabled={creating}
            placeholder="Por ejemplo, ideas iniciales" onChange={(event) => setTitle(event.target.value)} />
        </label>
        <button className="primary-button" disabled={loading || creating || !title.trim()}>{creating ? "Creando…" : "+ Nuevo chat"}</button>
      </form>
      {loading ? <p role="status">Cargando chats…</p> : null}
      {error ? <p className="error-panel" role="alert">{error}</p> : null}
      {!loading && !error && chats.length === 0 ? <p className="cli-detail">Crea un chat para empezar. Su historial se guarda en este proyecto.</p> : null}
      <div className="chat-layout">
        <nav aria-label="Chats del proyecto"><ul className="chat-list">
          {chats.map((chat) => <li key={chat.id}>
            <button aria-current={selected === chat.id ? "page" : undefined} aria-label={`Abrir chat ${chat.title}`}
              onClick={() => setSelected(chat.id)}>{chat.title}</button>
          </li>)}
        </ul></nav>
        {selected ? <Chat key={selected} projectId={projectId} chatId={selected} onSaved={(saved) => {
          setChats((items) => items.map((item) => item.id === saved.id ? saved : item));
        }} /> : <p className="cli-detail">Abre un chat para consultar su historial o continuar la conversación.</p>}
      </div>
    </section>
  );
}
