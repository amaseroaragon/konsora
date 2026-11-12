# Arquitectura

Konsora es un gestor y visualizador de tareas (ver [visión](vision.md)). La etapa en la que también lanzaba agentes (M6–M9: runner, worktrees, checks, cola) se retiró en M11 y solo queda en el historial de git. El v0 está en la etiqueta `legacy-v0`.

## 1. Vista general

```
                ┌──────────────────────── navegador ───────────────────────────┐
                │ web: proyectos · tablero · grafo · historial · panel IA      │
                └───────────────▲──────────────────────────┬──────────────────┘
                     WebSocket  │ board.* · chat.updated    │ HTTP + token
                ┌───────────────┴──────────────────────────▼──────────────────┐
                │ daemon (loopback, uno por usuario, varios proyectos)         │
                │   watcher · cambios externos · chats de IA                   │
                └───────┬─────────────────────────────────┬──────────────────┘
                        │ core                            │ spawn (panel IA)
        ┌───────────────▼─────┐                     ┌─────▼──────────────────┐
        │ .konsora/tasks.json │                     │ claude -p (plan mode)  │
        └───────────▲─────────┘                     └──────────┬─────────────┘
                    │                                    MCP ───┘
                    │ core
        ┌───────────┴──────────────────┐
        │ konsora (CLI) · konsora mcp  │  ← tus sesiones de Claude Code (skill + .mcp.json)
        └──────────────────────────────┘
```

Principio rector: **un solo núcleo** (`packages/core`) contiene el esquema, la máquina de estados, el grafo y el store. La CLI, el MCP, el daemon y la UI lo importan, así que ninguna regla se implementa dos veces.

## 2. Monorepo

TypeScript estricto, Node 22 LTS, npm workspaces y ESM.

```
packages/
  core/      schema (zod) → JSON Schema · máquina de estados · grafo (deps, blocked, ciclos, orden topológico)
             serializador canónico · store (lock, hash, escritura atómica, watcher) · ops semánticas
             historial · migraciones v1/v2/v3/v4 → v5 · prompt de planificación
  cli/       binario `konsora` (commander) · `konsora mcp` (servidor MCP stdio) · init/skill/plan/ui
  daemon/    Hono (HTTP) + ws · registro de proyectos · cambios externos · chats del panel IA
  web/       React + Vite + TanStack Query · @xyflow/react + elkjs · dnd-kit
schema/      tasks.v5.schema.json (generado desde core)
docs/
```

Dependencias permitidas entre capas: `web → (HTTP/WS) → daemon → core` y `cli → core`, más `cli → daemon` solo para que `konsora ui` localice y arranque el daemon, que además sirve la UI compilada fuera de `/api`. `core` no depende de nada del proyecto ni de procesos externos: el git del merge vive en el daemon, y la CLI solo lee la rama actual para la base por defecto de un bloque.

### Dependencias y por qué

| Paquete | Uso | Alternativa descartada |
|---|---|---|
| zod | Esquema y validación en tiempo de ejecución; genera JSON Schema | ajv + tipos escritos a mano (duplicación) |
| commander | CLI | yargs (más pesado), parseo propio |
| @modelcontextprotocol/sdk | Servidor MCP oficial | implementar JSON-RPC a mano |
| hono + ws | Daemon HTTP pequeño y tipado, con WebSocket | Fastify (más grande), Express (sin tipos) |
| react, vite, @tanstack/react-query | UI y caché de servidor | Svelte (el autor ya usa React) |
| @xyflow/react + elkjs | Grafo con disposición automática por capas | Cytoscape (menos idiomático en React), dagre (sin mantenimiento) |
| dnd-kit | Arrastrar y soltar accesible | react-beautiful-dnd (abandonado) |
| vitest + fast-check | Tests y tests de propiedades | jest |
| @biomejs/biome | Lint y formato en una sola herramienta | eslint + prettier |

Cualquier dependencia nueva fuera de esta lista se justifica en el commit que la añade.

## 3. Instalación en un proyecto

