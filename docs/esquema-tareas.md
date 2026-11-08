# Esquema de tareas v2 (`konsora/2`)

Estado: **diseño aprobado en Fase 0**. La implementación de referencia llega en M1 (`packages/core`). Hasta entonces, este documento es la especificación.

Konsora separa dos cosas que el v1 mezclaba:

| Qué | Dónde | ¿En git? |
|---|---|---|
| **Plan**: tareas, estados, dependencias, criterios, notas | `.konsora/tasks.json` | Sí. Es parte del proyecto. |
| **Ejecuciones**: runs, eventos, diffs, resultados de checks | `.konsora/runs/<run-id>/` | No. `konsora init` crea `.konsora/.gitignore` con `runs/`. |
| **Procedencia y estado local**: aprobaciones humanas registradas, worktrees, registro de proyectos | `$XDG_DATA_HOME/konsora/` (`~/.local/share/konsora/`) | No. Fuera de cualquier repo. |

## 1. Documento

```json
{
  "$schema": "https://konsora.local/schema/tasks.v2.json",
  "schema": "konsora/2",
  "project": {
    "name": "Weather app",
    "base_branch": "main",
    "defaults": { "provider": "claude", "model": "opus", "effort": "high" },
    "checks": [
      { "id": "typecheck", "run": "npm run typecheck", "timeout_s": 300 },
      { "id": "test", "run": "npm test", "timeout_s": 600 }
    ],
    "check_retries": 2
  },
  "groups": [
    { "id": "BE", "name": "Backend" },
    { "id": "FE", "name": "Frontend" }
  ],
  "seq": { "BE": 2, "FE": 0 },
  "tasks": [
    {
      "id": "BE-01",
      "title": "Proxy forecast endpoint",
      "state": "done",
      "group": "BE",
      "rank": "a0",
      "created": { "at": "2026-11-02T10:00:00Z", "by": "human" },
      "updated_at": "2026-11-02T12:30:00Z"
    },
    {
      "id": "BE-02",
      "title": "Cache forecasts for 10 minutes",
      "state": "review",
      "group": "BE",
      "deps": ["BE-01"],
      "rank": "a1",
      "desc": "Cache `GET /forecast` responses in memory, keyed by rounded lat/lon.",
      "acceptance": [
        { "id": "ac1", "text": "A second identical request within 10 min does not hit upstream", "check": "npm test -- cache" },
        { "id": "ac2", "text": "Cache entries expire after 10 min" }
      ],
      "labels": ["perf"],
      "agent": { "provider": "codex", "model": "gpt-5.5", "effort": "medium" },
      "created": { "at": "2026-11-02T10:05:00Z", "by": "agent:claude" },
      "updated_at": "2026-11-02T13:10:00Z",
      "notes": [
        { "id": "n1", "at": "2026-11-02T12:40:00Z", "by": "agent:codex", "kind": "note", "text": "Using an LRU with 500 entries.", "run": "r-01JC8Z3K2Q" },
        { "id": "n2", "at": "2026-11-02T13:10:00Z", "by": "agent:codex", "kind": "summary", "text": "Added in-memory LRU cache with TTL; tests in cache.test.ts.", "run": "r-01JC8Z3K2Q" }
      ]
    }
  ]
}
```

### Campos

**Raíz**

| Campo | Tipo | Oblig. | Notas |
|---|---|---|---|
| `$schema` | string | no | Solo para autocompletado en editores. Se ignora al validar. |
| `schema` | `"konsora/2"` | sí | Versión del formato. Un valor desconocido o futuro → solo lectura, con el error mostrado. |
| `project` | objeto | sí | Ver abajo. |
| `groups` | `Group[]` | sí (≥1) | `konsora init` crea un grupo por defecto. |
| `seq` | `{[groupId]: int}` | sí | Último número asignado por grupo. **Nunca decrece**: un ID borrado no se reutiliza (Kanvas sí los reutiliza). |
| `tasks` | `Task[]` | sí | El orden del array no tiene significado; el orden visual lo da `rank`. |

