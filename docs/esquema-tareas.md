# Esquema de tareas v5 (`konsora/5`)

La implementación de referencia es `packages/core`. Este documento la describe; si discrepan, manda el código y se corrige el documento.

| Qué | Dónde | ¿En git? |
|---|---|---|
| **Plan**: tareas, estados, dependencias, criterios, notas, plantillas | `.konsora/tasks.json` | Sí. Es parte del proyecto. |
| **Integración con Claude Code**: skill y servidor MCP | `.claude/skills/konsora/SKILL.md`, `.mcp.json` | Sí, si quieres compartirla. |
| **Procedencia y estado local**: aprobaciones humanas registradas, instantáneas para detectar cambios externos, registro de proyectos | `$XDG_DATA_HOME/konsora/` (`~/.local/share/konsora/`) | No. Fuera de cualquier repo. |

`konsora/5` (M14) es `konsora/4` sin los **bloques** (`blocks` y `task.block`), que agrupaban tareas en una rama de git con merge desde la UI. `konsora/4` (M12) había quitado la aprobación y la revisión de `konsora/3`: las tareas nacen en `todo` y `finish` las da por hechas. Y `konsora/3` había quitado los campos de ejecución de `konsora/2` (agentes, checks, setup, revisor, dificultad, runs). Ver §6 para migrar.

## 1. Documento