- **CLI global**: `npm run install:global` hace `npm link` del paquete `packages/cli` de este checkout, de modo que `konsora` queda en el PATH y se actualiza con `git pull` (Node ejecuta el TypeScript directamente, sin build). No hay distribución en npm.
- **`konsora init`** (acción explícita): crea `.konsora/tasks.json` (`konsora/5`, con un grupo) y, salvo `--no-claude`, la integración con Claude Code: la skill `.claude/skills/konsora/SKILL.md` (si no existe) y la entrada `konsora` en `.mcp.json` (`{"command": "konsora", "args": ["mcp"], "env": {"KONSORA_AGENT": "claude"}}`). En un `.mcp.json` que ya exista solo añade esa entrada, y si el archivo no es un objeto JSON válido lo deja intacto y falla con un error. Nunca escribe en `~/.claude`. `konsora skill` repite solo la integración.
- **`konsora mcp --print-config claude`** imprime, sin escribir nada, un snippet con rutas absolutas a este checkout, para sesiones sin la CLI global.

## 4. Datos y rutas

| Ruta | Contenido |
|---|---|
| `<proyecto>/.konsora/tasks.json` | Plan (ver [esquema](esquema-tareas.md)) |
| `<proyecto>/.claude/skills/konsora/SKILL.md`, `<proyecto>/.mcp.json` | Integración con Claude Code |
| `~/.local/share/konsora/projects.json` | Registro de proyectos: `{id, name, path}`. Un "proyecto" de Konsora es solo un enlace a una carpeta. |
| `~/.local/share/konsora/projects/<id>/approvals.jsonl` | Registro de transiciones humanas (solo lo escribe el daemon) |
| `~/.local/share/konsora/projects/<id>/snapshot.json`, `external.json` | Última versión de confianza del plan y cambios externos sin aprobar pendientes (confirmar o revertir) |
| `~/.local/share/konsora/daemon.json` | `{url, token, pid, code}` con permisos 0600 |
| `~/.local/state/konsora/logs/` | Logs del daemon (sin secretos ni contenido de prompts) |

Reglas: **abrir o vincular no escribe nada** (`konsora init` y `migrate` son acciones explícitas); la ruta del proyecto se canonicaliza con `realpath`; se rechaza un `.konsora` que sea un symlink o que apunte fuera del proyecto; el registro se crea con `umask 077`.

## 5. Daemon

- Escucha solo en `127.0.0.1`, en un puerto libre, con un token aleatorio de 256 bits guardado en `daemon.json`. `konsora ui` arranca el daemon si no está en marcha (y lo reinicia si ejecuta código más antiguo que el checkout) y abre `http://127.0.0.1:<port>/#token=…`; la UI pasa el token del fragmento a `sessionStorage`, de modo que nunca aparece en logs ni en el historial del servidor.
- Valida `Host` y `Origin` en cada petición (protección contra DNS rebinding) y exige `Authorization: Bearer` en HTTP y en el primer mensaje del WS. CORS no es autenticación.
- **HTTP**: `GET /api/health`; proyectos (`GET`/`POST /api/projects`, `DELETE /api/projects/:id`); lecturas (`GET /projects/:id/board`, `/projects/:id/tasks/:task`); operaciones semánticas (`POST /projects/:id/ops`), que corren como `human`; y cambios externos (`GET /projects/:id/external`, `POST …/external/:task/confirm` y `…/revert`). Las ops humanas (`reopen`, `answer`, `set-templates`, cambiar trabajo hecho y borrar trabajo empezado) **solo** existen aquí. El daemon no ejecuta git.
- **Panel de IA** (`ChatManager`, `packages/daemon/src/chat.ts`): un chat por proyecto, en memoria. `GET /projects/:id/chat` devuelve `{chat: {messages, busy}}`; `POST /projects/:id/chat` `{text}` lanza un turno (`409 busy` si hay otro en marcha) y responde `202`; `POST …/chat/stop` lo detiene; `DELETE …/chat` lo detiene y olvida la conversación. Cada turno es un proceso `claude -p <prompt> --output-format stream-json --verbose --strict-mcp-config --mcp-config <json> --allowedTools=<PLAN_TOOLS>` en la carpeta del proyecto, con `--resume <session>` a partir del segundo. El primer turno usa el prompt de entrevista de `core` (`buildPlanPrompt` con el mensaje como objetivo). El único servidor MCP es el de este checkout (`mcpCommand()`), con `KONSORA_PLAN=1`, así que el agente solo puede leer el plan y crear, revisar o eliminar tareas que nadie ha empezado. De las herramientas propias de Claude Code solo tiene las que leen el código (`--tools=Glob,Grep,Read,ToolSearch`, `PLAN_BUILTIN_TOOLS` de `core`), y además se fija `--permission-mode default` y se niegan `Bash`, `Edit`, `NotebookEdit` y `Write` (`PLAN_DENIED_TOOLS`), de modo que ni el modo de permisos por defecto del usuario ni las reglas `allow` del proyecto le dejan cambiar ficheros, tampoco a través de subagentes. Nunca se pasan flags `--dangerously-*`, y Claude Code usa el login del usuario. Los textos del agente, sus llamadas a herramientas (resumidas) y los errores se añaden como mensajes y se publican como `chat.updated` `{chat}`. Las tareas que crea llegan al tablero por el watcher, como cualquier escritura.
- **WS**: `board.changed` (hash nuevo y diff por tarea), `board.invalid` (errores), `board.missing` y `chat.updated`.
- El watcher (`fs.watch` sobre `.konsora/` con un debounce de 100 ms y comparación de hash) sustituye al polling.

