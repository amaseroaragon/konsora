# Arquitectura

Estado: **diseño aprobado en Fase 0**. Las piezas se construyen por hitos (ver [roadmap](roadmap.md)). El v0 anterior solo existe en la etiqueta `legacy-v0`.

## 1. Vista general

```
                ┌──────────── navegador (M3) / ventana Tauri (M10) ────────────┐
                │  web: tablero · grafo · detalle · runs · revisión con diff   │
                └───────────────▲──────────────────────────┬──────────────────┘
                     WebSocket  │ eventos                   │ HTTP + token
                ┌───────────────┴──────────────────────────▼──────────────────┐
                │ daemon (loopback, uno por usuario, varios proyectos)         │
                │   store watcher · registro de aprobaciones · runner          │
                └───────┬──────────────────────┬───────────────────┬──────────┘
                        │ core                 │ spawn             │ git worktree
        ┌───────────────▼─────┐      ┌─────────▼────────┐   ┌──────▼──────────────┐
        │ .konsora/tasks.json │◀─────│ claude -p / codex│──▶│ worktree por run     │
        │ .konsora/runs/      │ MCP  │ app-server       │   │ rama konsora/<id>/…  │
        └───────────▲─────────┘      └──────────────────┘   └─────────────────────┘
                    │ core
        ┌───────────┴─────────┐
        │ konsora (CLI) · konsora mcp │  ← agentes en sesiones manuales y runs
        └─────────────────────┘
```

Principio rector: **un solo núcleo** (`packages/core`) contiene el esquema, la máquina de estados, el grafo y el store. La CLI, el MCP, el daemon y la UI lo importan, así que ninguna regla se implementa dos veces. Kanvas, en cambio, duplica su lógica entre Python y su HTML.

## 2. Monorepo

TypeScript estricto, Node 22 LTS, npm workspaces y ESM.

```
packages/
  core/      schema (zod) → JSON Schema · state machine · graph (deps, blocked, ciclos, orden topológico)
             canonical serializer · store (lock, hash, atomic write, watcher) · ops semánticas
  runner/    AgentAdapter + adaptadores claude/codex · worktrees · scheduler · checks · integración git
  cli/       binario `konsora` (commander) · `konsora mcp` (servidor MCP stdio)
  daemon/    Hono (HTTP) + ws · registro de proyectos · aprobaciones · supervisa el runner
  web/       React + Vite + TanStack Query · @xyflow/react + elkjs · dnd-kit
apps/
  desktop/   Tauri (M10): arranca el daemon y carga la UI
schema/      tasks.v2.schema.json (generado desde core)
docs/
```

Dependencias permitidas en las capas: `web → (HTTP/WS) → daemon → runner → core`, y `cli → runner, core` (más `cli → daemon` solo para que `konsora ui` localice y arranque el daemon, que además sirve la UI compilada fuera de `/api`). `core` no depende de nada del proyecto ni de procesos externos, salvo `git` (para el hash de HEAD), y lo hace a través de una interfaz que se puede sustituir en tests.

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

Cualquier dependencia nueva fuera de esta lista se justifica en el PR o commit que la añade.

## 3. Datos y rutas

| Ruta | Contenido |
|---|---|
| `<proyecto>/.konsora/tasks.json` | Plan (ver [esquema](esquema-tareas.md)) |
| `<proyecto>/.konsora/runs/` | Runs (en `.gitignore`) |
| `~/.local/share/konsora/projects.json` | Registro de proyectos: `{id, name, path}`. Un "proyecto" de Konsora es solo un enlace a una carpeta. |
| `~/.local/share/konsora/projects/<id>/approvals.jsonl` | Registro de transiciones humanas (solo lo escribe el daemon) |
| `~/.local/share/konsora/projects/<id>/snapshot.json`, `external.json` | Última versión de confianza del plan y cambios externos sin aprobar pendientes (confirmar o revertir) |
| `~/.local/share/konsora/worktrees/<id>/…` | Worktrees de los runs, fuera del repo para no confundir a herramientas que recorren el árbol |
| `~/.local/share/konsora/daemon.json` | `{url, token, pid}` con permisos 0600 |
| `~/.local/state/konsora/logs/` | Logs del daemon (sin secretos ni contenido de prompts) |

Se prescinde de SQLite: el registro es diminuto y los runs son ficheros que se añaden o se reescriben de forma atómica. Si algún día hace falta buscar en miles de runs, se añadirá un índice reconstruible a partir de los ficheros, que nunca será la fuente de verdad.

Reglas: **abrir o vincular no escribe nada** (`konsora init` y `migrate` son acciones explícitas); la ruta del proyecto se canonicaliza con `realpath`; se rechaza un `.konsora` que sea un symlink o que apunte fuera del proyecto; el registro y los worktrees se crean con `umask 077`.

## 4. Daemon

