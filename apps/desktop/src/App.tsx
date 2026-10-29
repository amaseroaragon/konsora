import ConnectionStatus from "./ConnectionStatus";
import Projects from "./Projects";
import CLIConnections from "./CLIConnections";

export default function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="#inicio" aria-label="Konsora, inicio">
          <span className="brand-mark" aria-hidden="true">k.</span>
          <span>Konsora</span>
        </a>
        <span className="local-label">Tu espacio de trabajo local</span>
      </header>
      <main id="inicio"><Projects /><CLIConnections /></main>
      <ConnectionStatus />
      <footer>
        <span>Konsora · 0.1.0</span>
        <span>Hecho para trabajar desde tu escritorio.</span>
      </footer>
    </div>
  );
}
