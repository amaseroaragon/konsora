# Konsora

Konsora es un gestor y lanzador de tareas para agentes de programación.
Lee el plan de cada proyecto desde `.konsora/tasks.json`, versionado con el código.
Lo muestra en un tablero por estados y en un grafo de dependencias.
Los agentes proponen tareas; tú las apruebas, eliges proveedor y modelo, y las ejecutas.
Cada ejecución corre en su propio worktree y en paralelo, respetando las dependencias.
Konsora verifica el resultado y te deja revisarlo con su diff antes de integrarlo con un commit por tarea.
Los agentes leen y actualizan el plan a través de una CLI y un servidor MCP.
Es local y de uso personal, y utiliza los CLI oficiales (Claude Code y Codex) con tu propio login.
Más información en [docs/vision.md](docs/vision.md) y [docs/roadmap.md](docs/roadmap.md).
