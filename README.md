# Konsora

Konsora es un gestor y visualizador de tareas para proyectos que se trabajan con agentes de programación.
El plan de cada proyecto vive en `.konsora/tasks.json`, versionado con el código.
Las IAs lo leen y lo actualizan con la CLI `konsora`, su servidor MCP y una skill de Claude Code.
Tú lo ves en un tablero por estados y en un grafo de dependencias, sin aprobar nada tarea a tarea. Las tareas dependientes se agrupan en bloques con su propia rama, y cuando terminan haces el merge desde la UI.
Un panel de IA en la UI te deja planificar con Claude Code, que propone tareas para que las apruebes.
Es local y de uso personal.

## Instalación

```bash
npm ci
npm run install:global   # enlaza el comando `konsora` (npm link); se actualiza con git pull
cd ~/mi-proyecto
konsora init             # crea .konsora/tasks.json, la skill y el servidor MCP en .mcp.json
konsora ui               # abre la UI
```

Requisitos: Node ≥ 22.18 y, para el panel de IA y `konsora plan`, Claude Code instalado y autenticado.

Más información en [docs/vision.md](docs/vision.md) y [docs/roadmap.md](docs/roadmap.md).
