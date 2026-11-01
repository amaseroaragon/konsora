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
    ]
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

**`project`**: `name` (1–80), `base_branch` (rama donde se integran las tareas aceptadas; por defecto, la rama actual en `init`), `defaults` (`AgentSpec` opcional), `checks` (`Check[]` que se ejecutan en todos los runs).

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
| `agent` | `AgentSpec` | no | Sustituye a `project.defaults` para esta tarea. |
| `yolo` | `true` | no | Solo lo activa el humano. Se omite cuando es falso. |
| `created` | `{at, by}` | sí | |
| `updated_at` | ISO-8601 UTC | sí | |
| `notes` | `Note[]` | no | Línea de tiempo; solo se añaden notas (se pueden editar, pero no borrar). |

**`Acceptance`**: `id` (`^ac\d+$`, único en la tarea), `text` (1–500), `check` (opcional; comando de shell que se ejecuta en el worktree, donde un código de salida 0 = cumple). Un criterio sin `check` lo verifica el humano durante la revisión.

**`AgentSpec`**: `provider` (`claude \| codex`, ampliable), `model` (string libre: lo valida el adaptador con su lista de modelos), `effort` (`low \| medium \| high \| xhigh \| max`; el adaptador traduce o rechaza los valores que su proveedor no admita), `permissions` (opcional: nombre de perfil, `default` si se omite).

**`Check`**: `id`, `run` (comando), `timeout_s` (por defecto 600).

**`Note`**: `id` (`^n\d+$`, único en la tarea), `at`, `by`, `kind`, `text` (1–16 KB), `run` (opcional: run que la produjo), `edited` (opcional: fecha). Tipos de `kind`:

| `kind` | Quién | Significado |
|---|---|---|
| `note` | cualquiera | Comentario o progreso. |
| `question` | agente | El agente necesita al humano. La tarea queda `waiting` hasta que llega un `answer` posterior. |
| `answer` | humano | Responde a la última `question`. |
| `feedback` | humano | Motivo de una devolución (`review → todo`) o de una petición de cambios en una propuesta. **Sustituye a los prefijos de texto de Kanvas** ("Sent back:"). |
| `summary` | agente o runner | Resumen al terminar (`doing → review`). Obligatorio. |

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
| `doing` → `review` | A, K | `finish` con `summary`. Dentro de un run, el runner aplica la transición **después** de los checks (§6). |
| `review` → `done` | **H** | `accept`. Si la tarea tiene un run, integra su rama (squash, ver `arquitectura.md`). |
| `review` → `todo` | **H** | `send-back` con una nota `feedback`, que el agente leerá. |
| `done` → `todo` | **H** | `reopen`. |
| añadir `deps` | A, H | No en tareas `done`. Rechazado si crea un ciclo. |

**Derivados**

- `blocked` = `state == todo` y alguna dependencia no está en `done`. Una dependencia en `review` **no** desbloquea (igual que Kanvas).
- `waiting` = la última nota `question` no tiene un `answer` posterior.
- `ready` = `todo` y no `blocked`.

**YOLO** (adaptado de Kanvas): el humano activa `yolo` en una tarea T, lo que aprueba todas las propuestas de la cadena de T, es decir, T y sus dependencias transitivas. Cuando un run termina con los checks en verde, una tarea de la cadena que no sea T pasa directamente a `done` y se integra sin revisión. T termina en `review`. El modo YOLO se desactiva cuando T llega a `review`. Así, una cadena puede ejecutarse entera en paralelo sin detenerse en cada revisión intermedia.

## 3. Validación

Hay dos niveles, ambos en `packages/core` y compartidos por la CLI, el MCP, el daemon y la UI:

1. **Estructural**: un esquema zod es la fuente de verdad, y de él se genera `schema/tasks.v2.schema.json` para editores y agentes que editen el archivo a mano. Los campos desconocidos se rechazan en la raíz y en las tareas, salvo bajo una clave `x-*`, que se conserva sin interpretarse.
2. **Semántica**: IDs únicos con prefijo igual a `group`; `seq[g]` ≥ al mayor número usado; grupos existentes; deps existentes, sin ciclos (Kahn, iterativo); IDs de notas y criterios únicos; `yolo` solo en tareas no `done`; claves JSON duplicadas rechazadas; tamaño ≤ 8 MiB.

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
raw.jsonl       salida cruda del proveedor, para depuración (rotada a 20 MB)
diff.patch      diff base..head al terminar
checks.json     resultado de cada check
```

`run.json`:

```json
{
  "id": "r-01JC8Z3K2Q",
  "task": "BE-02",
  "task_hash": "sha256:…",
  "agent": { "provider": "codex", "model": "gpt-5.5", "effort": "medium", "permissions": "default" },
  "state": "succeeded",
  "worktree": "/home/me/.local/share/konsora/worktrees/<project-id>/BE-02-01JC8Z",
  "branch": "konsora/BE-02/01JC8Z",
  "base_commit": "3f2c…",
  "head_commit": "9ab1…",
  "session_id": "…",
  "started_at": "…", "finished_at": "…",
  "exit": { "code": 0, "signal": null },
  "usage": { "input_tokens": 41200, "output_tokens": 5300, "cost_usd": null },
  "summary": "…",
  "checks": [{ "id": "test", "exit_code": 0, "duration_ms": 8123 }],
  "integration": { "state": "pending" }
}
```

Estados de un run: `queued → starting → running ⇄ waiting_approval → checking → succeeded | failed | cancelled | interrupted`. `interrupted` corresponde a un run que estaba vivo cuando el daemon se cerró: al volver a arrancar **no se reanuda solo**; el humano decide si lo reanuda (con `--resume`, usando el `session_id`) o lo descarta. `integration.state`: `pending → merged | conflict | discarded`.

Cada tarea puede tener muchos runs, pero como máximo **uno activo**. Las notas que genera un run llevan `run` para enlazarlas.

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