```json
{
  "$schema": "https://konsora.local/schema/tasks.v5.json",
  "schema": "konsora/5",
  "project": {
    "name": "Weather app",
    "templates": [
      { "id": "bug", "name": "Arreglo de bug", "acceptance": [{ "text": "Un test reproduce el bug" }], "labels": ["bug"] }
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
      "state": "done",
      "group": "BE",
      "deps": ["BE-01"],
      "rank": "a1",
      "desc": "Cache `GET /forecast` responses in memory, keyed by rounded lat/lon.",
      "acceptance": [
        { "id": "ac1", "text": "A second identical request within 10 min does not hit upstream" },
        { "id": "ac2", "text": "Cache entries expire after 10 min" }
      ],
      "labels": ["perf"],
      "created": { "at": "2026-11-02T10:05:00Z", "by": "agent:claude" },
      "updated_at": "2026-11-02T13:10:00Z",
      "notes": [
        { "id": "n1", "at": "2026-11-02T12:40:00Z", "by": "agent:claude", "kind": "note", "text": "Using an LRU with 500 entries." },
        { "id": "n2", "at": "2026-11-02T13:10:00Z", "by": "agent:claude", "kind": "summary", "text": "Added in-memory LRU cache with TTL; tests in cache.test.ts." }
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
| `schema` | `"konsora/5"` | sí | Versión del formato. Un valor desconocido u otra versión → solo lectura, con el error mostrado (`konsora migrate` convierte las antiguas). |
| `project` | objeto | sí | Ver abajo. |
| `groups` | `Group[]` | sí (≥1) | `konsora init` crea un grupo por defecto. |
| `seq` | `{[groupId]: int}` | sí | Último número asignado por grupo. **Nunca decrece**: un ID borrado no se reutiliza (Kanvas sí los reutiliza). |
| `archived` | `TaskId[]` | no | IDs de las tareas hechas que `konsora archive` movió a `.konsora/archive.json` (ver §7). Una dependencia sobre una de ellas cuenta como hecha, y su ID no se reutiliza ni puede usarlo una tarea del plan. Se guarda en orden natural. |
| `tasks` | `Task[]` | sí | El orden del array no tiene significado; el orden visual lo da `rank`. |

**`project`**: `name` (1–80) y `templates` (opcional, `Template[]` con ids únicos): las plantillas de tarea. Solo las define el humano, con `set-templates`, que las sustituye todas (`[]` las quita); un agente recibe `forbidden`.

**`Template`**: `id` (slug en minúsculas, único), `name` (1–60), `desc` (opcional), `acceptance` (opcional, `{text}[]`, sin id) y `labels` (opcional). Al proponer con una plantilla (`template` en `propose` y en cada tarea de `batch`; `--template <id>` en la CLI), la tarea toma sus valores y lo que se pasa explícitamente los completa o sustituye: la `desc` propia sustituye a la de la plantilla, los criterios son los de la plantilla y después los propios, numerados `ac1…`, y las etiquetas se unen. Una plantilla inexistente da `unknown_template`. `konsora status` (y la herramienta `status` del MCP, en `project.templates`) las lista.

**`Group`**: `id` en `^[A-Z][A-Z0-9]{0,5}$` (prefijo de los IDs), `name` (1–60).

**`Task`**

| Campo | Tipo | Oblig. | Notas |
|---|---|---|---|
| `id` | `^[A-Z][A-Z0-9]{0,5}-\d{2,}$` | sí | `GRUPO-NN`. Estable e inmutable. |
| `title` | string 1–120 | sí | |
| `state` | `proposed \| todo \| doing \| done` | sí | Ver §2. `proposed` es una **idea**. `blocked` y `waiting` son **derivados**, nunca se guardan. |
| `group` | id de grupo | sí | Mover una tarea de grupo **no** cambia su ID. |
| `deps` | `TaskId[]` | no | Sin repetidos, sin autodependencia, sin ciclos, todas existentes. Se guarda ordenado. |
| `rank` | string `[0-9a-z]+` | sí | Rango fraccional (estilo LexoRank): el menor va primero. Es el orden de cada columna del tablero y de `konsora ready`. Reordenar (`move`) cambia una sola tarea, no todas. |
| `desc` | markdown ≤ 32 KB | no | Qué se consigue y por qué. |
| `acceptance` | `Acceptance[]` | no | Criterios de "hecho"; ver abajo. |
| `labels` | `string[]` | no | `^[a-z0-9][a-z0-9-]{0,30}$`, ordenados. |
| `difficulty` | `low \| medium \| high` | no | Dificultad estimada: *low* = mecánica, pocos ficheros; *medium* = una funcionalidad dentro de un área; *high* = transversal, con decisiones de diseño o con riesgo. La estima el agente al crear (`--difficulty`, `difficulty` en `batch` y en el MCP) y se cambia con `edit` (`none` / `null` la quita). Se ve en el tablero, el grafo, el panel y `konsora show`/`list`, y se puede filtrar por ella. |
| `created` | `{at, by}` | sí | |
| `updated_at` | ISO-8601 UTC | sí | |
| `notes` | `Note[]` | no | Línea de tiempo; solo se añaden notas (se pueden editar, pero no borrar). |

**`Acceptance`**: `id` (`^ac\d+$`, único en la tarea) y `text` (1–500). Cada criterio describe algo verificable: un comando que pasa o un resultado observable. El agente explica en su resumen cómo cumple cada uno.

**`Note`**: `id` (`^n\d+$`, único en la tarea), `at`, `by`, `kind`, `text` (1–16 KB), `options` (opcional, solo en una `question`: de 2 a 10 respuestas distintas, de hasta 200 caracteres, que el humano puede elegir con un clic) y `edited` (opcional: fecha). Tipos de `kind`:

| `kind` | Quién | Significado |
|---|---|---|
| `note` | cualquiera | Comentario o progreso. |
| `question` | agente | El agente necesita al humano. La tarea queda `waiting` hasta que llega un `answer` posterior. Con `konsora ask --option A --option B` (u `options` en el MCP) lleva opciones de respuesta. |
| `answer` | humano | Responde a la última `question`. |
| `feedback` | humano | Heredado de versiones con revisión (devoluciones); se conserva al migrar. |
| `summary` | agente | Resumen al terminar (`doing → done`). Obligatorio. La UI lo muestra destacado en las tareas hechas. |

**Actores (`by`)**: `human`, `agent:<nombre>` (por ejemplo, `agent:claude`) y `konsora` (una migración). Un agente se identifica con `--as` o con `KONSORA_AGENT` en la CLI y en el MCP (por defecto, `agent:unknown` en la CLI y el nombre del cliente MCP en el servidor).

**Fechas**: ISO-8601 en UTC con `Z` y precisión de segundos.

## 2. Máquina de estados

```
            promote (A,H)          start (A)            finish (A)
 proposed ─────────────▶ todo ─────────────▶ doing ─────────────▶ done
 (idea)   ◀─────────────  ▲  ▲                 │                     │
            demote (A,H)  │  └──── pause ──────┘                     │
                          └─────────────────── reopen (H) ───────────┘
 delete (A: proposed/todo; H: cualquiera) → borrada