**`project`**: `name` (1–80), `base_branch` (rama donde se integran las tareas aceptadas; por defecto, la rama actual en `init`), `defaults` (`AgentSpec` opcional), `recommended` (opcional, `{low?, medium?, high?}` con un `AgentSpec` cada uno: el agente que el proyecto recomienda para cada dificultad; solo lo cambia el humano, con la operación `set-recommended`, que sustituye el mapa entero y lo quita con `null` o `{}`), `setup` (opcional, `{run, timeout_s?}`: el comando que prepara cada worktree nuevo antes de lanzar al agente, p. ej. `npm ci`; timeout por defecto 600 s), `checks` (`Check[]` que se ejecutan en todos los runs, con ids únicos) y `check_retries` (entero 0–5; si falta, 2: las veces que un run devuelve al agente los checks fallidos para que los arregle). Solo el humano cambia `setup`, `checks` y `check_retries`, con la operación `set-checks` (un campo omitido se conserva; `setup: null`, `checks: []` y `check_retries: null` los quitan); un agente recibe `forbidden`. `templates` (opcional, `Template[]` con ids únicos) son las plantillas de tarea; solo las define el humano, con `set-templates`, que las sustituye todas (`[]` las quita). `reviewer` (opcional, `{agent, launch}`) es el revisor automático (§6, «Revisiones»): `agent` es un `AgentSpec` cuyo perfil, si se da, solo puede ser `readonly` (sus runs lo usan siempre, `reviewerAgent`), y `launch` es `auto` (se lanza solo cuando una tarea llega a `review`) o `manual` (solo cuando el humano lo pide). Solo lo cambia el humano, con `set-reviewer` (`null` lo quita); un valor inválido da `invalid`.

**`Template`**: `id` (slug en minúsculas, único), `name` (1–60), `desc` (opcional), `acceptance` (opcional, `{text, check?}[]`, sin id), `labels` (opcional) y `difficulty` (opcional). Al proponer con una plantilla (`template` en `propose` y en cada tarea de `batch`; `--template <id>` en la CLI), la tarea toma sus valores y lo que se pasa explícitamente los completa o sustituye: `desc` y `difficulty` propias sustituyen a las de la plantilla, los criterios son los de la plantilla (con su `check`) y después los propios, numerados `ac1…`, y las etiquetas se unen. Una plantilla inexistente da `unknown_template`. `konsora status` (y la herramienta `status` del MCP, en `project.templates`) las lista.

**`Group`**: `id` en `^[A-Z][A-Z0-9]{0,5}$` (prefijo de los IDs), `name` (1–60).

**`Task`**

| Campo | Tipo | Oblig. | Notas |
|---|---|---|---|
| `id` | `^[A-Z][A-Z0-9]{0,5}-\d{2,}$` | sí | `GRUPO-NN`. Estable e inmutable. |
| `title` | string 1–120 | sí | |
| `state` | `proposed \| todo \| doing \| review \| done` | sí | Ver §2. `blocked` y `waiting` son **derivados**, nunca se guardan. |
| `group` | id de grupo | sí | Mover una tarea de grupo **no** cambia su ID. |
| `deps` | `TaskId[]` | no | Sin repetidos, sin autodependencia, sin ciclos, todas existentes. Se guarda ordenado. |
| `rank` | string `[0-9a-z]+` | sí | Rango fraccional (estilo LexoRank). Reordenar cambia una sola tarea, no todas. |
| `desc` | markdown ≤ 32 KB | no | Qué se consigue y por qué. |
| `acceptance` | `Acceptance[]` | no | Criterios de "hecho"; ver abajo. |
| `labels` | `string[]` | no | `^[a-z0-9][a-z0-9-]{0,30}$`, ordenados. |
| `difficulty` | `low \| medium \| high` | no | Dificultad estimada. Un agente la pone al proponer y la cambia en sus propuestas; en el trabajo aprobado, solo el humano. |
| `agent` | `AgentSpec` | no | Sustituye a `project.defaults` para esta tarea. |
| `yolo` | `true` | no | Solo lo activa el humano. Se omite cuando es falso. |
| `created` | `{at, by}` | sí | |
| `updated_at` | ISO-8601 UTC | sí | |
| `notes` | `Note[]` | no | Línea de tiempo; solo se añaden notas (se pueden editar, pero no borrar). |