- Escucha solo en `127.0.0.1`, en un puerto libre, con un token aleatorio de 256 bits guardado en `daemon.json`. `konsora ui` arranca el daemon si no está en marcha y abre `http://127.0.0.1:<port>/#token=…`; la UI pasa el token del fragmento a `sessionStorage`, de modo que nunca aparece en logs ni en el historial del servidor.
- Valida `Host` y `Origin` en cada petición (protección contra DNS rebinding) y exige `Authorization: Bearer` en HTTP y en el primer mensaje del WS. CORS no es autenticación.
- **HTTP**: lecturas (`GET /projects/:id/board`, `/runs/:id`, `/runs/:id/diff`) y operaciones semánticas (`POST /projects/:id/ops` con `{op, task, base_hash, …}`). Las ops humanas (`approve`, `accept`, `send-back`, `reopen`, `yolo`, editar trabajo aprobado) **solo** existen aquí.
- **Aprobaciones de un run**: el runner registra cada run en el daemon y recibe un token propio del run, que llega al MCP en `KONSORA_RUN_TOKEN` junto con `KONSORA_DAEMON_URL`. Ese token solo sirve para `POST /api/runs/:run/permissions`: crea la aprobación pendiente y espera la decisión (por defecto, 300 s; `KONSORA_PERMISSION_TIMEOUT_S`). No sirve para decidir ni para ninguna otra ruta, y la ruta rechaza peticiones con `Origin`. El humano las ve en `GET /api/approvals` y decide con `POST /api/runs/:run/permissions/:id` `{decision: allow|deny, message?}`, usando su token. Las aprobaciones viven en memoria: si el daemon se detiene, o el run termina o vence el plazo, la respuesta es `deny`. El MCP nunca permite por defecto.
- **Runs**: `POST /projects/:id/runs` `{task, agent?}` lanza un run (solo lo que el humano selecciona) y respeta los mismos límites que la cola, el global y el del proveedor del agente que usará (`fitsSlots` de `core`): si no cabe, responde `409 no_slots` sin crear nada y la UI ofrece **Encolar** con el mismo agente (DMN-11); con `{task, agents}` (de 2 a 3 agentes, RUN-28) lanza las variantes de la tarea, cada una en su worktree y su rama, con su prompt y sus checks, solo si caben todas a la vez en `max_parallel` (`409 no_slots` sin crear nada), y responde `{runs}`; `POST …/runs/:run/review` `{agent?}` lanza una revisión de un run `succeeded` y sin integrar cuya tarea está en `review` (con `agent`, o si no con `project.reviewer`; `409 not_reviewable` si no se puede), y con `project.reviewer.launch = auto` el daemon lanza una sola cuando un run lleva su tarea a `review` (no en las variantes, que esperan a que el humano elija); `POST …/runs/:run/choose` elige la variante ganadora (queda `pending`), descarta las demás y borra sus worktrees y ramas (sus runs y su `diff.patch` se conservan); `accept` integra después la ganadora y, sin elegir entre varias, responde `409 variant_not_chosen`; `GET /projects/:id/runs[?task=]`, `GET …/runs/:run`, `…/runs/:run/events`, `…/runs/:run/diff`, `…/runs/:run/checks` (`checks.json` validado con `ChecksFileSchema`: todos los intentos con el comando, el resultado y la cola de la salida de cada check; `null` si aún no se ejecutaron), `POST …/runs/:run/cancel`, `POST …/runs/:run/rebase` (pide al agente que rebase un run en `conflict`, ver §5 «Integrar»), `POST …/runs/:run/resume` (reanuda un run `interrupted`, ver §5 «Reiniciar el daemon»; `409 not_resumable` si no se puede) y `POST …/runs/:run/discard` (un run terminado y sin integrar: borra su worktree y su rama y deja `integration = discarded`; el run y su `diff.patch` se conservan). `GET /projects/:id/worktrees/orphans` lista, sin borrar nada, los worktrees y ramas `konsora/` que ningún run necesita. `accept` sobre una tarea cuyo último run está `succeeded` y sin integrar integra antes: comprueba la op en seco, integra (un commit) y después marca `done`; un conflicto devuelve `409 integration_conflict` con los ficheros y la tarea sigue en `review`. Después de `answer`, el daemon entrega la respuesta al run que la espera. Una aprobación pendiente mueve su run a `waiting_approval`. Al arrancar, los runs que estaban vivos pasan a `interrupted`. Los worktrees van en `<data>/worktrees/<project-id>/` y los archivos privados de cada run (la config MCP con su token) en `<data>/projects/<project-id>/runs/`.
- **Límites de uso**: `GET /api/limits[?refresh=1]` devuelve, por proveedor, sus ventanas de rate limit (`ProviderLimits` de `core`) sin lanzar ningún run ni gastar cuota, con su origen (`source`: `provider` si se leyeron directamente, `run` si las dio un run, `none` si no se sabe nada), su fecha (`at`), el run del que vienen y, si no hubo lectura directa, el motivo (`unavailable`). Gana el dato más reciente entre la lectura directa (`AgentAdapter.rateLimits()`, que se guarda 60 s y se comparte entre peticiones simultáneas) y lo que reportaron los runs: los eventos `usage` de los runs vivos según llegan y el `usage.rate_limits` de los `run.json` de los proyectos vinculados. Cualquier cambio se envía a todos los clientes autenticados del WebSocket como `limits.updated` `{limits}`, estén suscritos a un proyecto o no, porque describen la cuenta.
  - **Codex**: `account/rateLimits/read` de `app-server` (con `excludeResetCreditDetails`) en una sesión corta, sin hilo ni turno. Es una lectura del uso que el backend ya contó. Las ventanas se nombran igual que las de `account/rateLimits/updated`. Con el plan B (`exec`), la lectura falla y se explica.
  - **Claude Code** (investigado en DMN-06 con la 2.1.319): su `stream-json` solo da `rate_limit_event` dentro de un turno, y `--bare` no sirve, porque no lee el login de la suscripción. Pero `claude -p /usage --output-format json` es un comando local: responde con `num_turns: 0`, coste 0 y `local_command: "usage"`, y el texto trae `Current session: N% used · resets <fecha>` (→ `five_hour`) y `Current week (all models|<modelo>): N% used · resets <fecha>` (→ `seven_day` o `seven_day_<modelo>`). Konsora lo ejecuta con el entorno del usuario sin `KONSORA_*`, `TZ=UTC` (los reinicios salen en UTC), `--no-session-persistence` (no deja sesión en su historial), `--strict-mcp-config` (sin servidores MCP) y en la carpeta temporal del sistema, nunca en el proyecto, con un timeout de 20 s. Konsora no lee credenciales: es el propio Claude Code quien usa su login. Si la respuesta no es el comando local (una versión en la que `/usage` llegaría al modelo y gastaría cuota), el adaptador lo rechaza y no lo vuelve a intentar mientras viva el daemon. Si el texto no trae ventanas (por ejemplo, con una API key), se usa lo último que dieron los runs y se explica el motivo.
- **Agentes**: `GET /api/agents` devuelve, por proveedor con adaptador (Claude y Codex), si está instalado, su versión (y la de los tipos, con `version_matches`), un `warning`, el `transport` (Codex: `app-server` o `exec`), sus modelos con los esfuerzos de cada uno, `open_models` (Claude Code acepta también ids completos que no lista), sus perfiles de permisos y, si no pudo listar los modelos, `models_error`. Se guarda 30 s. Al lanzar un run, el agente que se va a usar (el pedido, el de la tarea o el del proyecto, `runAgentFor`) se valida con `checkAgent` de `core` contra ese catálogo: un proveedor no instalado, un perfil, un modelo o un esfuerzo que el adaptador no declara dan un 422 `invalid_agent` con el motivo y lo que hay disponible, y no se crea el run.
- **Cola** (M9, `Scheduler` en `packages/daemon/src/queue.ts`): `GET /projects/:id/queue` devuelve `{queue, status, limits, usage}` (la cola, el motivo de espera de cada entrada según `queueStatus`, los límites y los huecos ocupados en todo el daemon). `POST /projects/:id/queue` `{items: [{task, agent?}]}` encola la selección del humano al final (el agente se resuelve con `runAgentFor` al encolar; `409 not_approved` para una propuesta). `DELETE /projects/:id/queue/:task` quita una entrada, `POST …/queue/clear` las quita todas (los runs ya lanzados siguen), y `POST …/queue/pause` y `…/queue/resume` la detienen o la reanudan. `GET /settings/parallel` y `PUT /settings/parallel` `{max_parallel, per_provider?}` leen y cambian los límites en `settings.json` (`422 invalid_settings` fuera de 1..16). El scheduler ejecuta un *tick* serializado cuando se cierra un run, cambia el plan (un watcher por proyecto con cola no vacía), cambian la cola o los límites o se reanuda: aplica `queueExits`, lanza lo que dice `nextRuns` contando los runs de todos los proyectos, y marca cada entrada con su run. Un lanzamiento que falla saca la entrada con `launch_failed` y su motivo; nunca se reintenta solo. Al arrancar, cada cola no vacía se carga en pausa.
- **WS**: `board.changed` (hash nuevo y diff por tarea), `board.invalid` (errores), `run.event` (cada línea de `events.jsonl`, en el mismo orden, incluidos el inicio y el fin de cada check, `setup` y `retry`), `run.state` (cada cambio de `run.json`, como `checking ↔ running` en un reintento), `permission.requested` y `permission.resolved`, `question.asked`, `queue.updated` `{queue}` (cada cambio de la cola), `queue.launched` `{task, run}` y `queue.exited` `{exits: [{task, reason, run?, message?}]}`, y `limits.updated` y `queue.limits` `{limits}` a todos los clientes autenticados.
- El watcher (`fs.watch` sobre `.konsora/` con un debounce de 100 ms y comparación de hash) sustituye al polling del v1.