```

H = humano (solo desde la UI de Konsora), A = agente (CLI/MCP). **No hay aprobación ni revisión**: una tarea creada está lista para trabajarse, y `finish` la da por hecha.

| Operación | Quién | Condiciones y efectos |
|---|---|---|
| crear → `todo` | A, H | `propose` / `batch`. Se crea como idea con `propose --idea` (`idea: true` en el MCP) o con `idea: true` en una tarea de `batch`. |
| `proposed` → `todo` | A, H | `promote`. |
| `todo` → `proposed` | A, H | `demote`: una tarea que nadie ha empezado vuelve a ser una idea. Rechazado en `doing` y `done`. |
| editar | A, H | Título, desc, criterios, etiquetas, deps, grupo (`edit`, `depend`, `undepend`). Un agente no cambia tareas `done`. |
| reordenar | A, H | `move`: justo antes o después de otra tarea, o la primera de todas. Solo cambia el `rank` de esa tarea. Un agente no reordena tareas `done`. |
| borrar | A, H | `delete`. Un agente solo borra lo que nadie empezó (`proposed`, `todo`) y nunca una tarea de la que depende otra ya `done`; el humano, cualquiera. Las tareas que dependían de ella pierden esa dependencia y reciben una nota. El ID no se reutiliza. |
| `todo` → `doing` | A | `start`. Rechazado si está `blocked`. |
| `doing` → `todo` | A, H | `pause`, opcionalmente con una nota. |
| `doing` → `done` | A | `finish` con `summary`. |
| `done` → `todo` | **H** | `reopen`. |
| añadir `deps` | A, H | No en tareas `done`. Rechazado si crea un ciclo. |
| deshacer | **H** | `undo`: devuelve cada tarea que tocó una acción humana a su versión anterior (o la quita, si la acción la creó). Lleva, por tarea, la versión anterior y el hash que debe tener ahora; si alguna cambió entre medias, `conflict` y no se aplica nada. El daemon responde a cada op de la UI con su `undo`, y el aviso que sigue ofrece «Deshacer». |

**Sesión de planificación** (`konsora plan` o el panel de IA de la UI, con `KONSORA_PLAN=1` en el servidor MCP): el agente solo puede crear tareas (`propose`, `batch`), revisar, reordenar, enlazar, pasar a `todo` o borrar tareas que nadie empezó (`edit`, `move`, `depend`, `undepend`, `promote`, `demote`, `delete`). Todo lo demás da `out_of_scope`.

**Derivados**

- `blocked` = `state == todo` y alguna dependencia no está en `done`.
- `waiting` = la última nota `question` no tiene un `answer` posterior.
- `ready` = `todo` y no `blocked`.

**Git**: Konsora no ejecuta git. Las ramas, los commits y los merges del código los hace cada uno con su flujo de siempre; el plan se versiona con el código como cualquier otro fichero.

## 3. Validación

Hay dos niveles, ambos en `packages/core` y compartidos por la CLI, el MCP, el daemon y la UI:

1. **Estructural**: un esquema zod es la fuente de verdad, y de él se genera `schema/tasks.v5.schema.json` para editores y agentes que editen el archivo a mano. Los campos desconocidos se rechazan en la raíz y en las tareas, salvo bajo una clave `x-*`, que se conserva sin interpretarse.
2. **Semántica**: IDs únicos con prefijo igual a `group` (también frente a los de `archived`); `seq[g]` ≥ al mayor número usado, contando los archivados; deps existentes en el plan o archivadas; grupos existentes; sin ciclos (Kahn, iterativo); IDs de notas, criterios y plantillas únicos; claves JSON duplicadas rechazadas; tamaño ≤ 8 MiB.

Los errores se devuelven como `{path: JSON Pointer, code, message}`. Un archivo inválido **no se sobrescribe nunca**: Konsora pasa ese proyecto a solo lectura y muestra los errores hasta que se corrija.

## 4. Serialización canónica

Para conseguir diffs mínimos y escrituras byte-idénticas entre la CLI, el MCP y el daemon:

- Las claves van en el orden de este documento. Detrás van las claves de extensión `x-*`, en orden alfabético.
- Los campos opcionales vacíos se omiten (`deps: []`, `desc: ""`, `notes: []`…).
- Indentación de 2 espacios, LF, UTF-8 sin BOM, salto de línea final.
- Las tareas se ordenan en el array según el orden de `groups` y, dentro de cada grupo, por número de ID (orden natural: `BE-99` va antes que `BE-100`). Así, añadir una tarea es un *hunk* aislado. Las claves de `seq` siguen el orden de `groups`.
- `deps` va en orden natural de ID y `labels`, alfabéticamente. Las notas, los criterios, los grupos y las plantillas conservan su orden, porque ese orden tiene significado.
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
- Si es válido → se calcula el diff contra la instantánea y se buscan **cambios que exigen humano**: reabrir, saltos de estado que ningún agente puede dar (llegar a `done` sin una nota `summary` nueva, por ejemplo), editar tareas `done`, crear tareas directamente en `doing` o `done` y borrar tareas empezadas. Se cruzan con el **registro de aprobaciones** (`~/.local/share/konsora/projects/<id>/approvals.jsonl`, que solo escribe el daemon). Una transición sin registro se marca en la UI como **"cambio externo sin aprobar"**, con opciones de confirmarla o revertirla.

Límite honesto: un proceso con los permisos del usuario puede escribir cualquier archivo. Los roles se aplican en la CLI, el MCP y la UI, y las violaciones se **detectan y señalan**; no existe una frontera de seguridad contra un agente decidido a engañar.

## 6. Migraciones

Con `konsora migrate` (acción explícita; nunca automática al abrir). Por defecto solo muestra el resumen; `--write` guarda primero una copia del original y después escribe.

**`konsora/4` → `konsora/5`**: se quitan `blocks` y el `block` de cada tarea; el resto queda igual. El resumen lista los bloques quitados con su rama y si estaban integrados: Konsora no toca esas ramas, que siguen en git. La copia es `tasks.v4.json.bak`.

**`konsora/3` → `konsora/5`**: las tareas en `review` pasan a `done` con una nota de Konsora ("Migrated from review to done…"), se quita `yolo` y las propuestas (`proposed`) se quedan como ideas (lo que hacía la migración a `konsora/4`). La copia es `tasks.v3.json.bak`.

**`konsora/2` → `konsora/5`**: primero se descartan los campos de ejecución y después se aplica lo anterior. La copia es `tasks.v2.json.bak`.

| v2 | v5 |
|---|---|
| `schema: "konsora/2"` | `schema: "konsora/5"` (y `$schema` apunta a `tasks.v5`) |
| `project.base_branch`, `defaults`, `recommended`, `setup`, `checks`, `check_retries`, `reviewer` | Se descartan |
| `tasks[].agent`, `templates[].difficulty`, `tasks[].yolo` | Se descartan |
| `tasks[].difficulty` | Se conserva si es `low`, `medium` o `high` (desde CORE-22); otro valor se descarta |
| `acceptance[].check` (en tareas y plantillas) | Se descarta; el texto del criterio se conserva |
| `notes[].run` | Se descarta |
| Notas `review` con `verdict` | Pasan a `note` con el veredicto al principio del texto: `[review: approve] …` |
| `state: "review"` | `done`, con una nota |

El resumen lista cuántas veces aparecía cada campo descartado y qué tareas pasaron de `review` a `done`.

**v1 (`schema_version: 1`, el v0) → `konsora/5`**:

| v1 | v5 |
|---|---|
| `schema_version: 1` | `schema: "konsora/5"` |
| `proposal / pending / in_progress / in_review / done` | `proposed / todo / todo + nota / done + nota / done` |
| `id` (p. ej. `K-031`) | Se conserva si cumple `GRUPO-NN`, con un grupo creado a partir del prefijo; si no lo cumple, se renumera y el ID antiguo queda en una nota |
| `acceptance_criteria` (texto) | Un elemento `acceptance` por línea de viñeta o por párrafo |
| `sort_order` | `rank` en el mismo orden |
| `attempts`, `activity`, `reviews` | Se mueven tal cual a `.konsora/legacy/v1-history.json` |

La copia es `tasks.v1.json.bak`.

## 7. Archivo de tareas hechas

Las tareas hechas se quedan en `tasks.json` con todas sus notas, así que el fichero (y el contexto que consumen los agentes al leerlo) solo crece. `konsora archive --before <fecha>` mueve las tareas hechas cuyo cierre (su último `summary`, o `updated_at` si no tiene) es anterior a esa fecha (`YYYY-MM-DD`, en UTC, o una marca de tiempo UTC) a `.konsora/archive.json`, tal como estaban. Es una acción explícita: sin `--write` solo muestra lo que movería.

```json
{
  "schema": "konsora-archive/1",
  "tasks": [ { "id": "BE-01", "title": "…", "state": "done", "…": "…" } ]
}
```

- Sus IDs se añaden a `archived` en `tasks.json`: las dependencias sobre ellas cuentan como hechas y los IDs no se reutilizan.
- Solo contiene tareas `done`, sin IDs repetidos, en orden natural de ID y con la misma serialización canónica que las tareas del plan. Se lee con un límite de 64 MiB (no lo cargan los agentes).
- Se escribe bajo el lock del plan: primero el archivo y después `tasks.json`. Si la segunda escritura no llega a hacerse, las tareas quedan en los dos ficheros y volver a ejecutar el comando termina el trabajo.
- `konsora show <ID>` (y la herramienta `show` del MCP) y el Historial de la UI siguen mostrando las tareas archivadas, marcadas como tales. No se pueden cambiar ni reabrir.
- El daemon no marca como "cambio externo" la salida de una tarea hecha del plan cuando su ID pasa a `archived`.
