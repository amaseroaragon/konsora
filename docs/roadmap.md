# Roadmap

Hitos pequeños, cada uno con un criterio de **hecho** verificable. Un hito no se da por cerrado hasta que sus comprobaciones pasan y quedan registradas en el commit (comandos ejecutados y resultado). Cada hito se gestiona como tareas en `.konsora/tasks.json` del propio repo: Konsora se usa para desarrollar Konsora.

Leyenda: 🔧 entregables · ✅ hecho cuando…

## Historia (M0–M9, cerrados)

Del 2026-10-31 al 2026-11-08 Konsora se construyó como gestor **y lanzador** de tareas. Hubo un reinicio sobre el v0 (etiqueta `legacy-v0`), luego el núcleo v2, la CLI, el daemon y el tablero, el grafo y el detalle, el servidor MCP, los runners de Claude Code y Codex en worktrees, la verificación automática con checks y la ejecución paralela con cola y YOLO. El 2026-11-11 se decidió dejar de ejecutar agentes (M11). Ese código solo queda en el historial de git. El backlog de esa etapa está en el historial de `.konsora/tasks.json`, y en sus mensajes de commit figura qué se verificó en cada hito.

Lo que sigue en pie de esa etapa: el núcleo (esquema, validación, serializador canónico, grafo, máquina de estados, store con lock y escritura atómica), la CLI, el servidor MCP, el daemon en loopback con detección de cambios externos y la UI con el sistema de diseño *Plano*, el tablero, el grafo, el panel de tarea, la edición, las plantillas y el modo solo lectura.

## M11 — Giro a gestor y visualizador

🔧 Fuera `packages/runner`, `apps/desktop` y todo lo ligado a runs en core, daemon, CLI y web (runs, colas, límites, costes, aprobaciones de permisos, variantes, revisor, checks y setup). Esquema `konsora/3` sin campos de ejecución y `konsora migrate` v2→v3. `konsora init` instala la skill y el servidor MCP de Claude Code. `npm run install:global` instala la CLI global. Panel de IA en la UI: un chat de planificación sobre `claude -p` que solo puede proponer. Crear tareas desde la UI (aprobadas o como propuesta) y aprobación en lote desde la barra de selección. Docs y backlog nuevos.
✅ `npm run check` en verde. `konsora migrate` convierte el `tasks.json` v2 de este repo en un v3 válido. En un repo temporal, `konsora init` deja la skill y `.mcp.json`, y una sesión de Claude Code con ese MCP propone una tarea que se ve en `konsora status`. En `konsora ui`, el tablero y el grafo cargan, se crea, edita, aprueba y acepta una tarea, y el panel de IA propone una tarea que aparece como `proposed`.

## Después de M11 (cada idea requiere su propio alcance)

| Idea | Valor |
|---|---|
| **Responder preguntas en lote** | Una vista de todas las tareas que esperan respuesta, en todos los proyectos. |
| **Panel de IA con lectura del código** | Que el chat de planificación pueda leer el repo (solo lectura) para proponer tareas mejor ajustadas. |
| **Enlaces a commits** | Asociar a cada tarea los commits que la mencionan y mostrarlos en la revisión. |
| **Historial navegable** | Línea de tiempo de los cambios del plan, con quién hizo qué. |
| **Otros agentes** | Integración de `init` para Codex u otros CLI, cada una tras verificar sus condiciones oficiales. |
