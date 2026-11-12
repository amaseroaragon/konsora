# Roadmap

Hitos pequeños, cada uno con un criterio de **hecho** verificable. Un hito no se da por cerrado hasta que sus comprobaciones pasan y quedan registradas en el commit (comandos ejecutados y resultado). Cada hito se gestiona como tareas en `.konsora/tasks.json` del propio repo: Konsora se usa para desarrollar Konsora.

Leyenda: 🔧 entregables · ✅ hecho cuando…

## Historia (M0–M9, cerrados)

Del 2026-10-31 al 2026-11-08 Konsora se construyó como gestor **y lanzador** de tareas. Hubo un reinicio sobre el v0 (etiqueta `legacy-v0`), luego el núcleo v2, la CLI, el daemon y el tablero, el grafo y el detalle, el servidor MCP, los runners de Claude Code y Codex en worktrees, la verificación automática con checks y la ejecución paralela con cola y YOLO. El 2026-11-11 se decidió dejar de ejecutar agentes (M11). Ese código solo queda en el historial de git. El backlog de esa etapa está en el historial de `.konsora/tasks.json`, y en sus mensajes de commit figura qué se verificó en cada hito.

Lo que sigue en pie de esa etapa: el núcleo (esquema, validación, serializador canónico, grafo, máquina de estados, store con lock y escritura atómica), la CLI, el servidor MCP, el daemon en loopback con detección de cambios externos y la UI con el sistema de diseño *Plano*, el tablero, el grafo, el panel de tarea, la edición, las plantillas y el modo solo lectura.

## M11 — Giro a gestor y visualizador

🔧 Fuera `packages/runner`, `apps/desktop` y todo lo ligado a runs en core, daemon, CLI y web (runs, colas, límites, costes, aprobaciones de permisos, variantes, revisor, checks y setup). Esquema `konsora/3` sin campos de ejecución y `konsora migrate` v2→v3. `konsora init` instala la skill y el servidor MCP de Claude Code. `npm run install:global` instala la CLI global. Panel de IA en la UI: un chat de planificación sobre `claude -p` que solo puede proponer. Crear tareas desde la UI (aprobadas o como propuesta) y aprobación en lote desde la barra de selección. Docs y backlog nuevos.
✅ `npm run check` en verde. `konsora migrate` convierte el `tasks.json` v2 de este repo en un v3 válido. En un repo temporal, `konsora init` deja la skill y `.mcp.json`, y una sesión de Claude Code con ese MCP propone una tarea que se ve en `konsora status`. En `konsora ui`, el tablero y el grafo cargan, se crea, edita, aprueba y acepta una tarea, y el panel de IA propone una tarea que aparece como `proposed`.

## M12 — Sin aprobación, eliminar tareas y bloques con merge

🔧 Esquema `konsora/4`: sin `review` ni YOLO, `proposed` como ideas, bloques (`blocks`, `task.block`) y migración desde v3 (review → done con nota). Ops `delete` (dependientes pierden la dependencia, con nota), `promote`, `add-block`, `edit-block`, `delete-block`, `set-block` y `mark-merged`; `finish` lleva a `done`. CLI y MCP con los mismos comandos y la rama del bloque al empezar y terminar. Daemon: merge local del bloque (`merge-tree` + `commit-tree` + `ff-only`/`update-ref`), ramas del proyecto y cambios externos con las reglas nuevas. Web: eliminar y pasar a Por hacer (panel y selección), bloque en el panel, la tarjeta y la creación, y la vista Bloques con Merge.
✅ `npm run check` en verde. Tests con git real: squash sin tocar el árbol cuando la base no está abierta, merge commit con la base abierta, y conflicto, cambios locales o bloque sin terminar rechazados sin cambiar nada. `konsora migrate --write` convierte el backlog v3 de este repo en v4. En `konsora ui`, un bloque de dos tareas terminadas por un agente se integra con Merge y queda un commit en la base (prueba manual).

## M13 — Historial de tareas hechas

🔧 `completionLog` en `core`: tareas hechas (fechadas por su última nota `summary`, o por `updated_at`) y bloques integrados, de lo más reciente a lo más antiguo. Vista **Historial** en la web, agrupada por día local, con la hora, quién terminó cada tarea y la primera línea de su resumen, y enlace al panel de la tarea. Sustituye a la aprobación como forma de ver qué han cerrado los agentes.
✅ `npm run check` en verde. En `konsora ui`, una tarea terminada con `konsora finish` aparece en el Historial sin recargar, y al pulsarla se abre su panel con el resumen de cierre (prueba manual).

## M14 — Fuera los bloques

Los bloques de M12 (tareas en una rama de git que el humano integraba con un merge desde la UI) tenían sentido cuando Konsora lanzaba agentes. Como gestor y visualizador solo añadían ceremonia y una dependencia de git, así que se retiran. Konsora deja de ejecutar git: cada uno integra el código con su flujo de siempre.

🔧 Esquema `konsora/5` sin `blocks` ni `task.block`, y `konsora migrate` v4→v5, que lista los bloques que quita con su rama (las ramas no se tocan). Fuera las ops `add-block`, `edit-block`, `delete-block`, `set-block` y `mark-merged`, sus comandos de la CLI y sus herramientas del MCP, el merge y las rutas de git del daemon (`git.ts`), y en la web la vista Bloques, el selector de bloque, el menú «Mover a…» y las entradas de merges del Historial. Un plan antiguo abre en solo lectura con la pista de `konsora migrate`. De paso, el agente del panel de IA puede leer el código (solo lectura, M13).
✅ `npm run check` en verde. `konsora migrate --write` convierte el backlog v4 de este repo en v5. Ningún código de Konsora ejecuta git.

## Después de M14 (cada idea requiere su propio alcance)

| Idea | Valor |
|---|---|
| **Responder preguntas en lote** | Una vista de todas las tareas que esperan respuesta, en todos los proyectos. |
| **Enlaces a commits** | Asociar a cada tarea los commits que la mencionan y mostrarlos en su panel y en el Historial. |
| **Historial de cambios del plan** | Ampliar el Historial (hoy solo cierres) a todos los cambios del plan, con quién hizo qué. |
| **Otros agentes** | Integración de `init` para Codex u otros CLI, cada una tras verificar sus condiciones oficiales. |