**`Acceptance`**: `id` (`^ac\d+$`, único en la tarea), `text` (1–500), `check` (opcional; comando de shell que se ejecuta en el worktree, donde un código de salida 0 = cumple). Un criterio sin `check` lo verifica el humano durante la revisión.

**`AgentSpec`**: `provider` (`claude \| codex`, ampliable), `model` (string libre: lo valida el adaptador con su lista de modelos), `effort` (`low \| medium \| high \| xhigh \| max`; el adaptador traduce o rechaza los valores que su proveedor no admita), `permissions` (opcional: nombre de perfil, `default` si se omite).

**Agente de un run**: el que se pide al lanzarlo; si no, el `agent` de la tarea; si no, el de `project.recommended` para su `difficulty`; y si no, `project.defaults` (`runAgentFor`).

**`Check`**: `id`, `run` (comando), `timeout_s` (por defecto 600).

**`Note`**: `id` (`^n\d+$`, único en la tarea), `at`, `by`, `kind`, `text` (1–16 KB), `run` (opcional: run que la produjo), `edited` (opcional: fecha), `verdict` (solo en las notas `review`, que siempre lo llevan: `approve` o `changes`). Tipos de `kind`:

| `kind` | Quién | Significado |
|---|---|---|
| `note` | cualquiera | Comentario o progreso. |
| `question` | agente | El agente necesita al humano. La tarea queda `waiting` hasta que llega un `answer` posterior. |
| `answer` | humano | Responde a la última `question`. |
| `feedback` | humano | Motivo de una devolución (`review → todo`) o de una petición de cambios en una propuesta. **Sustituye a los prefijos de texto de Kanvas** ("Sent back:"). |
| `summary` | agente o runner | Resumen al terminar (`doing → review`). Obligatorio. |
| `review` | agente revisor | Veredicto de un run de revisión (§6) sobre el trabajo de otro run: aprobaría (`approve`) o pediría cambios (`changes`), con los motivos en `text`. Es solo una opinión: no cambia el estado de la tarea. |

**Actores (`by`)**: `human`, `agent:<provider>` (por ejemplo, `agent:claude`), `konsora` (el runner o una migración). Un agente lanzado por Konsora recibe su identidad del run; uno en una sesión manual se identifica con `--as` o con `KONSORA_AGENT` (por defecto, `agent:unknown`).

**Fechas**: ISO-8601 en UTC con `Z` y precisión de segundos.

## 2. Máquina de estados

```
            approve (H)            start (A/K)           finish (A/K)          accept (H)
 proposed ─────────────▶ todo ─────────────▶ doing ─────────────▶ review ─────────────▶ done
    │  ▲                  ▲  ▲                 │                     │                     │
    │  └ edit/depend (A,H)│  └── pause/cancel ─┘                     │                     │
    │                     └──────────── send back + feedback (H) ────┘                     │
    └─ withdraw (A,H) → borrada                 ▲────────────── reopen (H) ────────────────┘
```

H = humano (solo desde la UI de Konsora), A = agente (CLI/MCP), K = runner de Konsora.

