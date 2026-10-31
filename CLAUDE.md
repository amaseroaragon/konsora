# Konsora

Konsora es un gestor y lanzador de tareas para agentes de programación. Lee el plan de un proyecto desde `.konsora/tasks.json` y lo muestra en un tablero y en un grafo. Ejecuta las tareas seleccionadas con Claude Code o Codex, cada una en su propio worktree y en paralelo respetando dependencias. Después verifica el resultado y te deja revisarlo con su diff e integrarlo con un commit por tarea. Es local, de uso personal y para Ubuntu primero.

Documentación de referencia (léela antes de cambiar algo en su ámbito):
- [docs/vision.md](docs/vision.md): problema, flujo, principios y no-objetivos.
- [docs/arquitectura.md](docs/arquitectura.md): paquetes, daemon, runner, adaptadores, seguridad y ADR.
- [docs/esquema-tareas.md](docs/esquema-tareas.md): formato `konsora/2`, máquina de estados y roles, concurrencia y runs.
- [docs/roadmap.md](docs/roadmap.md): hitos M0–M10 con su criterio de "hecho".

## Estado actual

**M0, M1 y M2 cerrados.** `packages/core` está completo: esquema v2, validación, serializador canónico, grafo, máquina de estados con operaciones semánticas y almacén de archivos (`@konsora/core/store`, solo Node). `packages/web` tiene el sistema de diseño *Plano* y la maqueta navegable (`UI-04`). La CLI `konsora` (init, lectura, comandos de agente, `migrate`, `skill`) está en `packages/cli`. **Siguiente: M3 (daemon + tablero), empezando por `DMN-01`** (consulta `npx konsora status`).

El v0 que desarrolló Codex (Tauri + sidecar Python, MVP de "copiar prompt"), con su código y sus docs, solo existe en la etiqueta git `legacy-v0`. No lo restaures ni lo tomes como referencia, salvo para la migración v1→v2 (`CLI-03`).

El backlog se gestiona con la CLI del propio repo (`npx konsora …`, con `--as claude` o `KONSORA_AGENT`), siguiendo la skill `.claude/skills/konsora/SKILL.md`. Nunca edites `.konsora/tasks.json` a mano.

## Estructura

```
packages/core     esquema v2, máquina de estados, grafo, serializador canónico, store
packages/runner   adaptadores claude/codex, worktrees, scheduler, checks, integración git
packages/cli      binario `konsora` + `konsora mcp`
packages/daemon   servidor loopback (HTTP + WS)
packages/web      UI React
apps/desktop      Tauri (M10)
schema/           tasks.v2.schema.json generado desde core
```

Regla de capas: `web → daemon → runner → core` y `cli → runner, core` (y `cli → daemon` solo para `konsora ui`). **Ninguna regla de negocio fuera de `core`.**

## Comandos

```bash
npm ci
npm run check                  # biome + tsc --noEmit + vitest, en todos los paquetes
npm run format                 # aplica el formato y las correcciones seguras de Biome
npx vitest run packages/core   # tests de un paquete
```

Requisitos: Node ≥ 22.18 (ejecuta `.ts` directamente con *type stripping*, sin paso de build), git ≥ 2.38, y `claude` y/o `codex` instalados y autenticados (solo para los runs reales).

Los imports relativos llevan la extensión `.ts`, y solo se admite sintaxis TS borrable (`erasableSyntaxOnly`: sin `enum`, `namespace` ni parameter properties). Biome no formatea `.konsora/`, porque ese archivo lo escribe el serializador canónico de `core`.

## Forma de trabajar

1. **El backlog es `.konsora/tasks.json`** (v2 desde M0). Trabaja una tarea a la vez, en orden de `rank` y respetando las dependencias. Una tarea pendiente no autoriza implementarla: hazlo solo si te lo piden. No adelantes funciones de hitos posteriores.
2. **"Hecho" = criterio verificable.** Cumple los `acceptance` de la tarea (o el ✅ del hito en `roadmap.md`), ejecuta las comprobaciones y anota en el commit qué ejecutaste y con qué resultado. Si no puedes verificar algo esencial, dilo y no lo des por hecho.
3. **Tus permisos sobre el plan son los de un agente.** Puedes proponer, empezar, anotar, preguntar y terminar con resumen. **No apruebes, aceptes ni marques `done`**: esas acciones son humanas.
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
- **Credenciales**: Konsora no lee, guarda ni transmite tokens ni claves. Usa los CLI oficiales con el login del usuario y nunca recurre a APIs de pago por su cuenta.
- **Ejecución**: solo lanza lo que el humano selecciona explícitamente. Usa un worktree por run, el perfil de permisos `default` y nunca flags `--dangerously-*`. El prompt de cada run queda registrado.
- **Git**: integrar significa hacer squash local en `base_branch`, con un commit por tarea. Nunca push, PR ni force.
- El daemon escucha solo en loopback, con token y validación de Host y Origin.
- Fuera de alcance: chat, debates entre modelos, gestión de cuentas, nube y distribución pública. Ver los no-objetivos en `vision.md`.