## 5. Capa de ejecución (runner)

### Interfaz de adaptador

```ts
interface AgentAdapter {
  id: "claude" | "codex";
  detect(): Promise<{ installed: boolean; version?: string; authenticated?: boolean | "unknown" }>;
  models(): Promise<ModelInfo[]>;                  // {id, label, efforts[]}
  rateLimits?(): Promise<RateLimitWindow[]>;       // sin run ni cuota; ver «Límites de uso» (§4)
  start(spec: RunSpec, io: RunIO): RunHandle;      // spec: prompt, cwd, agent, permissions, mcp
}
interface RunHandle {
  events: AsyncIterable<RunEvent>;                 // normalizados; siempre acaba con un único `finished`
  exited: Promise<RunExit>;                        // {code, signal} del proceso
  send(text: string): void;                        // otro mensaje del usuario en la misma sesión (respuestas a `ask`)
  endInput(): void;                                // cierra la entrada: el agente termina tras el turno actual
  answerPermission?(id: string, decision: { behavior: "allow" | "deny"; message?: string }): void; // Codex
  interrupt(): Promise<void>;                      // termina el turno de forma ordenada
  kill(): Promise<void>;                           // SIGTERM → 5 s → SIGKILL al grupo de procesos
  sessionId(): string | undefined;                 // para reanudar
}
type RunEvent =
  | { t: "started"; session?: string; model: string }
  | { t: "message"; text: string; final: boolean }
  | { t: "tool"; phase: "start" | "end"; name: string; summary: string; ok?: boolean }
  | { t: "file"; path: string; change: "add" | "modify" | "delete" }
  | { t: "permission"; id: string; tool: string; detail: string; input?: Record<string, unknown> }  // Codex; respuesta con answerPermission
  | { t: "usage"; input_tokens?: number; output_tokens?: number;          // entrada con la caché incluida
      cache_read_tokens?: number; cache_write_tokens?: number;            // parte de la entrada
      reasoning_tokens?: number; cost_usd?: number; rate_limits?: RateLimits }
  | { t: "error"; message: string; retryable: boolean }
  | { t: "finished"; ok: boolean; summary?: string };
type RateLimits = {
  status: string; window?: string; resets_at?: number;                   // la ventana que limita ahora
  windows?: { window: string; status?: string; utilization?: number; resets_at?: number }[];
}
```

El supervisor suma los `usage` de todos los turnos en el `usage` de `run.json` (el desglose solo aparece si el proveedor lo dio) y guarda en `usage.rate_limits` la última foto de cada ventana, con el reinicio como fecha UTC. Los rate limits describen la cuenta, no el run.

### Claude Code

Se hace un spawn directo del `claude` instalado por el usuario, sin el Agent SDK (es el mismo binario y así hay una dependencia menos):

```
claude -p --output-format stream-json --input-format stream-json --verbose
       --model <m> --effort <e>
       --permission-mode acceptEdits --allowedTools <perfil>
       --strict-mcp-config --mcp-config <json konsora en modo run> --permission-prompt-tool mcp__konsora__permission
       [--resume <session_id>]
```

- Desde stdin se envía el prompt del run como mensaje `user` en stream-json. Mantener stdin abierto permite enviar respuestas a `ask` en el mismo proceso.
- `claude` sigue vivo mientras stdin esté abierto, aunque el turno haya terminado (comprobado con 2.1.316), así que el runner cierra la entrada (`endInput`) cuando ya no espera más turnos.
- `system/init` → `started`; `assistant` → `message`/`tool` (el último texto antes de `result` va con `final: true`); `user` con `tool_result` → `tool` de fin y `file` para Write/Edit; `rate_limit_event` → `usage.rate_limits`; `result` → `usage` (más `error` si el turno falló). `finished` se emite al salir el proceso: `ok` exige salida 0, un último `result` correcto y ninguna línea malformada. Las grabaciones reales de `packages/runner/test/fixtures/claude/` fijan este mapeo.
- **Uso y límites** (comprobado con 2.1.316, en las grabaciones de `fixtures/claude/`):
  - `result.usage` da, por turno, `input_tokens` (sin caché), `cache_read_input_tokens`, `cache_creation_input_tokens` (con el detalle de 5 min y 1 h), `output_tokens` y `output_tokens_details.thinking_tokens`. Konsora guarda la entrada total (las tres sumadas), la caché leída y escrita aparte, la salida y el razonamiento.
  - `result.total_cost_usd` es el coste a precio de lista (`costBasis: "list"`): con suscripción es una estimación, no lo que se cobra. Se guarda como `cost_usd`.
  - `rate_limit_event.rate_limit_info` da el estado y el reinicio de la ventana que limita ahora (`rateLimitType`, `resetsAt` en segundos Unix) y, en `unifiedWindows`, cada ventana (`five_hour`, `seven_day`) con su `utilization` (fracción usada), `status` y `resetsAt`. Solo llega cuando Claude Code lo emite (no en cada turno ni si falla antes de llamar a la API).
  - **No se guarda**: `modelUsage` (repite lo mismo por modelo, con `contextWindow` y `maxOutputTokens`, que son datos del modelo y no del run), `iterations`, `server_tool_use`, `service_tier`, `inference_geo` ni los campos de *overage* (`overageStatus`, `isUsingOverage`), que dependen del plan y de la organización.
  - **No lo da**: el saldo ni el límite absoluto de tokens de cada ventana (solo la fracción), el uso de otras sesiones por separado, ni el coste real facturado.
- La configuración MCP (que lleva el token del run) es un archivo 0600 en una carpeta privada del run fuera del proyecto, y se borra al terminar. Con `--strict-mcp-config` el agente solo carga el MCP de Konsora en modo run, no otros servidores del usuario o del proyecto (como un `konsora` en modo manual en `.mcp.json`).
- El perfil `default` es `acceptEdits` y `--allowedTools` con `Read`, `Glob`, `Grep`, `Edit`, `Write`, `NotebookEdit`, `TodoWrite`, `mcp__konsora`, `npm run/test/ci`, `git status/diff/log/add/commit` y los comandos exactos de `checks` (salvo los que contienen `,`, `(` o `)`, que no caben en una regla y piden permiso).
- Las aprobaciones que no cubre `--allowedTools` llegan a la herramienta MCP `permission` de Konsora, que las reenvía al daemon → UI → el humano decide.
- Los comandos del perfil `default` están en `core` (`DEFAULT_PROFILE_COMMANDS`): el adaptador construye con ellos `--allowedTools` y el prompt del run (y el de rebase) los cita. Desde M9 (RUN-26), ese prompt pide crear, cambiar y leer ficheros con las herramientas de edición y lectura del agente y ejecutar cada comando por separado, sin `&&`, `;` ni tuberías. Así, una cadena YOLO no se para en aprobaciones que nadie está mirando: en la verificación real de M9, los comandos encadenados (`mkdir … && printf … && git commit …`) esperaban al humano. Los permisos no se amplían. Una tarea cuyo run espera una aprobación se marca en su tarjeta del tablero («Espera tu aprobación») y en la vista `#/cola`, con enlace a la tarea, donde está la aprobación.
- Cancelar: SIGINT (termina el turno y se conserva la sesión) → si no responde, `kill()`.
- **Sin `--bare`**: `--bare` no usa el login de la suscripción. En su lugar, el worktree es una copia del repo, así que los hooks y el MCP del proyecto son los mismos que el usuario ya ejecuta.