| Transición | Quién | Condiciones y efectos |
|---|---|---|
| crear → `proposed` | A, H | `propose` / `batch`. El humano también puede crear una tarea directamente en `todo`. |
| editar `proposed` | A, H | Título, desc, criterios, deps, grupo. |
| `proposed` → borrada | A, H | `withdraw`. Solo si ninguna otra tarea depende de ella. |
| `proposed` → `todo` | **H** | `approve`. |
| editar `todo`/`review`/`done` | **H** | Los agentes no cambian trabajo aprobado; solo añaden notas y dependencias. |
| `todo` → `doing` | A, K | `start`. Rechazado si está `blocked`. Dentro de un run, la tarea la empieza el runner: el agente solo puede hacer `note`, `ask` y `finish` sobre su tarea, o proponer tareas nuevas (`out_of_scope` en otro caso). |
| `doing` → `todo` | A, K, H | `pause` (opcionalmente con nota), cancelación o fallo de un run. |
| `doing` → `review` | A, K | `finish` con `summary`. Dentro de un run, `finish` solo añade el `summary` (con su `run`) y la tarea sigue en `doing`; cuando acaban los checks (§6), Konsora aplica `complete` `{checks_passed, integrated?, text?}`, que la pasa a `review` (o a `done` en una cadena YOLO, solo con todos los checks en verde y su trabajo ya integrado, `integrated: true`) y puede añadir una nota de Konsora. `complete` es solo de Konsora y exige un `summary` de ese run. Si un check falla y quedan reintentos, el agente recibe el fallo y vuelve a llamar a `finish`. |
| `review` → `doing` → `review` | K | `rebase` y `rebase-abort`: solo Konsora, cuando el humano pide al agente que rebase un run en conflicto (ver `arquitectura.md` §5). Si el run de rebase falla o se cancela, `rebase-abort` devuelve la tarea a `review`. |
| nota `review` | A (revisor) | `review` `{verdict, text}`: solo el agente de un run de revisión, sobre la tarea de su run, y es lo único que puede hacer (`out_of_scope` en otro caso; fuera de un run de revisión, `forbidden`). Añade la nota con su `run` y nunca cambia el estado de la tarea: ni acepta ni devuelve. |
| `review` → `done` | **H** | `accept`. Si la tarea tiene un run, integra su rama (squash, ver `arquitectura.md`). |
| `review` → `todo` | **H** | `send-back` con una nota `feedback`, que el agente leerá. |
| `done` → `todo` | **H** | `reopen`. |
| añadir `deps` | A, H | No en tareas `done`. Rechazado si crea un ciclo. |

**Derivados**

- `blocked` = `state == todo` y alguna dependencia no está en `done`. Una dependencia en `review` **no** desbloquea (igual que Kanvas).
- `waiting` = la última nota `question` no tiene un `answer` posterior.
- `ready` = `todo` y no `blocked`.

**YOLO** (adaptado de Kanvas): el humano activa `yolo` en una tarea T, lo que aprueba todas las propuestas de la cadena de T, es decir, T y sus dependencias transitivas. Cuando un run termina con los checks en verde, una tarea de la cadena que no sea T se integra sin revisión (squash en `base_branch`, como `accept`) y solo después pasa a `done`, de modo que sus dependientes parten de una base con su commit; con algún check en rojo, o si la integración choca o falla, va a `review` con una nota de Konsora y la cadena espera ahí. T termina en `review`. El modo YOLO se desactiva cuando T llega a `review`. Así, una cadena puede ejecutarse entera en paralelo sin detenerse en cada revisión intermedia.

## 3. Validación

Hay dos niveles, ambos en `packages/core` y compartidos por la CLI, el MCP, el daemon y la UI:

1. **Estructural**: un esquema zod es la fuente de verdad, y de él se genera `schema/tasks.v2.schema.json` para editores y agentes que editen el archivo a mano. Los campos desconocidos se rechazan en la raíz y en las tareas, salvo bajo una clave `x-*`, que se conserva sin interpretarse.
2. **Semántica**: IDs únicos con prefijo igual a `group`; `seq[g]` ≥ al mayor número usado; grupos existentes; deps existentes, sin ciclos (Kahn, iterativo); IDs de notas, criterios, checks y plantillas únicos; `yolo` solo en tareas no `done`; claves JSON duplicadas rechazadas; tamaño ≤ 8 MiB.

Los errores se devuelven como `{path: JSON Pointer, code, message}`. Un archivo inválido **no se sobrescribe nunca**: Konsora pasa ese proyecto a solo lectura y muestra los errores hasta que se corrija.

## 4. Serialización canónica

Para conseguir diffs mínimos y escrituras byte-idénticas entre la CLI, el MCP y el daemon:

