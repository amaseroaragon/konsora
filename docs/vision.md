# Visión

## En una frase

Konsora es el **tablero de control de tus agentes de programación**: planificas las tareas de un proyecto con ellos, eliges cuáles ejecutar y con qué modelo, Konsora las lanza aisladas y en paralelo respetando las dependencias, y tú revisas e integras cada resultado con su diff.

## Problema

Trabajar con agentes como Claude Code o Codex sobre un proyecto real crea fricción en cuatro puntos:

1. **El plan se pierde.** Vive en una conversación que acaba o se compacta. Hace falta un plan persistente, versionado con el código y legible tanto por las personas como por los agentes.
2. **Ejecutar es manual y en serie.** Copiar el contexto, abrir una terminal, esperar y repetir. Nada impide lanzar dos tareas que se pisan ni empezar una cuyas dependencias no están listas.
3. **El agente se aprueba a sí mismo.** Sin un reparto de roles, un agente puede marcar como hecho lo que tú no has revisado.
4. **No queda rastro.** Qué modelo hizo qué, con qué prompt, qué comandos ejecutó, cuánto costó y por qué falló.

[Kanvas](https://github.com/XMihura/Kanvas) resuelve bien los puntos 1 y 3: un plan en JSON, una máquina de estados y roles para humano y agente. Pero no lanza agentes, no aísla ejecuciones ni guarda su historial. Konsora parte de esas ideas y se centra en los puntos 2 y 4.

## Usuario

Una persona desarrolladora (de momento, el propio autor) en Ubuntu, con suscripciones a Claude y ChatGPT y sus CLI ya instalados y autenticados, que trabaja en varios repositorios locales.

## Flujo principal

1. **Vincular**: añades una carpeta. Konsora solo la lee. `konsora init` crea `.konsora/tasks.json` cuando tú lo pides.
2. **Planificar**: un agente (lanzado desde Konsora o en tu terminal) te entrevista y propone tareas en lote, con dependencias y criterios de aceptación. Aparecen como `proposed`.
3. **Aprobar**: revisas las propuestas en el tablero o en el grafo, editas lo que haga falta y apruebas.
4. **Ejecutar**: seleccionas tareas, eliges proveedor, modelo y esfuerzo (o usas los valores por defecto del proyecto o de la tarea) y pulsas Ejecutar. Cada tarea corre en su propio worktree y rama, en paralelo hasta el límite que fijes y siempre en orden de dependencias.
5. **Supervisar**: sigues el log en vivo, respondes a las preguntas y aprobaciones que pidan los agentes y cancelas si hace falta.
6. **Verificar**: al terminar, Konsora ejecuta los checks del proyecto y de cada criterio. Si alguno falla, puede devolver el trabajo al agente automáticamente.
7. **Revisar e integrar**: ves el diff, los checks y el resumen. **Aceptar** hace un squash local: un commit por tarea. **Devolver** deja tu feedback como nota para el siguiente intento.

## Principios

- **Los archivos del proyecto son la fuente de verdad.** El plan es un JSON canónico y legible, versionado en git y editable sin Konsora. Konsora detecta cualquier cambio.
- **Los agentes proponen y tú decides.** Aprobar, aceptar y dar por hecho son acciones humanas. Konsora detecta y señala las violaciones, aunque no pueda impedir todas.
- **Aislamiento por defecto.** Cada ejecución corre en su worktree con permisos acotados. Nada toca tu árbol de trabajo hasta que aceptas.
- **Todo es explícito y auditable.** El prompt exacto de cada ejecución, sus eventos, su diff y sus checks quedan registrados. Konsora nunca añade trabajo ni contexto que no hayas seleccionado.
- **Local y sin credenciales.** Konsora usa los CLI oficiales con tu propio login. No guarda tokens, no usa APIs de pago por su cuenta y no hace push.
- **Un solo núcleo.** Las reglas viven en un único sitio y las comparten la UI, la CLI y el MCP.

## Konsora frente a Kanvas

| | Kanvas | Konsora |
|---|---|---|
| Plan en JSON con estados y roles | ✔ | ✔ (esquema v2 validado y con IDs que no se reutilizan) |
| Tablero y grafo | ✔ (HTML en el navegador) | ✔ |
| Lanzar agentes | — | ✔ Claude Code y Codex, con proveedor, modelo y esfuerzo por tarea |
| Aislamiento | — | Un worktree y una rama por ejecución |
| Paralelismo respetando dependencias | — | ✔ |
| Historial de ejecuciones | — | Eventos, prompt, uso, diff y checks |
| Verificación automática | — (`check` solo valida el archivo) | Checks por proyecto y por criterio |
| Integración | Manual | Squash local, un commit por tarea |
| Concurrencia | Lock que caduca a los 5 s; conflicto de archivo completo | Lock por PID, escritura atómica con `fsync`, fusión por tarea |
| Roles | `--as human` falsificable | Transiciones humanas solo en la UI, y detección de cambios externos |
| Canal de agentes | CLI + skill | CLI + skill + **MCP**, con identidad por ejecución |

## No-objetivos (por ahora)

- **Ni chat ni debates entre modelos.** Konsora orquesta tareas, no conversaciones.
- **No gestiona cuentas, logins ni claves.** Cada CLI gestiona su sesión.
- **No se distribuye públicamente.** Es una herramienta personal. Antes de publicarla habría que revisar los términos de uso: Anthropic no permite que productos de terceros ofrezcan el login de claude.ai sin aprobación. También habría que plantear el soporte multiplataforma y la UI en inglés.
- **Nada en la nube.** Ni ejecución remota ni sincronización entre máquinas.
- **No hace push, ni abre PRs ni despliega.**
- **No es un gestor de proyectos genérico.** No hay usuarios, permisos de equipo ni estimaciones.