## 6. Canal agente ↔ Konsora

La CLI y el MCP exponen las mismas operaciones de agente sobre `core`, con salida `--json` en la CLI:

| Lectura | Escritura (agente) |
|---|---|
| `status`, `list [--state --group --ready --blocked --waiting]`, `show <id>`, `ready`, `blocked`, `check` | `propose [--idea]`, `batch` (JSON por stdin, todo o nada, con `idea: true` por tarea), `edit` / `undepend` (tareas no hechas), `depend`, `delete` (lo que nadie empezó), `promote`, `start`, `pause`, `note`, `ask`, `finish --summary` |

Más comandos de la CLI: `init`, `skill`, `migrate`, `plan`, `ui` y `mcp`. Las acciones humanas **no** están en la CLI ni en el MCP.

- **Sesión de planificación**: `konsora plan [objetivo] [--model …]` abre en la terminal una sesión interactiva de Claude Code con el prompt de entrevista de `core` y solo el MCP de Konsora con `KONSORA_PLAN=1` (`--strict-mcp-config --mcp-config <json> --allowedTools=<PLAN_TOOLS>`). El panel de IA hace lo mismo en modo `-p`. En ese modo la regla de `core` (`OpContext.plan`) solo deja crear tareas, revisar, enlazar, pasar a `todo` o borrar las que nadie empezó; el resto da `out_of_scope`.
- **Sesión normal**: el agente usa `konsora` o el MCP de `.mcp.json`, que funcionan sin daemon, y sigue la skill.
- Los mensajes de la CLI y el MCP están en inglés y los errores son accionables: `Error: BE-03 is blocked by BE-02. Pick another task with konsora ready…`.

## 7. UI

