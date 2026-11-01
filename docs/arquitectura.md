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
- **Runs**: `POST /projects/:id/runs` `{task, agent?}` lanza un run (solo lo que el humano selecciona); `GET /projects/:id/runs[?task=]`, `GET …/runs/:run`, `…/runs/:run/events`, `…/runs/:run/diff`, `POST …/runs/:run/cancel` y `POST …/runs/:run/discard` (un run terminado y sin integrar: borra su worktree y su rama y deja `integration = discarded`; el run y su `diff.patch` se conservan). `GET /projects/:id/worktrees/orphans` lista, sin borrar nada, los worktrees y ramas `konsora/` que ningún run necesita. `accept` sobre una tarea cuyo último run está `succeeded` y sin integrar integra antes: comprueba la op en seco, integra (un commit) y después marca `done`; un conflicto devuelve `409 integration_conflict` con los ficheros y la tarea sigue en `review`. Después de `answer`, el daemon entrega la respuesta al run que la espera. Una aprobación pendiente mueve su run a `waiting_approval`. Al arrancar, los runs que estaban vivos pasan a `interrupted`. Los worktrees van en `<data>/worktrees/<project-id>/` y los archivos privados de cada run (la config MCP con su token) en `<data>/projects/<project-id>/runs/`.
- **WS**: `board.changed` (hash nuevo y diff por tarea), `board.invalid` (errores), `run.event` (cada línea de `events.jsonl`, en el mismo orden), `run.state` (cada cambio de `run.json`), `permission.requested` y `permission.resolved`, `question.asked`.
- El watcher (`fs.watch` sobre `.konsora/` con un debounce de 100 ms y comparación de hash) sustituye al polling del v1.

## 5. Capa de ejecución (runner)

### Interfaz de adaptador