- Las claves van en el orden de este documento. Detrás van las claves de extensión `x-*`, en orden alfabético.
- Los campos opcionales vacíos se omiten (`deps: []`, `desc: ""`, `notes: []`, `yolo: false`…).
- Indentación de 2 espacios, LF, UTF-8 sin BOM, salto de línea final.
- Las tareas se ordenan en el array según el orden de `groups` y, dentro de cada grupo, por número de ID (orden natural: `BE-99` va antes que `BE-100`). Así, añadir una tarea es un *hunk* aislado. Las claves de `seq` siguen el orden de `groups`.
- `deps` va en orden natural de ID y `labels`, alfabéticamente. Las notas, los criterios, los grupos y los checks conservan su orden, porque ese orden tiene significado.
- `parse(serialize(doc))` es idéntico a `doc`, y `serialize(parse(bytes))` es idéntico a `bytes` cuando `bytes` ya es canónico. Ambas propiedades se prueban con fast-check.

## 5. Concurrencia y cambios externos

Escriben en el archivo la CLI, el MCP de cada agente, el daemon (la UI) y, a veces, una persona o un agente con un editor.

**Escrituras de Konsora**

1. Las mutaciones son **operaciones semánticas** (`approve BE-02`, `note BE-02 …`), no el reemplazo del documento entero.
2. Se adquiere `.konsora/tasks.json.lock` con `O_EXCL`. El lock contiene `{pid, host, at}`, y solo se considera caducado si su PID no existe en el mismo host. **No hay caducidad por tiempo**, que es lo que provoca la pérdida de escrituras en Kanvas. Se espera un máximo de 5 s y, si no se consigue, se devuelve un error claro.
3. Se lee el archivo, se valida y se aplica la operación con su **precondición por tarea**: el hash de la tarea que vio el cliente. Si esa tarea cambió → conflicto `409` con la versión actual. Si cambiaron otras tareas → la operación se aplica igualmente (es la "fusión por tarea", sin conflictos de archivo completo).
4. Se valida el resultado y se serializa en forma canónica; se escribe en un temporal del mismo directorio, se hace `fsync` y `rename`, y luego `fsync` del directorio.
5. Se libera el lock y el watcher notifica a la UI.

**Cambios externos** (editor, `git pull`, agente que edita el JSON directamente):

- Se detectan con un watcher sobre `.konsora/`, comparando el hash con la última instantánea conocida.
- Si el resultado es inválido → solo lectura con los errores (ver §3).
- Si es válido → se calcula el diff contra la instantánea y se buscan **transiciones que exigen humano** (`→ todo` desde `proposed`, `→ done`, cambios en tareas aprobadas). Se cruzan con el **registro de aprobaciones** (`~/.local/share/konsora/projects/<id>/approvals.jsonl`, que solo escribe el daemon). Una transición sin registro se marca en la UI como **"cambio externo sin aprobar"**, con opciones de confirmarla o revertirla. Esto sustituye a la firma HMAC del v1: es igual de efectivo en una sola máquina, se entiende mejor y nunca oculta el estado real del archivo.

Límite honesto: un proceso con los permisos del usuario puede escribir cualquier archivo. Los roles se aplican en la CLI, el MCP y la UI, y las violaciones se **detectan y señalan**; no existe una frontera de seguridad contra un agente decidido a engañar. Para reducir ese riesgo, los agentes trabajan en worktrees y solo ven el plan a través del MCP (ver `arquitectura.md`).

## 6. Runs (`.konsora/runs/<run-id>/`)

`run-id` = `r-` + ULID (ordenable por tiempo).

```
run.json        metadatos y estado (se reescribe de forma atómica)
events.jsonl    eventos normalizados (solo se añaden líneas)
raw.jsonl       salida cruda del proveedor, para depuración (rotada a 20 MB: la anterior pasa a raw.1.jsonl)
diff.patch      diff base..head al terminar
checks.json     resultado de cada check, por intento
```

`run.json` (el test de `core` valida este ejemplo):