- **Proyectos**: lista de proyectos vinculados con el estado de su plan.
- **Tablero**: columnas por estado (Ideas, Por hacer, En curso, Hecho), *swimlanes* opcionales por grupo y arrastrar y soltar con validación de transición. Lo prohibido no se puede soltar y explica por qué. Indicadores de `blocked`, `waiting` y "cambio externo sin aprobar".
- **Grafo**: dependencias como DAG con disposición ELK en capas (en un worker), coloreado por estado y navegable con teclado. Seleccionar un nodo con sus dependencias selecciona ese subgrafo.
- **Filtro**: una barra compartida por el tablero y el grafo con texto libre (id, título y descripción), grupo, etiqueta y quién creó o cerró la tarea. La regla está en `core` (`taskMatches`), y el filtro va en la URL (`?q=…&group=…&label=…&by=…`), así que sobrevive a una recarga y se puede enlazar. Solo acota lo que se ve: muestra cuántas tareas oculta y un botón lo quita.
- **Selección**: compartida entre tablero y grafo; la barra ofrece **Pasar a Por hacer** las ideas seleccionadas y **Eliminar** (con confirmación).
- **Panel de tarea**: en `done`, el resumen de cierre del agente destacado; acciones según el estado (pasar a Por hacer, responder, reabrir, eliminar con confirmación que nombra a las dependientes); descripción en markdown seguro; criterios; dependencias navegables; notas como línea de tiempo; edición del contenido y de las dependencias.
- **Historial** (`?view=history`): las tareas hechas, de lo más reciente a lo más antiguo y agrupados por día local (Hoy, Ayer o la fecha), con la hora, quién la terminó y la primera línea del resumen. Sale de `completionLog` de `core`: la fecha de cierre de una tarea es la de su última nota `summary` (la que escribe `finish`) o, sin ella, su `updated_at`. Sigue al tablero en vivo, y cada tarea enlaza a su panel (`?view=history&task=ID`). Es la forma de ver qué han cerrado los agentes ahora que no hay aprobación.
- **Panel de IA**: el chat de planificación del daemon (§5), en el lateral cuando no hay una tarea abierta.
- **Ajustes**: plantillas de tarea del proyecto.
- **Solo lectura**: con un plan inválido, se muestran los errores y la última versión válida sin acciones.
- Modo claro y oscuro con el sistema de diseño *Plano*. Textos en español a través de una capa i18n, sin cadenas incrustadas en los componentes.

## 8. Calidad

- `npm run check` = Biome + `tsc --noEmit` + vitest en todos los paquetes.
- `core`: tests de propiedades (serialización, ciclos, transiciones por rol, escritores concurrentes en procesos reales).
- CLI y MCP: tests e2e sobre repos temporales, con el binario real por stdio.
- Panel de IA: tests con un `claude` falso que emite `stream-json`, sin gastar cuota. Una prueba manual con el CLI real, documentada en el commit.

## 9. Decisiones (ADR breves)

| # | Decisión | Alternativas descartadas y motivo |
|---|---|---|
| 1 | Reescribir desde cero (etiqueta `legacy-v0`) | Evolucionar el v0: su sidecar Python síncrono tras un proxy Rust no admite streaming |
| 2 | TypeScript en todo | Rust (más lento de iterar), Python (dos lenguajes y empaquetado del intérprete) |
| 3 | Web local servida por el daemon | Tauri o Electron (fricción de build; se descartó el escritorio en M11) |
| 4 | Plan en `tasks.json` dentro del repo | SQLite como fuente (no se puede editar a mano ni lo ven los agentes) |
| 5 | Operaciones semánticas con precondición por tarea | PUT del documento entero con ETag (Kanvas: conflicto de fichero completo) |
| 6 | Detectar transiciones externas con un registro de aprobaciones | Firma HMAC (v1: opaca y confusa), confiar en `--as` (Kanvas: falsificable) |
| 7 | Gestor y visualizador, sin ejecutar agentes (M11) | Seguir como lanzador: duplicaba lo que los agentes ya hacen bien (worktrees, permisos, reintentos) y concentraba casi todo el código y el mantenimiento |
| 8 | Panel de IA sobre `claude -p` con el login del usuario, el MCP en modo plan y solo lectura del código | API de Anthropic (coste aparte, credenciales), Agent SDK (más dependencias para lo mismo) |
| 9 | Integración solo con Claude Code (skill + `.mcp.json`) | Varios agentes desde el principio (más superficie sin uso real todavía) |
| 10 | Sin aprobación ni revisión por tarea (M12); el humano revisa lo cerrado en el Historial (M13) | Aprobar cada propuesta y revisar cada tarea (demasiada ceremonia para el uso real) |
| 11 | Sin bloques ni git en Konsora (M14): cada uno integra el código con su flujo de siempre | Bloques de tareas en una rama con merge desde la UI (M12): tenían sentido cuando Konsora lanzaba agentes, y ahora solo añadían ceremonia y una dependencia de git |