```ts
interface AgentAdapter {
  id: "claude" | "codex";
  detect(): Promise<{ installed: boolean; version?: string; authenticated?: boolean | "unknown" }>;
  models(): Promise<ModelInfo[]>;                  // {id, label, efforts[]}
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
- Cancelar: SIGINT (termina el turno y se conserva la sesión) → si no responde, `kill()`.
- **Sin `--bare`**: `--bare` no usa el login de la suscripción. En su lugar, el worktree es una copia del repo, así que los hooks y el MCP del proyecto son los mismos que el usuario ya ejecuta.

### Codex

`codex app-server` por stdio (JSON-RPC sin cabecera `jsonrpc`, NDJSON). Los tipos se generan con `codex app-server generate-ts` para la versión instalada y se guardan en `packages/runner/src/codex/protocol/` (`npm run codex:types`, que puede usar otro binario con `CODEX_BIN`):

- **Solo se guarda lo que se usa**: el cierre transitivo de las cuatro uniones del protocolo (`ClientRequest`, `ClientNotification`, `ServerRequest`, `ServerNotification`) más las respuestas que lee el adaptador (la lista `ROOTS` de `packages/runner/scripts/codex-protocol.ts`). Con codex-cli 0.166.0 son 470 archivos (~280 KB) de los ~760 (3,2 MB) que genera. Si el adaptador necesita otra respuesta, se añade a `ROOTS` y se regenera.
- ts-rs escribe `import type … from "./X"`, y con `nodenext` + `allowImportingTsExtensions` un import relativo necesita su extensión, así que el script añade `.ts`. Los `index.ts` generados reexportan todo, así que se sustituyen por índices de lo guardado (`v2` y `serde_json` como espacios de nombres). `version.ts` guarda `CODEX_PROTOCOL_VERSION`.
- Sin la variante `--experimental`. La salida es determinista y Biome no formatea esa carpeta. Un test comprueba que todos sus imports resuelven dentro de ella.
- `detectCodex()` compara `codex --version` con `CODEX_PROTOCOL_VERSION` y devuelve `expected_version`, `version_matches` y, si no coinciden, un `warning`. Nunca bloquea.

El adaptador (`packages/runner/src/codex/adapter.ts`), comprobado con codex-cli 0.166.0 en las grabaciones de `packages/runner/test/fixtures/codex/`:

- Run: `codex app-server` en el worktree → `initialize` (con `clientInfo.name = "konsora"`) → `initialized` → `thread/start {model, cwd: worktree, sandbox: workspace-write, approvalPolicy: on-request, config: {mcp_servers: {konsora: {command, args, env}}}}` → `turn/start {input, effort}`. Con `resume` se usa `thread/resume {threadId, …}` con los mismos parámetros. El id del hilo es el `session_id` del run.
- Las variables del run (con su token) solo viajan dentro de `config`, por stdin: no se escriben en disco ni van al entorno del hijo, que es el del usuario sin `KONSORA_*`. `workspace-write` deja la red desactivada (`networkAccess: false` en la respuesta).
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
| `default` | `acceptEdits` + comandos del proyecto (`npm`, `git status/diff/log/add/commit`, los comandos de `checks`) | `workspace-write`, sin red, `on-request` |
| `readonly` | `default` (manual) solo con lectura | `read-only` |
| `trusted` | `acceptEdits` + `Bash` amplio, con auto-modo si está disponible | `workspace-write` + red |

Nunca se usan `--dangerously-skip-permissions` ni `--dangerously-bypass-approvals-and-sandbox`. Los perfiles se pueden ampliar en `~/.config/konsora/permissions.json`.

### Credenciales y términos

Konsora **no lee, guarda ni transmite credenciales**: ejecuta el CLI oficial con el login que el usuario ya tiene, y el entorno del proceso hijo es el del usuario sin las variables de Konsora (sin `KONSORA_DAEMON_TOKEN`). Konsora es una herramienta de uso personal. La documentación del Agent SDK de Anthropic no permite que *productos de terceros* ofrezcan el login de claude.ai sin aprobación previa, así que antes de distribuir Konsora habrá que revisar esto o exigir una clave de API para Claude. Codex app-server está pensado para integraciones de terceros. Ver [visión, no-objetivos](vision.md#no-objetivos-por-ahora).

### Ciclo de vida de un run

1. **Preparar**: comprobar que la tarea está `ready` (o pertenece a una cadena YOLO cuyas dependencias ya se han integrado) y que no tiene otro run activo. Fijar `base_commit` = HEAD de `project.base_branch`. Ejecutar `git worktree add -b konsora/<task>/<short> <path> <base_commit>` con `umask 077`, donde `<short>` son los 12 primeros caracteres del ULID del run y `<path>` es `~/.local/share/konsora/worktrees/<project-id>/<task>-<short>`. La limpieza (al integrar o descartar) borra el worktree y la rama, y es idempotente; los worktrees y ramas `konsora/` que ningún run necesita se detectan como huérfanos. Un run cancelado, fallido o devuelto conserva su worktree hasta que el humano lo descarta desde la UI (el último run en su sección y los anteriores en «Runs anteriores con worktree»).
2. **Lanzar**: construir el prompt del run, que es **explícito y auditable**. Incluye título, `desc`, criterios, notas de `feedback` y `answer`, resúmenes de las dependencias e instrucciones de protocolo ("usa las herramientas MCP de Konsora para `note`/`ask`/`finish`; haz commits en la rama"). El prompt se guarda en `run.json`. La tarea pasa a `doing` (lo hace el runner, como `konsora`).
3. **Supervisar**: `events.jsonl` (cada evento con su `at`), `raw.jsonl` y el WS; las aprobaciones y preguntas llegan a la UI. `run.json` sigue el estado (`running ⇄ waiting_approval`, que el daemon marca mientras hay una aprobación pendiente), el `session_id` y el uso. Al acabar cada turno (`turn_end`) el runner lee el plan: si la tarea ya está en `review`, cierra la entrada del agente; si tiene una pregunta abierta, la deja abierta para entregar la respuesta; si no, la cierra. Cuando el humano responde (`answer`), el daemon pide al runner que la entregue: va como mensaje `user` por la entrada abierta, con la pregunta y la respuesta (`buildAnswerMessage` de `core`). Si el proceso ya terminó con la pregunta abierta, el run espera sin proceso y la respuesta reanuda la sesión con `--resume <session_id>`. La entrega queda en `events.jsonl` (`answer`, con `delivery: stdin | resume`).
4. **Cerrar**: cuando termina el proceso del agente, el runner hace commit de lo que quede como `wip` (sin hooks ni firma, y nunca de `.konsora/`) y calcula `diff.patch` = `base_commit..HEAD`. **Se excluye `.konsora/`** del diff, porque el plan se actualiza solo a través del MCP en el checkout principal y nunca desde el worktree. Si el agente llamó a `finish` (la tarea está en `review`), el run pasa por `checking` a `succeeded`; si no, queda `failed` y la tarea vuelve a `todo` con una nota de `konsora` enlazada al run. Su trabajo se conserva en la rama y en `diff.patch`.
5. **Verificar** (M8; hasta entonces `checking` no ejecuta nada): ejecutar `project.checks` y los `acceptance[].check` en el worktree, con timeout. Si todo pasa → la tarea va a `review` con una `summary`. Si algo falla → M8: el resultado se devuelve al mismo agente (`--resume` / `turn/start`) hasta N reintentos; agotados los reintentos, la tarea va a `review` marcada con los checks en rojo.
6. **Integrar** (al ejecutar `accept`): squash de `base_commit..HEAD` sobre `project.base_branch`. El commit lleva el mensaje `<task-id>: <title>`, el cuerpo de la `summary` y los trailers `Konsora-Task:` y `Konsora-Run:`. **Nunca se hace push.**
   - Primero se calcula el resultado con `git merge-tree --write-tree <punta de la base> <head>`, que no tiene efectos: un conflicto nunca deja marcas en ningún árbol de trabajo. El commit se crea con `commit-tree` y tiene como único padre la punta actual de la rama base. Si el resultado cambia algo de `.konsora/`, se rechaza (el runner ya deja la rama sin cambios del plan al cerrar el run).
   - Si la rama base está en el checkout principal → `git merge --ff-only` a ese commit. Antes se rechaza si hay cambios sin commitear en ficheros que toca el resultado, y los demás cambios locales se conservan. Es el mismo efecto que `merge --squash` + `commit`, pero sin tocar nada si algo falla.
   - Si no está en el checkout → `update-ref` condicionado a la punta anterior, sin tocar ningún árbol de trabajo (requiere git ≥ 2.38; la versión aquí es 2.43). Si está en otro worktree, se rechaza.
   - Si hay conflicto → `integration.state = conflict`, la tarea sigue en `review`, el worktree y la rama se conservan y la UI ofrece "pedir al agente que rebase" o "resolver a mano". Resuelto en la rama (se actualiza `head_commit`), se puede volver a integrar.
   - La integración no toca el plan: el daemon solo ejecuta `accept` después de integrar con éxito.
   - Al terminar, se eliminan el worktree y la rama. El run se conserva.
7. **Cancelar**: se deniegan en el acto las aprobaciones pendientes del run, el agente recibe SIGINT y se cierra su entrada. Si no sale en 5 s, `kill()` envía SIGTERM a su grupo de procesos y, 5 s después, SIGKILL. El run queda `cancelled` y la tarea vuelve a `todo` con una nota de `konsora`; su trabajo queda en la rama. Un run que esperaba una respuesta sin proceso se cancela directamente.
8. **Reiniciar el daemon**: `recoverRuns` marca como `interrupted` los runs que estaban vivos (`starting`, `running`, `waiting_approval`, `checking`), sin reanudar ni lanzar nada ni tocar el plan, y cancela los `queued` que quedaron a medias.

### Scheduler (M9)

Una cola persistente en `~/.local/share/konsora/projects/<id>/queue.json` con las tareas seleccionadas. Una tarea es elegible cuando está `ready`. Límites: `max_parallel` global (por defecto 2) y otro por proveedor. Los runs de una cadena YOLO se encadenan solos porque la integración automática desbloquea a los dependientes; fuera de YOLO, la cola espera tu `accept`. La cola nunca añade tareas por su cuenta: **solo ejecuta lo que tú seleccionas**, aunque una dependencia sin seleccionar quede bloqueada (se muestra como bloqueo).

## 6. Canal agente ↔ Konsora

La CLI y el MCP exponen las mismas operaciones de agente sobre `core`, con salida `--json` en la CLI:

| Lectura | Escritura (agente) |
|---|---|
| `status`, `list [--state --group --ready --blocked]`, `show <id>`, `ready`, `blocked`, `check` | `propose`, `batch` (JSON por stdin, todo o nada), `edit` / `withdraw` / `undepend` (solo propuestas), `depend`, `start`, `pause`, `note`, `ask`, `finish --summary` |

Más comandos de la CLI: `init`, `migrate`, `ui`, `mcp`, `run <ids…>`, `runs [id]`, `cancel <run>`. Las transiciones humanas **no** están en la CLI ni en el MCP.

- **MCP en modo run**: el runner lo inyecta con `KONSORA_PROJECT=<checkout principal>`, `KONSORA_RUN=<id>` y `KONSORA_TASK=<id>`. En este modo las escrituras se limitan a la tarea del run (`note`, `ask`, `finish`, `propose` de subtareas como `proposed`), y añade la herramienta `permission` para Claude. Escribe en el `tasks.json` del checkout principal, no en la copia del worktree: `KONSORA_PROJECT` manda sobre `KONSORA_ROOT` y sobre la búsqueda desde la carpeta actual, y un `--root` distinto es un error. La CLI aplica las mismas reglas y acepta `KONSORA_RUN_TASK` como alias de `KONSORA_TASK`.
- **MCP o CLI en una sesión manual**: un agente que el usuario abre por su cuenta usa `konsora` o `konsora mcp`, que funcionan sin daemon. `konsora init` instala una skill o snippet que explica el protocolo (como hace Kanvas).
- Los mensajes de la CLI y el MCP están en inglés y los errores son accionables: `Error: BE-03 is blocked by BE-02 (review). Wait for acceptance or ask the human.`

## 7. UI

- **Tablero**: columnas por estado (`proposed`, `todo`, `doing`, `review`, `done`), *swimlanes* opcionales por grupo y arrastrar y soltar con validación de transición. Lo prohibido no se puede soltar y explica por qué. Indicadores de `blocked`, `waiting`, run activo y "cambio externo sin aprobar".
- **Grafo**: dependencias como DAG con disposición ELK en capas, coloreado por estado. Seleccionar un nodo con sus dependencias selecciona ese subgrafo, que se puede ejecutar.
- **Detalle**: descripción en markdown, criterios con estado de su check, notas como línea de tiempo, runs con log en vivo, y acciones según tu rol.
- **Revisión**: diff por fichero, checks, resumen del agente, y las acciones `accept` (integra), `send back` (con feedback) y `retry with…` (otro modelo).
- **Runs**: runs activos en paralelo, aprobaciones pendientes y uso o rate limits cuando el proveedor los expone.
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