```json
{
  "id": "r-01JC8Z3K2QX7M4V9T0B6N5R8PW",
  "task": "BE-02",
  "task_hash": "sha256:9f2c4e1b7a0d3c5e8f6a2b4d1c3e5f7a9b0c2d4e6f8a1b3c5d7e9f0a2b4c6d8e",
  "agent": { "provider": "codex", "model": "gpt-5.5", "effort": "medium", "permissions": "default" },
  "state": "succeeded",
  "worktree": "/home/me/.local/share/konsora/worktrees/<project-id>/BE-02-01JC8Z",
  "branch": "konsora/BE-02/01JC8Z",
  "base_commit": "3f2c9a1e5b7d4c6f8a0b2d4e6f8a1c3e5b7d9f0a",
  "head_commit": "9ab1c3e5f7a9b1d3f5a7c9e1b3d5f7a9c1e3b5d7",
  "prompt": "You are working on task BE-02 of the project \"tiempo\", planned with Konsora.\n\n## Task BE-02: …",
  "session_id": "0199a8c2-6f1e-7b3a-9c4d-2e5f8a1b3c6d",
  "started_at": "2026-11-02T10:00:00Z", "finished_at": "2026-11-02T10:14:37Z",
  "exit": { "code": 0, "signal": null },
  "usage": { "input_tokens": 41200, "output_tokens": 5300, "cost_usd": null },
  "summary": "Caché del pronóstico de 10 minutos, con tests.",
  "checks": [{ "id": "test", "source": "project", "exit_code": 0, "duration_ms": 8123, "timed_out": false }],
  "check_attempts": 1,
  "integration": { "state": "pending" }
}
```

Solo `id`, `task`, `task_hash`, `agent` y `state` son obligatorios; el resto se rellena según avanza el run. `prompt` es el texto exacto que recibió el agente: lo genera `buildRunPrompt` de `core` (título, `desc`, criterios con su check, checks del proyecto, notas `feedback` y `answer` con su pregunta, resúmenes de las dependencias e instrucciones de protocolo; las notas ordinarias no entran), de forma determinista. Las claves desconocidas se rechazan.

`setup` dice cómo fue `project.setup` en el worktree (`command`, `exit_code`, `duration_ms`, `timed_out`); su salida va en el evento `setup` de fin en `events.jsonl`. `checks` es el resumen del último intento (sin el comando ni la salida) y `check_attempts`, cuántas veces se ejecutaron los checks (1 más los reintentos usados). Los `run.json` anteriores a M8, con solo `id`, `exit_code` y `duration_ms` en cada check, siguen siendo válidos.

`checks.json` guarda todos los intentos (`ChecksFileSchema` de `core`):

```json
{
  "run": "r-01JC8Z3K2QX7M4V9T0B6N5R8PW",
  "attempts": [
    {
      "attempt": 1, "started_at": "2026-11-02T10:12:00Z", "finished_at": "2026-11-02T10:13:10Z",
      "results": [
        { "id": "test", "source": "project", "command": "npm test", "exit_code": 1, "duration_ms": 8123,
          "timed_out": false, "output": "…\nFAIL cache.test.ts\n", "output_truncated": true },
        { "id": "ac1", "source": "acceptance", "command": "npm test -- cache", "exit_code": null,
          "duration_ms": 600000, "timed_out": true, "output": "" }
      ]
    }
  ]
}
```

Los checks de un run son, en orden, los `project.checks` y después los `acceptance[].check` de la tarea (`plannedChecks`), tal como estaban al lanzarlo. `source` dice de dónde viene cada uno (`project` o `acceptance`, con el id del criterio). Un check cumple si sale con 0 dentro de su `timeout_s` (por defecto, 600). De la salida (stdout y stderr juntos) se guardan los últimos 16 KB (`CHECK_OUTPUT_MAX`). Si falla alguno y quedan reintentos, el agente recibe `buildRetryPrompt`: los checks fallidos con su comando, cómo acabaron y los últimos 4000 caracteres de su salida, sin fechas ni duraciones, de forma determinista. Si el agente está seguro de que un check no puede pasar por su trabajo (el check es imposible o depende de algo fuera del worktree), el prompt le pide llamar a `finish` explicando por qué, en vez de `ask`, para que la tarea llegue a `review` con el check en rojo.

