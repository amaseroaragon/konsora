# Visión

## En una frase

Konsora es un **gestor y visualizador de tareas para proyectos que se trabajan con agentes de programación**. Lo instalas en un proyecto, las IAs lo usan como plantilla para planificar y avanzar, y tú ves y gobiernas ese plan en una UI con tablero y grafo.

## Problema

Trabajar con agentes como Claude Code sobre un proyecto real crea fricción en tres puntos:

1. **El plan se pierde.** Vive en una conversación que acaba o se compacta. Hace falta un plan persistente, versionado con el código y legible tanto por las personas como por los agentes.
2. **Cada agente se organiza a su manera.** Sin una plantilla común, cada sesión inventa su propio formato de tareas, criterios y notas, y no hay forma de ver el conjunto.
3. **El trabajo de varios pasos se integra sin control.** Un cambio que necesita varias tareas acaba mezclado en la rama principal tarea a tarea, sin un punto en el que decidas si entra.

[Kanvas](https://github.com/XMihura/Kanvas) resuelve bien estos puntos con un plan en JSON, una máquina de estados y roles para humano y agente. Konsora parte de esas ideas y se centra en la **plantilla** (un formato estricto, una CLI, un MCP y una skill que las IAs siguen) y en la **UI** para verlo y gestionarlo.

Konsora **no ejecuta agentes**: tú los usas como siempre, en tu terminal o en tu editor, y ellos leen y actualizan el plan a través de Konsora. Una versión anterior lanzaba runs en worktrees con checks, colas e integración; se retiró porque esa parte la cubren mejor los propios agentes.

## Usuario

Una persona desarrolladora (de momento, el propio autor) en Ubuntu, con Claude Code instalado y autenticado, que trabaja en varios repositorios locales.

## Flujo principal

1. **Instalar**: `konsora init` en la carpeta del proyecto crea `.konsora/tasks.json`, la skill de Claude Code (`.claude/skills/konsora/SKILL.md`) y la entrada del servidor MCP en `.mcp.json`. La CLI global se instala una vez con `npm run install:global` desde este repo.
2. **Planificar**: una sesión de Claude (en tu terminal, con `konsora plan`, o en el panel de IA de la UI) te entrevista y crea las tareas en lote, con dependencias y criterios de aceptación, directamente en «Por hacer». Las tareas dependientes que deben integrarse juntas van en un **bloque**, con su propia rama. Las ideas sueltas quedan en «Ideas».
3. **Ajustar**: en el tablero o en el grafo editas, creas o eliminas tareas, mueves ideas a «Por hacer» y organizas los bloques. No hay nada que aprobar.
4. **Trabajar**: le pides a tu agente que avance. Siguiendo la skill, toma una tarea lista, la empieza (en la rama de su bloque si lo tiene), anota el progreso, pregunta cuando necesita una decisión y la termina con un resumen: pasa a «Hecho». Todo aparece en la UI en vivo.
5. **Integrar**: cuando todas las tareas de un bloque están hechas, revisas la rama y pulsas **Merge** en la vista de bloques: Konsora hace el merge local en la rama base (squash o merge commit), sin push. Es tu único punto de aprobación.

## Principios

- **Los archivos del proyecto son la fuente de verdad.** El plan es un JSON canónico y legible, versionado en git y editable sin Konsora. Konsora detecta cualquier cambio.
- **Los agentes trabajan y tú integras.** Los agentes crean, empiezan y terminan tareas sin pedir permiso; integrar un bloque, reabrir y cambiar trabajo hecho son acciones tuyas. Konsora detecta y señala las violaciones, aunque no pueda impedir todas.
- **Una plantilla, varios canales.** Las mismas reglas valen para la CLI, el MCP y la UI, porque viven en un único núcleo.
- **Local y sin credenciales.** El panel de IA usa tu propio Claude Code con tu login. Konsora no guarda tokens ni usa APIs de pago por su cuenta.
- **Abrir no escribe.** Vincular o abrir un proyecto solo lo lee; `init`, `migrate` y cualquier cambio del plan son acciones explícitas.

## No-objetivos (por ahora)

- **No ejecuta ni orquesta agentes.** Ni runs, ni worktrees, ni checks, ni colas. De git solo hace el merge local de un bloque cuando lo pides; nunca push, PR ni force.
- **El chat es solo para planificar.** El panel de IA propone tareas; no es un asistente general ni hay debates entre modelos.
- **No gestiona cuentas, logins ni claves.** Cada CLI gestiona su sesión.
- **No se distribuye públicamente.** Es una herramienta personal. Antes de publicarla habría que revisar los términos de uso: Anthropic no permite que productos de terceros ofrezcan el login de claude.ai sin aprobación. También habría que plantear el soporte multiplataforma y la UI en inglés.
- **Nada en la nube.** Ni sincronización entre máquinas.
- **No es un gestor de proyectos genérico.** No hay usuarios, permisos de equipo ni estimaciones.
