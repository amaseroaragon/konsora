# Konsora

Konsora es un gestor y visualizador de tareas para proyectos que se trabajan con agentes de programación. Se instala en un proyecto con `konsora init`, que crea `.konsora/tasks.json`, la skill de Claude Code y el servidor MCP en `.mcp.json`. Las IAs usan ese plan como plantilla a través de la CLI, el MCP y la skill, y la UI (`konsora ui`) lo muestra en un tablero y en un grafo, con un panel de IA para planificar. No hay aprobación ni revisión por tarea: los agentes las crean y las terminan, y el humano ve lo que han cerrado en el Historial. Konsora **no ejecuta agentes** ni toca git. Es local, de uso personal y para Ubuntu primero.

Documentación de referencia (léela antes de cambiar algo en su ámbito):
- [docs/vision.md](docs/vision.md): problema, flujo, principios y no-objetivos.
- [docs/arquitectura.md](docs/arquitectura.md): paquetes, instalación en un proyecto, daemon, panel de IA, canal de agentes y ADR.
- [docs/esquema-tareas.md](docs/esquema-tareas.md): formato `konsora/5`, máquina de estados y roles, concurrencia y migraciones.
- [docs/roadmap.md](docs/roadmap.md): historia de M0–M9, el giro de M11, M12 (sin aprobación), M13 (Historial), M14 (sin bloques) y lo que viene después.

## Estado actual

**M11 (giro a gestor y visualizador), M12 (sin aprobación, eliminar tareas), M13 (Historial de tareas hechas) y M14 (retirada de los bloques) implementados.** Sus pruebas manuales están hechas (con el `claude` real por el MCP, el panel de IA y en Chrome). Los bloques (tareas en una rama con merge desde la UI) llegaron en M12 y se retiraron en M14: tenían sentido cuando Konsora lanzaba agentes. Del 2026-10-31 al 2026-11-08 (M0–M9) Konsora también lanzaba agentes (runner, worktrees, checks, cola); todo eso se retiró y solo queda en el historial de git. Hoy: `packages/core` tiene el esquema `konsora/5` (estados `proposed` = idea, `todo`, `doing`, `done`), la validación, el serializador canónico, el grafo, el historial (`completionLog`), la máquina de estados con operaciones semánticas (incluidos `delete`, `promote` y el modo plan), las migraciones v1/v2/v3/v4 → v5, el prompt de planificación (`buildPlanPrompt`, `PLAN_TOOLS`) y el store (`@konsora/core/store`, solo Node). `packages/cli` tiene la CLI `konsora` (init con la integración de Claude Code, lectura, comandos de agente, `migrate`, `archive`, `skill`, `plan`, `ui`, `mcp`) y `konsora mcp`, el servidor MCP por stdio con las mismas operaciones y el modo plan (`KONSORA_PLAN=1`). `packages/daemon` es el daemon en loopback: proyectos, tablero, ops humanas, cambios externos, WebSocket `board.*` y `chat.updated`, y los chats del panel de IA (`claude -p` con el MCP en modo plan y solo lectura del código). `packages/web` tiene el sistema de diseño *Plano*, la lista de proyectos, el tablero, el grafo, el Historial, la selección compartida (pasar a Por hacer, eliminar), el panel de tarea (resumen de cierre, acciones, edición), la creación de tareas, el panel de IA, las plantillas y el modo solo lectura. Las tareas están en el backlog (consulta `npm run konsora -- status`).

El v0 que desarrolló Codex (Tauri + sidecar Python, MVP de "copiar prompt"), con su código y sus docs, solo existe en la etiqueta git `legacy-v0`. No lo restaures ni lo tomes como referencia, salvo para la migración v1 (`konsora migrate`).

El backlog se gestiona con la CLI del propio repo (`npm run konsora -- …`, con `--as claude` o `KONSORA_AGENT`), siguiendo la skill `.claude/skills/konsora/SKILL.md`. Nunca edites `.konsora/tasks.json` a mano.

## Estructura

```
packages/core     esquema v4, máquina de estados, grafo, serializador canónico, migraciones, store
packages/cli      binario `konsora` + `konsora mcp`
packages/daemon   servidor loopback (HTTP + WS) y chats del panel de IA
packages/web      UI React
schema/           tasks.v5.schema.json generado desde core
```

Regla de capas: `web → daemon → core` y `cli → core` (y `cli → daemon` solo para `konsora ui`). **Ninguna regla de negocio fuera de `core`.**

