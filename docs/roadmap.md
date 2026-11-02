# Roadmap

Hitos pequeños, cada uno con un criterio de **hecho** verificable. Un hito no se da por cerrado hasta que sus comprobaciones pasan y quedan registradas en el commit (comandos ejecutados y resultado). Cuando exista la CLI (M2), cada hito se gestionará como tareas en `.konsora/tasks.json` del propio repo: Konsora se usará para desarrollar Konsora.

Leyenda: 🔧 entregables · ✅ hecho cuando…

## M0 — Reinicio ✔ (2026-10-31)

🔧 Etiqueta `legacy-v0` sobre el último commit del v0. Retirada de `apps/desktop`, `services/api`, `scripts/` y los docs antiguos (siguen accesibles en la etiqueta; por decisión del autor no se archivan en el árbol). Monorepo npm workspaces con `packages/{core,runner,cli,daemon,web}` vacíos pero compilables, Biome, `tsconfig` estricto compartido y vitest. Nuevo `.konsora/tasks.json` v2, escrito a mano, con las tareas de M1–M3.
✅ `npm ci && npm run check` en verde desde un clon limpio. `git ls-files` no contiene código del v0. El `tasks.json` nuevo valida contra el esquema de `docs/esquema-tareas.md` (comprobación manual hasta M1).

## M1 — Núcleo v2 (`packages/core`) ✔ (2026-10-31)

🔧 Esquema zod y `schema/tasks.v2.schema.json` generado. Validación estructural y semántica con errores `{path, code, message}`. Serializador canónico. Grafo (blocked, ready, waiting, ciclos, orden topológico, cadena YOLO). Máquina de estados con roles. Operaciones semánticas con precondición por tarea. Store con lock por PID, escritura atómica con `fsync` y watcher.
✅ Tests de propiedades: `serialize(parse(x)) === x` para documentos canónicos generados; un documento con ciclo siempre se rechaza; ninguna operación de agente produce `→ todo` desde `proposed` ni `→ done`. Test de **dos procesos reales** escribiendo 200 operaciones intercaladas: no se pierde ninguna y el archivo final es válido. Un archivo inválido nunca se sobrescribe.

## M2 — CLI (`konsora`) ✔ (2026-10-31)

🔧 `init`, `status`, `list`, `show`, `ready`, `blocked`, `check`, `propose`, `batch`, `edit`, `withdraw`, `depend`, `undepend`, `start`, `pause`, `note`, `ask`, `finish` y `migrate` (v1 → v2), con `--json` y `--as`. Skill o snippet de protocolo para agentes, instalado por `init`.
✅ Tests e2e sobre un repo temporal. `konsora migrate --dry-run` sobre el `tasks.json` de `legacy-v0` muestra el mapeo esperado, y la migración real produce un archivo válido conservando el historial en `.konsora/legacy/`. Una sesión manual de Claude Code, siguiendo la skill, propone tareas con `batch` y las ve con `status`.

## M3 — Daemon y tablero ✔ (2026-11-01)

🔧 Daemon en loopback con token y validación de Host y Origin, registro de proyectos, endpoints de lectura y operaciones, WS `board.*`, registro de aprobaciones. `konsora ui`. UI web: lista de proyectos, tablero por estados con arrastrar y soltar validado, y acciones humanas (aprobar, aceptar, devolver con feedback, reabrir).
✅ Al editar `tasks.json` con un editor, la UI se actualiza en menos de 1 s sin recargar. Un archivo inválido muestra sus errores y bloquea la escritura. Una petición sin token, o con `Origin` ajeno, recibe 403 (con test). Poner `done` a mano en el archivo aparece como "cambio externo sin aprobar".

## M4 — Grafo y detalle ✔ (2026-11-01)

🔧 Vista de grafo (`@xyflow/react` + ELK) coloreada por estado, con selección de subgrafo. Panel de detalle: markdown, criterios, línea de tiempo de notas, dependencias navegables y edición del trabajo aprobado (solo el humano).
✅ Un proyecto de 150 tareas se dibuja en menos de 1 s y es navegable con el teclado. Una selección en el grafo se conserva al pasar al tablero.

## M5 — Servidor MCP ✔ (2026-11-01)

🔧 `konsora mcp` (stdio), con las mismas operaciones de agente que la CLI, y modo run (`KONSORA_RUN`/`KONSORA_TASK`) con escritura limitada a su tarea. Herramienta `permission`.
✅ Una sesión real de Claude Code y otra de Codex, cada una con el MCP configurado, listan las tareas ready, empiezan una, añaden una nota y la terminan con un resumen. En modo run, intentar escribir en otra tarea devuelve un error (con test).

## M6 — Primer runner: Claude ✔ (2026-11-01)