### Codex

`codex app-server` por stdio (JSON-RPC sin cabecera `jsonrpc`, NDJSON). Los tipos se generan con `codex app-server generate-ts` para la versión instalada y se guardan en `packages/runner/src/codex/protocol/` (`npm run codex:types`, que puede usar otro binario con `CODEX_BIN`):

- **Solo se guarda lo que se usa**: el cierre transitivo de las cuatro uniones del protocolo (`ClientRequest`, `ClientNotification`, `ServerRequest`, `ServerNotification`) más las respuestas que lee el adaptador (la lista `ROOTS` de `packages/runner/scripts/codex-protocol.ts`). Con codex-cli 0.166.0 son 470 archivos (~280 KB) de los ~760 (3,2 MB) que genera. Si el adaptador necesita otra respuesta, se añade a `ROOTS` y se regenera.
- ts-rs escribe `import type … from "./X"`, y con `nodenext` + `allowImportingTsExtensions` un import relativo necesita su extensión, así que el script añade `.ts`. Los `index.ts` generados reexportan todo, así que se sustituyen por índices de lo guardado (`v2` y `serde_json` como espacios de nombres). `version.ts` guarda `CODEX_PROTOCOL_VERSION`.
- Sin la variante `--experimental`. La salida es determinista y Biome no formatea esa carpeta. Un test comprueba que todos sus imports resuelven dentro de ella.
- `detectCodex()` compara `codex --version` con `CODEX_PROTOCOL_VERSION` y devuelve `expected_version`, `version_matches` y, si no coinciden, un `warning`. Nunca bloquea.

El adaptador (`packages/runner/src/codex/adapter.ts`), comprobado con codex-cli 0.166.0 en las grabaciones de `packages/runner/test/fixtures/codex/`:

- Run: `codex app-server` en el worktree → `initialize` (con `clientInfo.name = "konsora"`) → `initialized` → `thread/start {model, cwd: worktree, sandbox: workspace-write, approvalPolicy: on-request, config: {mcp_servers: {konsora: {command, args, env}}}}` → `turn/start {input, effort, sandboxPolicy}`. Con `resume` se usa `thread/resume {threadId, …}` con los mismos parámetros. El id del hilo es el `session_id` del run.
- Las variables del run (con su token) solo viajan dentro de `config`, por stdin: no se escriben en disco ni van al entorno del hijo, que es el del usuario sin `KONSORA_*`. `workspace-write` deja la red desactivada (`networkAccess: false` en la respuesta).
- **Commits dentro del sandbox** (RUN-17): Codex protege el `.git` de las raíces escribibles, y un worktree enlazado guarda su índice, su HEAD y sus refs en el `.git` del repo principal, fuera del worktree. Sin más, `git commit` falla (`index.lock: Read-only file system`) y cada commit pide una aprobación. Por eso el runner calcula `RunSpec.gitWritePaths` (`runGitWritePaths` en `worktree.ts`) y Codex los añade a sus raíces escribibles: el gitdir del worktree (`.git/worktrees/<nombre>`), `.git/objects`, `.git/refs/heads/konsora/<tarea>/` y `.git/logs/refs/heads/konsora/<tarea>/` (la carpeta, porque git escribe `<ref>.lock` al lado). Solo se abren las que existen, y solo si el worktree está enlazado a una rama `konsora/<tarea>/<id>`; si no, el sandbox queda como estaba y Codex pide aprobación. Nunca se abren el checkout principal, `config`, `hooks`, `HEAD`, `packed-refs` ni otras ramas: el agente no puede mover la rama base, crear otras ramas, cambiar la configuración del repo ni instalar hooks (comprobado con `codex sandbox` y `/tmp` excluido). En app-server viaja como `sandboxPolicy {type: workspaceWrite, writableRoots, networkAccess: false}` en cada `turn/start`, que además fija la red desactivada aunque la configuración del usuario diga otra cosa; en `exec`, como `-c sandbox_workspace_write.writable_roots=[…]` y `-c sandbox_workspace_write.network_access=false`. Como el agente puede reescribir el `HEAD` o el `commondir` de su worktree, el supervisor comprueba antes de sus propios comandos git al cerrar el run (el commit de lo que quedó sin commitear, el diff), que se ejecutan fuera del sandbox, que el worktree sigue en `refs/heads/<rama del run>` y en el repo del proyecto. Si no, el run falla sin hacer commit: un `HEAD` reescrito a `main` no consigue que Konsora mueva `main`. **Riesgo aceptado**: con `objects/` escribible, el agente podría borrar o estropear objetos sueltos del repo. Git no los cambia nunca (se direccionan por contenido y nacen de solo lectura), y `git fsck` detectaría el daño, pero no hay forma de abrir solo «añadir objetos» con raíces escribibles por carpeta.
- `send()` lanza otro `turn/start` en el mismo hilo (si hay un turno en curso, espera a que acabe). `endInput()` cierra stdin cuando no queda turno, y entonces `app-server` termina. `interrupt()` es `turn/interrupt` con el turno en curso.
- Notificaciones: `item/started`/`item/completed` de `commandExecution` (`shell`, con el comando sin el envoltorio `/bin/bash -lc`), `fileChange` (`apply_patch`, más un `file` por cambio y rutas relativas al worktree), `mcpToolCall` (`mcp__<servidor>__<herramienta>`), `dynamicToolCall` y `webSearch` → `tool`. `agentMessage` → `message` (`final` si su `phase` es `final_answer`). `error` → `error` (`retryable` = `willRetry`), y `turn/completed` → `usage` + `turn_end` (con `error` si el turno falló y no se había notificado ya). `configWarning`/`warning` → `error` con el prefijo «Codex warning». `finished` exige salida 0, ninguna línea malformada, ninguna petición fallida y un último turno `completed`.
- **Uso**: `thread/tokenUsage/updated` da los totales acumulados del hilo (`inputTokens`, con `cachedInputTokens` y `cacheWriteInputTokens` incluidos, y `outputTokens` con `reasoningOutputTokens` incluidos). El `usage` de cada turno es lo que han crecido desde el turno anterior. **No da coste.**
- **Rate limits**: `account/rateLimits/updated` llega tras cada petición al modelo, con `primary` y `secondary` (`usedPercent`, `windowDurationMins`, `resetsAt` en segundos). Se nombran por su duración (300 min → `five_hour`, 10080 → `seven_day`, otra → `window_<min>m`) y solo se emite un evento cuando cambian (`resetsAt` varía un segundo entre envíos). El estado es `rejected` si viene `rateLimitReachedType`.
- `models()` abre otro `app-server`, hace `initialize` y `model/list` (paginado) y devuelve los modelos no ocultos con sus `supportedReasoningEfforts`. Codex admite esfuerzos que Konsora no tiene (`ultra`).
- **Aprobaciones**: las solicitudes del servidor (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval` y las antiguas `execCommandApproval`/`applyPatchApproval`) se convierten en `permission` (`shell` con `command`, `cwd` y `reason`, o `apply_patch` con `path`, `paths` y `reason`), con un id `codex-<n>`. El supervisor las pasa a `RunRegistry.requestPermission`, que en el daemon crea la aprobación pendiente de `Approvals`, la misma que usa el MCP de Claude: aparece en `GET /api/approvals` y en la UI, y el run pasa a `waiting_approval`. La decisión vuelve con `RunHandle.answerPermission` como resultado del JSON-RPC (`accept`/`decline`, o `approved`/`denied` en las antiguas) y queda en `events.jsonl` como `permission_decision`. Se deniega si el run se cancela o termina, si vence el plazo (300 s) o si no hay daemon. Si Codex da la petición por resuelta (`serverRequest/resolved`), ya no se responde. Las elicitaciones MCP se rechazan, y cualquier otra petición del servidor recibe el error JSON-RPC -32601.
- **Límites conocidos**:
  - A diferencia de `--strict-mcp-config` en Claude, Codex carga también los servidores MCP del usuario (`~/.codex/config.toml`) además del de Konsora.
  - En Ubuntu 24.04, `kernel.apparmor_restrict_unprivileged_userns = 1` impide que bubblewrap cree user namespaces. Entonces el sandbox de Codex no puede ejecutar nada (`configWarning` al arrancar) y Codex pide aprobación para salir del sandbox hasta para un `cat`. La solución es del sistema, nunca `danger-full-access`: Codex ejecuta el `/usr/bin/bwrap` del sistema (comprobado con `strace`), así que basta un perfil `/etc/apparmor.d/bwrap` como el `lxc-usernsexec` de Ubuntu (`profile bwrap /usr/bin/bwrap flags=(unconfined) { userns, }`), cargado con `sudo apparmor_parser -r`. Se comprueba sin gastar cuota con `codex sandbox -c 'sandbox_mode="workspace-write"' -- <comando>`: escribe en el directorio actual y no fuera, y sin red.
- **Plan B: `codex exec --json`** (`packages/runner/src/codex/exec.ts`).
  - **Cuándo se usa**: el adaptador lo elige la primera vez que lo necesita (`detect()` o el primer run), con un sondeo: abre `codex app-server` y le hace `initialize`. Si no arranca, no responde o su respuesta no tiene la forma de los tipos generados, usa `exec`. Una versión distinta, por sí sola, no basta (solo avisa). `detect()` devuelve `transport` y un `warning` que lo explica. `CodexAdapterOptions.transport` permite forzarlo.
  - **Invocación**: `codex exec --json -m <modelo> -s workspace-write -C <worktree> -c model_reasoning_effort=… -c mcp_servers.konsora.{command,args,env}=… -`, con el prompt por stdin (nunca en argv). Para reanudar: `codex exec resume --json -m <modelo> -c sandbox_mode="workspace-write" … <thread> -`, porque `resume` no admite `-s` ni `-C`. El cwd es el del proceso.
  - **Seguridad**: argv lo ven otros usuarios locales en la lista de procesos, así que el MCP recibe solo los ids y rutas del run, sin `KONSORA_RUN_TOKEN` ni `KONSORA_DAEMON_URL`. Solo los usa la herramienta `permission`, que Codex no necesita. Nunca `--approve-for-me` ni `--dangerously-*`.
  - **Eventos**: `thread.started` → `started` (con `transport: "exec"`). `item.started`/`item.completed` de `command_execution`, `file_change` (`add`/`delete`/`update`), `mcp_tool_call` y `web_search` → `tool`/`file`. `agent_message` → `message`, final el último antes de cerrar el turno. Un `item` de tipo `error` → `error` con «Codex warning». `error` y `turn.failed` → `error` (sin duplicar). `turn.completed` → `usage` (los tokens de esa invocación, con la caché y el razonamiento aparte) + `turn_end`.
  - **Limitaciones**: no hay aprobaciones (lo que el sandbox no permite, falla), ni rate limits, ni coste. El proceso hace un turno y cierra su entrada (`acceptsInput: false`): una respuesta a `ask` no va por stdin, sino que el supervisor espera a que el proceso termine y reanuda el hilo con `exec resume`. `run.json` guarda `transport: "exec"` y la UI avisa de todo esto en la sección del run.

### Perfiles de permisos

| Perfil | Claude | Codex |
|---|---|---|
| `default` | `acceptEdits` + comandos del proyecto (`npm`, `git status/diff/log/add/commit`, los comandos de `checks`) | `workspace-write` + las rutas de git de su rama, sin red, `on-request` |
| `readonly` (RUN-29) | `--permission-mode default`, `--allowedTools` con `Read`, `Glob`, `Grep`, `TodoWrite`, `mcp__konsora` y `git status/diff/log/show/blame` y `ls` (`READONLY_PROFILE_COMMANDS`), y `--disallowedTools Edit,MultiEdit,Write,NotebookEdit`; ningún comando de `checks`. Cualquier otra petición la deniega la herramienta `permission` sin preguntar al humano | sandbox `read-only` en el hilo y en cada turno (`readOnly`, sin red) y `-s read-only` en `exec`, sin rutas escribibles; el supervisor deniega en el acto cualquier aprobación |
| `trusted` | `acceptEdits` + `Bash` amplio, con auto-modo si está disponible | `workspace-write` + red |

Nunca se usan `--dangerously-skip-permissions` ni `--dangerously-bypass-approvals-and-sandbox`. Los perfiles se pueden ampliar en `~/.config/konsora/permissions.json`.

### Credenciales y términos

Konsora **no lee, guarda ni transmite credenciales**: ejecuta el CLI oficial con el login que el usuario ya tiene, y el entorno del proceso hijo es el del usuario sin las variables de Konsora (sin `KONSORA_DAEMON_TOKEN`). Konsora es una herramienta de uso personal. La documentación del Agent SDK de Anthropic no permite que *productos de terceros* ofrezcan el login de claude.ai sin aprobación previa, así que antes de distribuir Konsora habrá que revisar esto o exigir una clave de API para Claude. Codex app-server está pensado para integraciones de terceros. Ver [visión, no-objetivos](vision.md#no-objetivos-por-ahora).

### Ciclo de vida de un run

1. **Preparar**: comprobar que la tarea está `ready` (o pertenece a una cadena YOLO cuyas dependencias ya se han integrado) y que no tiene otro run activo. Fijar `base_commit` = HEAD de `project.base_branch`. Ejecutar `git worktree add -b konsora/<task>/<short> <path> <base_commit>` con `umask 077`, donde `<short>` son los 12 primeros caracteres del ULID del run y `<path>` es `~/.local/share/konsora/worktrees/<project-id>/<task>-<short>`. La limpieza (al integrar o descartar) borra el worktree y la rama, y es idempotente; los worktrees y ramas `konsora/` que ningún run necesita se detectan como huérfanos. Un run cancelado, fallido o devuelto conserva su worktree hasta que el humano lo descarta desde la UI (el último run en su sección y los anteriores en «Runs anteriores con worktree»).
2. **Lanzar**: construir el prompt del run, que es **explícito y auditable**. Incluye título, `desc`, criterios, notas de `feedback` y `answer`, resúmenes de las dependencias e instrucciones de protocolo ("usa las herramientas MCP de Konsora para `note`/`ask`/`finish`; haz commits en la rama"). El prompt se guarda en `run.json`. La tarea pasa a `doing` (lo hace el runner, como `konsora`). Los prompts van en inglés, pero desde CORE-14 los del run, el reintento, el rebase y la revisión piden escribir las notas, preguntas, resúmenes y revisiones en el idioma del título y la descripción de la tarea. Konsora no detecta ni guarda el idioma: el agente lo toma de la tarea. En la verificación de M9b, el revisor escribía en inglés sobre tareas en español.
3. **Supervisar**: `events.jsonl` (cada evento con su `at`), `raw.jsonl` y el WS; las aprobaciones y preguntas llegan a la UI. `run.json` sigue el estado (`running ⇄ waiting_approval`, que el daemon marca mientras hay una aprobación pendiente), el `session_id` y el uso. Al acabar cada turno (`turn_end`) el runner lee el plan: si la tarea ya está en `review`, cierra la entrada del agente; si tiene una pregunta abierta, la deja abierta para entregar la respuesta; si no, la cierra. Cuando el humano responde (`answer`), el daemon pide al runner que la entregue: va como mensaje `user` por la entrada abierta, con la pregunta y la respuesta (`buildAnswerMessage` de `core`). Si el proceso ya terminó con la pregunta abierta, el run espera sin proceso y la respuesta reanuda la sesión con `--resume <session_id>`. La entrega queda en `events.jsonl` (`answer`, con `delivery: stdin | resume`).
4. **Cerrar**: cuando termina el proceso del agente, el runner hace commit de lo que quede como `wip` (sin hooks ni firma, y nunca de `.konsora/`) y calcula `diff.patch` = `base_commit..HEAD`. **Se excluye `.konsora/`** del diff, porque el plan se actualiza solo a través del MCP en el checkout principal y nunca desde el worktree. Si el agente llamó a `finish` (la tarea sigue en `doing` con un `summary` de ese run), el run pasa a `checking` y, al acabar los checks, Konsora aplica `complete`, que lleva la tarea a `review` (o a `done` en una cadena YOLO) y deja el run `succeeded`; si no, queda `failed` y la tarea vuelve a `todo` con una nota de `konsora` enlazada al run. Su trabajo se conserva en la rama y en `diff.patch`.
   - **Preparar el worktree** (`project.setup`, M8): un worktree nuevo no tiene dependencias instaladas, así que, si el proyecto define `setup` (p. ej. `npm ci`), el supervisor lo ejecuta en el worktree después de pasar la tarea a `doing` y antes de lanzar al agente, igual que un check (`/bin/sh -c`, grupo de procesos propio, timeout, entorno sin `KONSORA_*` y el mismo modelo de confianza). Emite `setup` de inicio y de fin (con la cola de su salida) en `events.jsonl` y guarda el resultado en `run.json`. Si falla o vence su plazo, el agente no llega a lanzarse (no se gasta ningún token): el run queda `failed` y la tarea vuelve a `todo` con una nota de `konsora` que lo explica. Cancelar durante el setup lo detiene y deja el run `cancelled`.
5. **Verificar** (M8): cuando el agente llama a `finish`, el run pasa a `checking` y el runner ejecuta en el worktree, en orden, los `project.checks` y después los `acceptance[].check` de la tarea, tal como estaban aprobados al lanzar el run (`plannedChecks`; editarlos durante el run no le afecta). Se ejecutan todos, aunque falle alguno, para que el resultado esté completo.
   - **Cada check** es `/bin/sh -c <comando>` con el worktree como carpeta actual, en un grupo de procesos propio. Su timeout (`timeout_s`, por defecto 600) o una cancelación envían SIGTERM a todo el grupo y, 5 s después, SIGKILL; el check cuenta como fallido, con `timed_out` si venció el plazo. Cuando el shell termina, se mata lo que haya dejado en su grupo, así que ningún proceso sobrevive a su check ni lo deja esperando.
   - **Entorno**: el del usuario (el del daemon) sin ninguna variable `KONSORA_*`, así que no llega ningún token del daemon ni del run.
   - **Resultado**: stdout y stderr juntos, de los que se guardan los últimos 16 KB en `checks.json` (un intento por pasada), y el resumen del último intento en `run.json` (`checks`, `check_attempts`). Cada check emite `{t: "check", phase: "start", id, source, command}` y `{t: "check", phase: "end", id, source, exit_code, duration_ms, timed_out}` en `events.jsonl`, que llegan al log en vivo.
   - **Cierre**: el run pasa a `succeeded` y Konsora aplica `complete` a la tarea: `review`, o `done` en una cadena YOLO. Para una tarea intermedia de una cadena YOLO con todo en verde, el runner integra antes (`integrateRun`, igual que `accept`: un commit con trailers, y se borran el worktree y la rama; un run sin cambios se descarta) y solo con la integración hecha aplica `complete` con `integrated: true`, que la lleva a `done`. Si choca, queda `integration = conflict` y la tarea va a `review` con una nota de `konsora` que nombra los ficheros, y la cadena se detiene ahí. Cualquier otro fallo de la integración también la deja en `review` con una nota. Con algún check en rojo, añade una nota de `konsora` que dice cuáles. Cancelar durante `checking` mata el check en curso y deja el run `cancelled`, y la tarea vuelve a `todo`. Los checks no gastan tokens: no hablan con ningún modelo.
   - **Modelo de confianza**: los checks ejecutan código del worktree que ha escrito el agente (tests, scripts de `package.json`, hooks de herramientas…) **fuera del sandbox del agente**, con los permisos del usuario, igual que si el humano lanzara `npm test` en esa carpeta. Konsora no lo aísla: el humano define los checks (solo él puede cambiar `project.checks` y los criterios aprobados) y decide lanzar el run, así que confía en esos comandos, pero el código que ejecutan puede haberlo cambiado el agente. Por eso los checks no reciben tokens ni variables de Konsora, y su salida se trata como texto no fiable (se muestra y se devuelve al agente, nunca se interpreta). Un proceso que se escape de su grupo (`setsid`) no se puede seguir.
   - **Reintentos** (`project.check_retries`, por defecto 2, leído al lanzar el run): si algún check falla y quedan reintentos, el run vuelve de `checking` a `running`, la tarea recibe una nota de `konsora` («retry N of M») y el mismo agente (mismo proveedor, modelo y esfuerzo) recibe `buildRetryPrompt` (los checks fallidos y, si cree que uno no puede pasar por su trabajo, la instrucción de llamar a `finish` explicando por qué, sin `ask` ni tocar el check, para que la tarea llegue a `review` en rojo y decida el humano) reanudando su sesión (`--resume` en Claude Code, `thread/resume` o `exec resume` en Codex). El evento `{t: "retry", attempt, of, failed}` queda en `events.jsonl`. Cuando vuelve a llamar a `finish` (su resumen anterior ya no cuenta), se repiten **todos** los checks como un intento nuevo en `checks.json`. Con todo en verde, `complete` lleva la tarea a `review` (o a `done` en una cadena YOLO). Agotados los reintentos, va a `review` con los checks en rojo y una nota de `konsora` que lo dice, nunca a `done`. Con `check_retries = 0` no hay reintento ni se gasta ningún token extra. Si la sesión no se puede reanudar (no hay `session_id`), no se reintenta y la nota lo explica. Si tras un reintento el agente termina sin volver a llamar a `finish`, el run queda `failed` y la tarea vuelve a `todo`, como cualquier run sin `finish`.
6. **Integrar** (al ejecutar `accept`): squash de `base_commit..HEAD` sobre `project.base_branch`. El commit lleva el mensaje `<task-id>: <title>`, el cuerpo de la `summary` y los trailers `Konsora-Task:` y `Konsora-Run:`. **Nunca se hace push.**
   - Primero se calcula el resultado con `git merge-tree --write-tree <punta de la base> <head>`, que no tiene efectos: un conflicto nunca deja marcas en ningún árbol de trabajo. El commit se crea con `commit-tree` y tiene como único padre la punta actual de la rama base. Si el resultado cambia algo de `.konsora/`, se rechaza (el runner ya deja la rama sin cambios del plan al cerrar el run).
   - Si la rama base está en el checkout principal → `git merge --ff-only` a ese commit. Antes se rechaza si hay cambios sin commitear en ficheros que toca el resultado, y los demás cambios locales se conservan. Es el mismo efecto que `merge --squash` + `commit`, pero sin tocar nada si algo falla.
   - Si no está en el checkout → `update-ref` condicionado a la punta anterior, sin tocar ningún árbol de trabajo (requiere git ≥ 2.38; la versión aquí es 2.43). Si está en otro worktree, se rechaza.
   - Si hay conflicto → `integration.state = conflict`, la tarea sigue en `review`, el worktree y la rama se conservan y la UI ofrece "pedir al agente que rebase" o "resolver a mano". Resuelto en la rama (se actualiza `head_commit`), se puede volver a integrar.
   - **Pedir el rebase al agente** (`startRebaseRun`, M9): un run nuevo de la misma tarea con `rebase_of` = el run en conflicto, el mismo agente, la misma rama y el mismo worktree, y `base_commit` = la punta actual de la rama base. Konsora aplica `rebase` (`review → doing`), reanuda la sesión del agente si la hay y le envía `buildRebasePrompt`: los ficheros en conflicto (de `merge-tree`, ordenados), el `git rebase <punta>` que debe hacer, y la prohibición de tocar, hacer push o forzar `base_branch`. No se ejecuta `setup` (el worktree ya está preparado). Al terminar, los checks y `complete` son los de cualquier run y la tarea vuelve a `review`; el run en conflicto pasa a `discarded` sin borrar su worktree ni su rama, que ahora son del run nuevo, y `accept` integra el nuevo. Si el run de rebase falla o se cancela, Konsora aplica `rebase-abort` (`doing → review`) con una nota, el run en conflicto sigue igual (y es el que `accept` intenta integrar) y se puede resolver a mano o pedir otro rebase. Descartar un run no borra un worktree que otro run de la tarea aún necesita. Se rechaza si el run no está en `conflict`, si su worktree ya no está en su rama o si ya no choca (`no_conflict`: basta con volver a aceptar).
   - La integración no toca el plan: el daemon solo ejecuta `accept` después de integrar con éxito.
   - Al terminar, se eliminan el worktree y la rama. El run se conserva.
7. **Cancelar**: se deniegan en el acto las aprobaciones pendientes del run, el agente recibe SIGINT y se cierra su entrada. Si no sale en 5 s, `kill()` envía SIGTERM a su grupo de procesos y, 5 s después, SIGKILL. El run queda `cancelled` y la tarea vuelve a `todo` con una nota de `konsora`; su trabajo queda en la rama. Un run que esperaba una respuesta sin proceso se cancela directamente.
8. **Reiniciar el daemon**: `recoverRuns` marca como `interrupted` los runs que estaban vivos (`starting`, `running`, `waiting_approval`, `checking`), sin reanudar ni lanzar nada ni tocar el plan, y cancela los `queued` que quedaron a medias. El humano puede reanudar uno (`resumeRun`, `POST …/runs/:run/resume`): el mismo run, en su worktree y su rama, con una nota de `konsora` en la tarea, que sigue en `doing`. Si se interrumpió en `checking`, solo se repiten los checks; si no, el agente reanuda su sesión con `buildResumePrompt` (o, sin sesión, recibe de nuevo el prompt del run). El evento `resumed` registra el mensaje enviado.

### Scheduler (M9)

Una cola persistente en `~/.local/share/konsora/projects/<id>/queue.json` con las tareas seleccionadas. Una tarea es elegible cuando está `ready`. Límites: `max_parallel` global (por defecto 2) y otro por proveedor; limitan también los runs lanzados a mano con Ejecutar, que si no caben se rechazan y se pueden encolar. Los runs de una cadena YOLO se encadenan solos porque la integración automática desbloquea a los dependientes; fuera de YOLO, la cola espera tu `accept`. La cola nunca añade tareas por su cuenta: **solo ejecuta lo que tú seleccionas**, aunque una dependencia sin seleccionar quede bloqueada (se muestra como bloqueo).

El modelo vive en `core` (`queue.ts`), sin ejecutar nada:
- `queue.json` (`QueueFileSchema`): `{version: 1, state: "running" | "paused", entries: [{task, agent, added_at, run?}]}`. Cada entrada lleva el agente elegido al encolar y, una vez lanzada, el id de su run; sigue en la cola hasta que ese run termina. Un archivo ausente es una cola vacía en marcha y los campos ausentes toman su valor por defecto. Al arrancar, `queueOnStartup` pausa una cola que no esté vacía.
- `settings.json` del daemon (`DaemonSettingsSchema`), en el directorio de datos y no en el plan: `parallel.max_parallel` (por defecto 2, de 1 a 16), común a todos los proyectos del daemon, y `parallel.per_provider` opcional. Estos límites no son solo de la cola: también los respetan los runs lanzados a mano con Ejecutar (`409 no_slots` si no caben; los runs de revisión y de rebase, que el humano pide sobre trabajo ya hecho, no ocupan este límite). Solo ocupan hueco los runs con proceso (`queued`, `starting`, `running`, `waiting_approval`, `checking`); un run `interrupted` ocupa su tarea, pero no un hueco.
- `nextRuns` devuelve lo que hay que lanzar ahora: entradas cuya tarea está `ready` (todas sus dependencias en `done`, es decir, integradas), sin run activo y dentro de los límites, en orden topológico del plan y después por rank (el orden de la cola no cambia lo que se lanza). Con la cola en pausa no devuelve nada. `queueStatus` da el motivo de espera de cada entrada (`running`, `paused`, `blocked` con sus dependencias, `slot` global o de proveedor, `busy` si la tarea no está en `todo` o tiene un run que no lanzó la cola, o `launch`).
- `queueExits` dice qué entradas salen y por qué: su run terminó (`succeeded`, `failed` o `cancelled`; la cola nunca reintenta por su cuenta), la tarea ya no existe (`missing`), volvió a propuesta (`not_approved`) o llegó a `review` o `done` sin un run de la cola (`settled`). `removed` es la acción del humano.

## 6. Canal agente ↔ Konsora

La CLI y el MCP exponen las mismas operaciones de agente sobre `core`, con salida `--json` en la CLI:

| Lectura | Escritura (agente) |
|---|---|
| `status`, `list [--state --group --ready --blocked]`, `show <id>`, `ready`, `blocked`, `check` | `propose`, `batch` (JSON por stdin, todo o nada), `edit` / `withdraw` / `undepend` (solo propuestas), `depend`, `start`, `pause`, `note`, `ask`, `finish --summary` |

Más comandos de la CLI: `init`, `migrate`, `ui`, `mcp`, `run <ids…>`, `runs [id]`, `cancel <run>`. Las transiciones humanas **no** están en la CLI ni en el MCP.

- **MCP en modo run**: el runner lo inyecta con `KONSORA_PROJECT=<checkout principal>`, `KONSORA_RUN=<id>` y `KONSORA_TASK=<id>`. En este modo las escrituras se limitan a la tarea del run (`note`, `ask`, `finish`, `propose` de subtareas como `proposed`), y añade la herramienta `permission` para Claude. Escribe en el `tasks.json` del checkout principal, no en la copia del worktree: `KONSORA_PROJECT` manda sobre `KONSORA_ROOT` y sobre la búsqueda desde la carpeta actual, y un `--root` distinto es un error. La CLI aplica las mismas reglas y acepta `KONSORA_RUN_TASK` como alias de `KONSORA_TASK`.
- **MCP en modo revisión** (RUN-29): un run de revisión inyecta además `KONSORA_REVIEW=1`. La regla de `core` (`OpContext.review`) solo deja la op `review` sobre su tarea (herramienta `review` del MCP y `konsora review <id> --verdict approve|changes`), y la herramienta `permission` deniega todo sin preguntar. `startReviewRun` (runner) lo lanza en el worktree del run revisado con `buildReviewPrompt` (la tarea, sus criterios, el resumen, los checks y el diff, como mucho `REVIEW_DIFF_MAX` caracteres, de forma determinista), sin setup, checks ni `complete`, y un solo turno. Acaba `succeeded` (directamente desde `running`) si dejó su nota, o `failed`; si el worktree cambió (HEAD o ficheros), falla y deja una nota de Konsora.
- **MCP en modo plan** (CLI-05): `konsora plan [objetivo] [--agent claude|codex] [--model …]` abre en la terminal una sesión interactiva del CLI oficial del usuario (no un chat de Konsora) con el prompt de entrevista de `core` (`buildPlanPrompt`, determinista) y solo el MCP de Konsora con `KONSORA_PLAN=1`: con Claude, `--strict-mcp-config --mcp-config <json> --allowedTools <lecturas y propuestas>`; con Codex, `-c mcp_servers.konsora.*`. Sin flags `--dangerously-*`. En este modo la regla de `core` (`OpContext.plan`) solo deja proponer (`propose`, `batch`) y revisar o retirar propuestas (`edit`, `withdraw`); el resto da `out_of_scope`. El resultado son propuestas que el humano aprueba o no.
- **MCP o CLI en una sesión manual**: un agente que el usuario abre por su cuenta usa `konsora` o `konsora mcp`, que funcionan sin daemon. `konsora init` instala una skill o snippet que explica el protocolo (como hace Kanvas).
- Los mensajes de la CLI y el MCP están en inglés y los errores son accionables: `Error: BE-03 is blocked by BE-02 (review). Wait for acceptance or ask the human.`

## 7. UI

- **Tablero**: columnas por estado (`proposed`, `todo`, `doing`, `review`, `done`), *swimlanes* opcionales por grupo y arrastrar y soltar con validación de transición. Lo prohibido no se puede soltar y explica por qué. Indicadores de `blocked`, `waiting`, run activo y "cambio externo sin aprobar".
- **Grafo**: dependencias como DAG con disposición ELK en capas, coloreado por estado. Seleccionar un nodo con sus dependencias selecciona ese subgrafo, que se puede ejecutar.
- **Detalle**: descripción en markdown, criterios con estado de su check, notas como línea de tiempo, runs con log en vivo, y acciones según tu rol.
- **Revisión**: diff por fichero, checks, resumen del agente, y las acciones `accept` (integra), `send back` (con feedback) y `retry with…` (otro modelo).
- **Runs**: runs activos en paralelo, aprobaciones pendientes y uso o rate limits cuando el proveedor los expone.
- **Cola** (`#/cola`, M9): por proyecto, los runs activos, lo que espera en la cola y por qué (bloqueada por una dependencia, esperando un hueco global o de un proveedor, cola en pausa), los límites de paralelismo con su ocupación, y pausar, reanudar, quitar, vaciar y cambiar `max_parallel` y el máximo por proveedor. Se actualiza en vivo con `queue.*` y `run.state`. La barra de selección ofrece **Encolar** (las tareas aprobadas en `todo`, también las bloqueadas, con el agente elegido) junto a Ejecutar. Ejecutar lanza las que caben en `max_parallel` y deja seleccionadas las que no, con un aviso para encolarlas; en el panel de una tarea aprobada en `todo` (también bloqueada) hay **Encolar** junto a Ejecutar, que la añade con el agente del selector; si ya está en la cola, el panel dice su posición y ofrece quitarla. Si Ejecutar se rechaza por falta de hueco, el aviso ofrece el mismo Encolar. En la revisión de un run en conflicto, **Pedir al agente que haga rebase** lanza el run de rebase; la alternativa es resolverlo a mano en su rama y volver a aceptar.
- **Barra de selección**: tareas seleccionadas → proveedor, modelo, esfuerzo y perfil → `Ejecutar`.
- Atajos de teclado, paleta de comandos, modo claro y oscuro. Textos en español a través de una capa i18n, para no tenerlos incrustados en el código.

## 8. Calidad

- `npm run check` = Biome + `tsc --noEmit` + vitest en todos los paquetes.
- `core`: tests de propiedades (serialización, ciclos, transiciones por rol, escritores concurrentes en procesos reales).
- Adaptadores: **tests con grabaciones**. Se graban NDJSON reales de `claude` y `codex` una vez, y los tests los reproducen. No se gasta cuota en CI. Una prueba manual por hito con los CLI reales, documentada en el commit.
- E2E: un repo fixture temporal con git; flujo `init → propose → approve → run (adaptador falso) → review → accept → 1 commit`.

## 9. Decisiones (ADR breves)

| # | Decisión | Alternativas descartadas y motivo |
|---|---|---|
| 1 | Reescribir desde cero (etiqueta `legacy-v0`) | Evolucionar el v0: su sidecar Python síncrono tras un proxy Rust no admite streaming, y la mitad del código sirve a funciones retiradas |
| 2 | TypeScript en todo | Rust (más lento de iterar, sin SDK de agentes), Python (dos lenguajes y empaquetado del intérprete) |
| 3 | Web local primero, Tauri en M10 | Tauri desde el día 1 (fricción de build y depuración), Electron (pesado) |
| 4 | Plan en `tasks.json`, runs fuera de git | Todo en un único fichero (v1: ruido y conflictos de merge), SQLite como fuente (no se puede editar a mano ni lo ven los agentes) |
| 5 | Operaciones semánticas con precondición por tarea | PUT del documento entero con ETag (Kanvas: conflicto de fichero completo) |
| 6 | Detectar transiciones externas con un registro de aprobaciones | Firma HMAC (v1: opaca y confusa), confiar en `--as` (Kanvas: falsificable) |
| 7 | Spawn del CLI oficial de Claude | Agent SDK (mismo binario, más dependencias), API (coste aparte, no usa la suscripción) |
| 8 | `codex app-server` con plan B `exec --json` | Solo `exec` (sin rate limits, modelos ni interacción) |
| 9 | Worktree por run fuera del repo | Trabajar en el checkout (sin aislamiento ni paralelismo), clonar el repo (lento) |
| 10 | Squash local, un commit por tarea, sin push | Dejar la rama (más pasos manuales), rebase (historial ruidoso) |
| 11 | ACP como posible adaptador futuro | ACP como base (va por detrás de las funciones nativas de cada CLI) |