## Comandos

```bash
npm ci
npm run check                  # lint + typecheck + tests, en todos los paquetes
npm run lint                   # biome check
npm run typecheck              # tsc --noEmit de los paquetes
npm run format                 # aplica el formato y las correcciones seguras de Biome
npm test -- packages/core      # tests de un paquete
npm run schema                 # regenera schema/tasks.v5.schema.json
npm run install:global         # enlaza el comando `konsora` global (npm link)
```

Usa siempre `npm run` o `npm test` (no `npx`) para ejecutar herramientas del proyecto.

Requisitos: Node ≥ 22.18 (ejecuta `.ts` directamente con *type stripping*, sin paso de build) y, para el panel de IA y `konsora plan`, `claude` instalado y autenticado.

Los imports relativos llevan la extensión `.ts`, y solo se admite sintaxis TS borrable (`erasableSyntaxOnly`: sin `enum`, `namespace` ni parameter properties). Biome no formatea `.konsora/`, porque ese archivo lo escribe el serializador canónico de `core`.

## Forma de trabajar

1. **El backlog es `.konsora/tasks.json`** (v5 desde M14). Trabaja una tarea a la vez, en orden de `rank` y respetando las dependencias. Una tarea pendiente no autoriza implementarla: hazlo solo si te lo piden. No adelantes funciones de hitos posteriores.
2. **"Hecho" = criterio verificable.** Cumple los `acceptance` de la tarea (o el ✅ del hito en `roadmap.md`), ejecuta las comprobaciones y anota en el commit qué ejecutaste y con qué resultado. Si no puedes verificar algo esencial, dilo y no lo des por hecho.
3. **Tus permisos sobre el plan son los de un agente.** Puedes crear tareas, empezar, anotar, preguntar y terminar con resumen (`finish` deja la tarea en `done`). Termina una tarea solo cuando cumpla sus criterios y lo hayas verificado. **No reabras tareas**: esa acción es humana.
4. Cambios mínimos y tipados, con errores controlados. Ajusta las pruebas afectadas. Antes de añadir una dependencia que no esté en la tabla de `arquitectura.md`, justifícala.
5. **Commits locales pequeños**, en inglés y con Conventional Commits (`feat(core): …`). **Nunca hagas push** sin aprobación explícita.
6. Pregunta antes de tomar una decisión de producto relevante, hacer una acción destructiva no pedida, gastar dinero o necesitar credenciales.
7. Al terminar, resume: cambios, comprobaciones y resultado, limitaciones y siguiente tarea.

## Convenciones

- **Idioma**: el código, los identificadores, los commits y los mensajes de CLI y MCP van en inglés. Los docs y la UI van en español, con la UI pasando por i18n y sin cadenas incrustadas en los componentes.
- TypeScript estricto, ESM, sin `any` implícito. Valida en los bordes (HTTP, MCP, ficheros) con los esquemas zod de `core`.
- Los errores para el usuario son accionables y no filtran rutas privadas, tokens ni el contenido de prompts.

## Reglas de producto (no negociables)

- **Abrir o vincular una carpeta no escribe nada.** `init`, `migrate` y cualquier edición del plan son acciones explícitas.
- **Un archivo de tareas inválido nunca se sobrescribe**: el proyecto pasa a solo lectura y se muestran los errores.
- **Los cambios externos se respetan.** Escribe con operaciones semánticas, lock y escritura atómica, sin pisar los cambios de otros.
- **Credenciales**: Konsora no lee, guarda ni transmite tokens ni claves. El panel de IA usa el CLI oficial de Claude Code con el login del usuario y nunca recurre a APIs de pago por su cuenta.
- **No ejecuta agentes**: ni runs, ni worktrees, ni checks. El panel de IA solo planifica: su agente tiene el MCP de Konsora en modo plan y, de Claude Code, solo herramientas de lectura del código (nada que escriba, ejecute comandos o cree worktrees), y nunca flags `--dangerously-*`.
- **Git**: Konsora no ejecuta git: ni ramas, ni merges, ni commits, ni push. El plan se versiona con el código como cualquier otro fichero.
- El daemon escucha solo en loopback, con token y validación de Host y Origin.
- Fuera de alcance: ejecutar u orquestar agentes, chat de propósito general, debates entre modelos, gestión de cuentas, nube y distribución pública. Ver los no-objetivos en `vision.md`.
