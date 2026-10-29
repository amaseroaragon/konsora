import { useEffect, useState } from "react";
import { getHealth } from "./api";

type ConnectionState =
  | { status: "loading" }
  | { status: "connected" }
  | { status: "error"; message: string };

export default function ConnectionStatus() {
  const [connection, setConnection] = useState<ConnectionState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 5000);

    async function checkConnection() {
      try {
        await getHealth(controller.signal);
        if (active) setConnection({ status: "connected" });
      } catch {
        if (active) setConnection({ status: "error", message: "El servicio local no está disponible." });
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

  return (
    <div className="connection-bar">
      <div className={`connection-status ${connection.status}`} role="status">
        <span className="status-dot" aria-hidden="true" />
        {connection.status === "loading"
          ? "Comprobando conexión…"
          : connection.status === "connected" ? "API conectada" : "Sin conexión con la API"}
      </div>
      <button className="quiet-button" disabled={connection.status === "loading"} onClick={() => {
        setConnection({ status: "loading" });
        setAttempt((value) => value + 1);
      }}>
        Comprobar conexión
      </button>
      {connection.status === "error" ? <span className="connection-hint">{connection.message}</span> : null}
    </div>
  );
}