`transport` dice cómo habló el runner con el agente: `stream-json` (Claude Code), `app-server` o `exec` (Codex, el plan B). Con `exec` no hay aprobaciones ni rate limits, y las respuestas reanudan la sesión (`transportLimits` de `core`). Si falta, el run se considera completo.

`usage` lleva siempre `input_tokens` (toda la entrada, caché incluida), `output_tokens` y `cost_usd` (`null` si el proveedor no da precio). Si el proveedor los da, añade `cache_read_tokens` y `cache_write_tokens` (parte de la entrada leída o escrita en la caché), `reasoning_tokens` (parte de la salida) y `rate_limits`, la última foto de cada ventana de la cuenta: `{ "window": "five_hour", "status": "allowed", "utilization": 0.68, "resets_at": "2026-11-01T13:20:00Z" }`, con `utilization` como fracción usada. Los `run.json` anteriores, sin estos campos, siguen siendo válidos.

El coste acumulado de una tarea o de un grupo (`taskCost`, `groupCost` en `core/cost.ts`) suma el `usage` de todos sus runs, incluidos reintentos, rebases, variantes y revisiones: tokens de cada tipo, número de runs y coste, con un desglose por proveedor y modelo. Un coste desconocido no se suma como cero: los runs sin él se cuentan en `cost_unknown_runs`, y `cost_usd` es `null` si ninguno lo da. Un grupo cuenta las tareas que tiene ahora.

Estados de un run (`core` rechaza cualquier otra transición con un error `invalid_transition`):

```
queued           → starting | cancelled
starting         → running | failed | cancelled | interrupted
running          → waiting_approval | checking | failed | cancelled | interrupted
waiting_approval → running | failed | cancelled | interrupted
checking         → running (reintento) | succeeded | failed | cancelled | interrupted
interrupted      → starting (reanudar) | cancelled (descartar)
succeeded, failed, cancelled: finales
```

`interrupted` corresponde a un run que estaba vivo cuando el daemon se cerró: al volver a arrancar **no se reanuda solo**; el humano decide si lo reanuda o lo descarta. Reanudar (`resumeRun`, RUN-27) es el mismo run, no uno nuevo: vuelve a `starting` en su worktree y su rama, con su agente, y su tarea sigue en `doing`. Lo que hace depende del estado en que se interrumpió (`resumeStep`, en el evento `interrupted` de `events.jsonl`): desde `checking` el agente ya había terminado y **solo se repiten los checks**; desde cualquier otro, el agente reanuda su sesión (`session_id`) con `buildResumePrompt`, un mensaje determinista que le explica que Konsora se reinició y que siga con la tarea, o, sin sesión, empieza de nuevo con el prompt original del run. `setup` solo se repite si no había terminado. Los intentos de checks, los resúmenes ya comprobados y el uso anteriores se conservan. Se rechaza (`not_resumable`, sin cambiar nada) si el run no está `interrupted`, si su worktree ya no existe o salió de su rama, o si su tarea ya no está en `doing`. Una entrada de la cola enlazada al run sigue enlazada a él.

Un run de rebase lleva `rebase_of` con el id del run en conflicto cuya rama y worktree reutiliza. `integration.state` solo existe en runs finales: `pending → merged | conflict | discarded` y `conflict → merged | discarded`. Solo un run `succeeded` puede quedar `pending`; cualquier run final se puede descartar directamente.

Cada tarea puede tener muchos runs, pero como máximo **uno activo**: en `queued`, `starting`, `running`, `waiting_approval`, `checking` o `interrupted` (que aún se puede reanudar, así que hay que descartarlo antes de lanzar otro). Las notas que genera un run llevan `run` para enlazarlas.

### Revisiones