🔧 `packages/runner`: interfaz `AgentAdapter`, adaptador de Claude (stream-json), worktree y rama por run, prompt de run explícito, `events.jsonl` y `run.json`, cancelación (SIGINT → SIGTERM), estado `interrupted` tras reiniciar, `diff.patch`, integración squash al aceptar. En la UI: botón Ejecutar, log en vivo, aprobaciones, vista de revisión con diff.
✅ En un repo fixture, se ejecuta una tarea con el `claude` real; el log llega en vivo a la UI; la revisión muestra el diff; al aceptar queda **exactamente un commit** nuevo en `main` con trailers `Konsora-Task`/`Konsora-Run`, y el worktree y la rama se borran. Cancelar a mitad deja la tarea en `todo` y el run en `cancelled`. Tests del adaptador con grabaciones, sin gastar cuota.

## M7 — Codex y selector de modelo ✔ (2026-11-02)

🔧 Adaptador `codex app-server` con tipos generados y comprobación de versión (plan B: `exec --json`). Selector de proveedor, modelo, esfuerzo y perfil por tarea y en la barra de selección, con los modelos que publica cada adaptador. Uso y rate limits visibles cuando el proveedor los expone; para Claude, se investiga qué ofrece su salida.
✅ La misma tarea fixture termina con Codex de principio a fin, como en M6. El selector solo ofrece modelos y niveles que el adaptador declara. Tras cada run, la UI muestra el uso de tokens o deja claro que el proveedor no lo da.

## M8 — Verificación automática

🔧 Ejecución de `project.checks` y `acceptance[].check` en el worktree, con timeout; `checks.json`; bucle de corrección (devolver al agente con la salida de los checks fallidos, hasta N reintentos configurables).
✅ Una tarea fixture con un test que falla al principio la corrige el agente en el reintento, y la revisión muestra el historial de checks. Si se agotan los reintentos, la tarea llega a `review` con los checks en rojo, nunca en verde.

## M9 — Ejecución paralela

🔧 Cola persistente, scheduler DAG con `max_parallel` global y por proveedor, encadenado YOLO con integración automática, vista de runs activos, detección de conflictos de integración y flujo para pedir rebase al agente.
✅ Un fixture con un DAG de 6 tareas (2 ramas independientes y un nodo final) en YOLO, con `max_parallel = 2`, se ejecuta sin superar nunca 2 runs a la vez y sin empezar ninguna tarea antes de integrar sus dependencias; termina con 6 commits en orden topológico y la tarea final en `review`. Reiniciar el daemon a mitad marca los runs vivos como `interrupted` y no lanza nada por su cuenta.

## M10 — Escritorio

🔧 `apps/desktop` (Tauri 2): arranca o reutiliza el daemon y carga la UI; notificaciones nativas (pregunta de un agente, run terminado); paquete `.deb`.
✅ Al instalar el `.deb` en Ubuntu 24.04 limpio (con Node), se abre la app, se vincula un proyecto y se ejecuta el flujo de M6. Al cerrar la ventana no quedan procesos huérfanos.

---

## Ideas diferenciales (después de M10, cada una requiere su propio alcance)

| Idea | Valor |
|---|---|
| **Planificación por entrevista** | Un comando `plan` lanza un agente con un prompt de entrevista que solo puede usar `propose`/`batch`. El resultado es un lote de propuestas revisables. |
| **Best-of-N** | La misma tarea se ejecuta con dos proveedores o modelos en worktrees separados, y eliges el mejor diff. Las ejecuciones perdedoras se conservan. |
| **Revisor automático** | Un segundo modelo revisa el diff antes de que te llegue (con permisos de solo lectura) y deja notas `note`. Nunca acepta por su cuenta. |
| **Scheduler consciente de rate limits** | La cola se pausa o cambia de proveedor cuando se acerca el límite de 5 h o el semanal, solo si tú lo autorizas en la configuración. |
| **Predicción de conflictos** | Antes de lanzar runs en paralelo, se estiman los ficheros que tocará cada tarea (por historial o por la descripción) y se avisa de solapamientos. |
| **Ejecución apilada** | Se empieza una tarea sobre la rama de una dependencia que aún está en `review`, y se hace rebase al aceptarla. |
| **Reintentar con otro modelo** | Desde la revisión, se reejecuta con el feedback y otro proveedor en un clic. |
| **Coste por tarea y grupo** | Uso acumulado de todas las ejecuciones de una tarea o de un grupo. |
| **Plantillas de tarea** | Criterios y checks reutilizables, por ejemplo "endpoint REST con test" o "migración de BD". |
| **Repetición de un run** | Línea de tiempo navegable de eventos, con los ficheros tocados en cada paso. |
| **Adaptadores adicionales** | Gemini CLI, OpenCode o un adaptador ACP genérico, cada uno tras verificar sus condiciones oficiales. |
