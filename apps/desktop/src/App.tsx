import { useEffect, useState } from "react";
import { API_URL, getHealth } from "./api";

type ConnectionState =
  | { status: "loading" }
  | { status: "connected" }
  | { status: "error"; message: string };

export default function App() {
  const [connection, setConnection] = useState<ConnectionState>({
    status: "loading",
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 5000);

    async function checkConnection() {
      try {
        await getHealth(controller.signal);
        if (active) setConnection({ status: "connected" });
      } catch (error: unknown) {
        if (active) {
          setConnection({
            status: "error",
            message:
              error instanceof Error && error.name !== "AbortError"
                ? error.message
                : "La API no respondió en 5 segundos.",
          });
        }
      } finally {
        window.clearTimeout(timeout);
      }
    }

    void checkConnection();
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [attempt]);

  function retryConnection() {
    setConnection({ status: "loading" });
    setAttempt((value) => value + 1);
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="#inicio" aria-label="Konsora, inicio">
          <span className="brand-mark" aria-hidden="true">k.</span>
          <span>Konsora</span>
        </a>
        <span className="local-label">Tu espacio de trabajo local</span>
      </header>

      <main id="inicio">
        <div className="intro">
          <span className="eyebrow">BIENVENIDO A KONSORA</span>
          <h1>Un espacio para pensar<br />y construir con IA.</h1>
          <p className="intro-copy">
            El punto de encuentro para tus proyectos, modelos y decisiones.
            Empezamos por una base local, bajo tu control.
          </p>
        </div>

        <section className="connection-card" aria-labelledby="connection-title">
          <div>
            <span className="eyebrow">ESTADO DEL SISTEMA</span>
            <h2 id="connection-title">Conexión con el servicio local</h2>
            <p className="endpoint">{API_URL}</p>
          </div>
          <div className="connection-actions">
            <div className={`connection-status ${connection.status}`} role="status" aria-live="polite">
              <span className="status-dot" aria-hidden="true" />
              {connection.status === "loading"
                ? "Comprobando conexión…"
                : connection.status === "connected"
                  ? "API conectada"
                  : "Sin conexión con la API"}
            </div>
            <button onClick={retryConnection} disabled={connection.status === "loading"}>
              {connection.status === "loading" ? "Comprobando…" : "Comprobar conexión"}
            </button>
          </div>
          {connection.status === "error" ? (
            <p className="error-message" role="alert">
              {connection.message} Comprueba que el backend esté en marcha con <code>npm run dev:api</code> y vuelve a intentarlo.
            </p>
          ) : null}
        </section>

        <section className="next-step" aria-labelledby="next-title">
          <span className="step-number" aria-hidden="true">01</span>
          <div>
            <h2 id="next-title">La base de tu espacio de trabajo</h2>
            <p>
              Esta primera versión comprueba la conexión local.
              La gestión de proyectos llegará en la siguiente etapa.
            </p>
          </div>
          <span className="stage-label">EN DESARROLLO</span>
        </section>
      </main>

      <footer>
        <span>Konsora · 0.1.0</span>
        <span>Hecho para trabajar desde tu escritorio.</span>
      </footer>
    </div>
  );
}