Un **run de revisión** (`kind: "review"`, CORE-13) lo hace un segundo agente sobre el trabajo de un run terminado, `review_of`. Siempre usa el perfil de permisos `readonly` (el agente lee el worktree y ejecuta comandos de solo lectura, sin cambiar nada; cada adaptador lo traduce a sus restricciones) y no puede ser variante ni run de rebase. En el plan solo puede añadir notas `review` a su tarea con la op `review` (el MCP lo marca con `review` en el contexto de la op): ninguna otra op, y ninguna cambia el estado de la tarea. Un run de revisión **no ocupa su tarea** (no cuenta frente a la regla de un run activo, ni para `RunStore.activeRun`), nunca se integra (`integrableRun` lo ignora) y solo puede haber uno activo por run revisado. Qué agente revisa y cuándo se lanza lo fija `project.reviewer`. Un run sin `kind` es un run de trabajo (`kind: "work"`).

### Variantes (best-of-N)

Una tarea puede ejecutarse a la vez con varios agentes, de 2 a 3 (`MIN_VARIANTS`, `MAX_VARIANTS`), cada uno en su worktree y su rama: son las **variantes** de un grupo. Cada run del grupo lleva `variant_of` con el id del primer run del grupo (el primero también, con su propio id); un run de rebase no puede ser variante. Las reglas están en `core` (`variants.ts`):

- **Un grupo cuenta como un solo run activo** (`canAddRun`, que aplica `RunStore.create`): sus variantes pueden estar activas a la vez, y mientras alguna lo esté ningún otro run de la tarea puede empezar (`active_run`). Una variante funda el grupo o se une a uno que existe, aún sin decidir y con menos de 3 runs (`variant_group_closed`).
- **La tarea sigue en `doing` hasta que todas las variantes se cierran** (`variantsOutcome`): `running` mientras alguna está activa; después `review` si al menos una terminó `succeeded`, o `failed` (la tarea vuelve a `todo`) si ninguna. Cada `finish` va ligado a su variante por `run`, y la última en cerrarse aplica `complete` con `variants` (los ids del grupo): el resumen puede ser de cualquiera de ellas y la tarea va siempre a `review`, también dentro de una cadena YOLO, porque la ganadora la elige el humano.
- **Elegir la ganadora** (`chooseVariant`, solo con todas cerradas y sobre una variante `succeeded`) la deja con `integration = pending` y pasa las demás a `discarded`; sus runs y su `diff.patch` se conservan. Elegir otra después no es posible.
- **En el runner** (RUN-28): la primera variante funda el grupo y aplica `start`; las demás se unen con una nota mientras la tarea está en `doing`. Cada variante cierra su run sin tocar la tarea (sus fallos y checks en rojo quedan como notas) y `settleVariants`, al cerrarse cada una, aplica `complete` o `pause` cuando ya no queda ninguna activa. Una pregunta de una variante solo detiene a esa variante, y la respuesta se entrega al run que preguntó.
- **Aceptar integra solo la ganadora** (`integrableRun`): con más de una candidata (variantes `succeeded` sin descartar ni integrar), `accept` responde `409 variant_not_chosen` con la lista de variantes, sin tocar nada. Si solo una terminó bien, es la que se integra sin elegir.

## 7. Migración v1 → v2

Con `konsora migrate` (acción explícita; nunca automática al abrir):

| v1 | v2 |
|---|---|
| `schema_version: 1` | `schema: "konsora/2"` |
| `proposal / pending / in_progress / in_review / done` | `proposed / todo / todo + nota / review / done` (`in_progress` pasa a `todo` porque ningún run v1 está vivo) |
| `id` (p. ej. `K-031`) | Se conserva si cumple `GRUPO-NN`, con un grupo creado a partir del prefijo; si no lo cumple, se renumera y el ID antiguo queda en una nota |
| `acceptance_criteria` (texto) | Un elemento `acceptance` por línea de viñeta o por párrafo, sin `check` |
| `sort_order` | `rank` en el mismo orden |
| `attempts`, `activity`, `reviews` | Se mueven tal cual a `.konsora/legacy/v1-history.json` |

Antes de escribir se guarda una copia, `tasks.v1.json.bak`. La migración muestra un resumen previo (`--dry-run` por defecto en la CLI) y exige confirmación.
