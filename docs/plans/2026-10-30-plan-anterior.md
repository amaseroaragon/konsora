> Archivo histórico, sustituido el 2026-10-30. Sus tareas pendientes ya no dirigen el desarrollo; consultar el [backlog JSON](../../.konsora/tasks.json). Se conserva como evidencia del trabajo anterior.

# Konsora — Plan de implementación

Este archivo es el backlog operativo. Marcar `[x]` únicamente cuando se cumplan los criterios de aceptación. **MVP** = primer producto utilizable. Las tareas están ordenadas por dependencia.

## MVP: primera versión funcional

### [x] K-001 — Inicializar el repositorio y la aplicación
- Crear estructura sencilla `apps/desktop` (Tauri + React + TypeScript) y `services/api` (Python + FastAPI), con gestión de dependencias y scripts de arranque.
- Añadir `.gitignore`, `.env.example` sin secretos y `README.md` con instrucciones para Ubuntu.
- Crear una pantalla de inicio de Konsora y endpoint `/health`.
- **Aceptación:** escritorio abre en Ubuntu; backend responde a `/health`; existen comandos claros para lanzar ambos en desarrollo.
- **Pruebas:** compilar/comprobar tipos de frontend, test básico de `/health`, arranque manual del escritorio.

### [x] K-002 — Persistencia local y gestión de proyectos
- Crear SQLite y esquema/migraciones mínimos para `projects` y entidades necesarias.
- Implementar crear, listar, renombrar, abrir y eliminar proyecto con confirmación explícita.
- **Aceptación:** los proyectos permanecen después de cerrar y abrir Konsora; errores de base de datos se gestionan sin perder datos.
- **Pruebas:** CRUD automatizado de proyectos y comprobación manual de persistencia.

### [x] K-003 — Conectar Codex CLI con la suscripción de ChatGPT
- Definir interfaz común para conectores CLI y un simulador local; implementar primero Codex CLI mediante su modo oficial no interactivo.
- Detectar instalación, versión compatible y sesión de ChatGPT mediante comandos oficiales. No leer archivos de autenticación ni solicitar claves. Rechazar login por API y eliminar claves del entorno del proceso hijo; sin fallback a APIs de pago.
- Ejecutar solo prompts de texto, por stdin y sin shell, con herramientas desactivadas, sandbox de solo lectura, directorio aislado y límites de tiempo/salida. No permitir cambios en proyectos ni habilitar permisos amplios para solventar fallos.
- Mostrar estado del conector, modelo predeterminado/configurado, carga, respuesta y errores controlados. El envío requiere confirmar el uso de cuota; no consumirla al consultar el estado.
- **Aceptación:** prompt y respuesta reales con sesión de ChatGPT, sin facturación por API; simulador para verificar sin cuota. K-001 y K-002 siguen funcionando y no se exponen tokens, diagnósticos ni credenciales del CLI.
- **Pruebas:** CLI falso/procesos reales locales para contratos, login por API rechazado, errores, límites, cancelación, salida segura y ausencia de herramientas; prueba real mínima con la sesión autorizada y verificación de UI.
- **Verificación 2026-10-29:** 72 pruebas, tipos y builds web/nativo correctos. UI → backend → Codex CLI 0.165.0 → sesión de ChatGPT devuelve `KONSORA_CLI_OK`; cancelación y errores probados con CLI falso, panel y cierre nativos verificados. Sin APIs de pago. Detalle en [verificación K-003](../verification/K-003.md).

### [x] K-004 — Conversaciones por proyecto
- Crear conversaciones y mensajes persistentes asociados a un proyecto.
- Interfaz para abrir chats, enviar mensajes, escoger modelo y consultar historial; incluir estados de carga y error.
- Selector de modelo mediante desplegable alimentado por el catálogo oficial de Codex y estado compacto del conector, sin panel de prompts de prueba.
- **Aceptación:** una conversación continúa tras reiniciar la aplicación y no mezcla mensajes de distintos proyectos.
- **Pruebas:** aislamiento por proyecto, orden de mensajes, persistencia y prueba manual de UI.
- **Verificación 2026-10-29:** 100 pruebas correctas, tipos y builds web/nativo correctos. Historial y modelo por chat persistentes y aislados; continuidad probada con Codex real tras reiniciar API e interfaz, y recuperación del historial al reiniciar escritorio Ubuntu. Detalle en [verificación K-004](../verification/K-004.md).
- **Ajuste de interfaz 2026-10-29:** desplegable con catálogo real del CLI y conservación de modelos guardados; panel de prueba sustituido por estado compacto y comprobación sin inferencia. 111 pruebas correctas, builds web/nativo y UI verificados. Cuotas planificadas en K-008 y previsión de tareas en K-011.

### [ ] K-005 — Deliberación independiente y Claude Code, por fases

- **Plan de trabajo (2026-10-30):** el usuario aún no tiene suscripción de Claude. Empezar por K-005A, verificable sin cuenta ni consumo de cuota; dejar pendiente la integración y validación real de K-005B. No es necesario contratar Claude para trabajar en K-005A.
- K-005 se marca como completada **solo cuando ambas fases cumplan sus criterios**. Completar la simulación no acredita que Claude funcione ni que sus condiciones permitan la integración.

#### [x] K-005A — Debate persistente con simuladores, sin suscripción

1. Inspeccionar y reutilizar los contratos de conectores, la persistencia y el aislamiento por proyecto de K-003/K-004; no modificar el flujo de chats existente ni implementar todavía rondas, síntesis o tareas.
2. Crear el debate asociado al proyecto y fijar su problema y contexto autorizado al iniciarlo. Guardar por separado cada participante, con identidad de conector/modelo, indicación de simulación, fechas, estado, propuesta y error cuando corresponda.
3. Obtener una propuesta inicial por participante a partir del **mismo problema y contexto**, sin incluir la propuesta del otro ni compartir resultados durante esta fase. Usar dos conectores simulados distintos para comprobarlo, sin lanzar Codex ni Claude reales en el modo simulado.
4. Añadir la pantalla «Debate» con un modo simulado explícito, estados de carga, resultados individuales, errores y cancelación. Mantener la propuesta terminada si el otro participante falla o se cancela; no reenviar automáticamente.
5. Mostrar Claude Code como **no disponible / pendiente de configurar y validar**. Identificar las respuestas de prueba como «Simulado A» y «Simulado B»; nunca presentarlas como respuestas reales de Claude. El modo real queda deshabilitado mientras falte el segundo conector validado.

- **Aceptación:** se crea y consulta un debate simulado por proyecto; ambas propuestas, su procedencia y sus estados permanecen tras reiniciar. Ningún resultado simulado se confunde con uno real, no se mezclan proyectos ni se consume cuota de suscripción. Los chats de K-004 siguen funcionando.
- **Pruebas:** comprobar las entradas recibidas por cada simulador para demostrar igualdad de contexto y ausencia de propuestas ajenas; persistencia y orden, aislamiento por proyecto, fallo parcial, cancelación y conservación del resultado válido. Ejecutar regresión de chats, tipos, builds web/nativo y verificación manual de la UI y del historial tras reiniciar.
- **Verificación 2026-10-30:** 146 pruebas correctas, tipos y builds web/nativo correctos. UI → API → SQLite comprobado con simuladores, incluyendo cancelación parcial, fallo individual y reinicio forzado de API; historial y chat anterior recuperados en dos arranques nativos con reinicio de API. Sin cuotas ni CLIs reales. Detalle en [verificación K-005A](../verification/K-005A.md). K-005B y K-005 continúan pendientes.

#### [ ] K-005B — Claude Code oficial y validación real, pendiente de suscripción

- **Requisitos antes de activar:** suscripción con acceso a Claude Code y un mecanismo oficialmente permitido para el uso desde Konsora. Si falta alguno, documentar el bloqueo y mantener esta fase pendiente, sin contratar servicios ni activar APIs de pago.
- Revisar las [condiciones de integración y autenticación](https://code.claude.com/docs/en/legal-and-compliance) y el [modo programático oficial](https://code.claude.com/docs/en/headless) antes de implementar el adaptador. No asumir que el Agent SDK o cualquier modo headless admiten login de suscripción; registrar la versión, el mecanismo elegido y sus limitaciones.
- Implementar el conector sobre el CLI oficial sin modificarlo, con login gestionado por la herramienta. Konsora no recibe, lee ni copia credenciales; no usa endpoints privados ni fallback a APIs de pago. Si las condiciones no permiten el caso de uso, detener esta fase y documentarlo.
- Detectar instalación, compatibilidad y sesión; aplicar permisos mínimos para consultas de texto, sin herramientas ni cambios en proyectos, con procesos sin shell, tiempo/salida acotados, errores controlados y limpieza al cancelar. Añadir pruebas con un CLI falso sin consumir cuota.
- Cuando se cumplan los requisitos, comprobar un prompt breve y después un debate real Codex + Claude con contexto idéntico y propuestas independientes. El usuario debe confirmar los envíos que consuman cuota; nunca comprar créditos ni activar consumo adicional.
- **Aceptación:** ambas propuestas reales se reciben y persisten con identidades correctas; errores y cancelación se gestionan por participante, sin exponer credenciales. La UI distingue debates reales y simulados, y la integración oficial queda documentada y comprobada con la sesión del usuario.
- **Pruebas:** contrato del CLI falso, instalación/login ausentes, autenticación no compatible, fallos de red/cuota, límites y cancelación; prueba real de prompt/respuesta y de debate por proyecto, incluyendo recuperación del historial tras reiniciar.
- **Cierre:** actualizar el informe de verificación y marcar K-005B y K-005 únicamente tras superar la prueba real. No declarar terminado el MVP con la validación de Claude pendiente.

### [ ] K-006 — Rondas de debate y síntesis
- **Dependencia:** K-005A y K-005B completadas; la simulación por sí sola no desbloquea K-006.
- Añadir revisión cruzada y hasta 2 rondas por defecto (configurable), límites de uso y parada por error o presupuesto.
- Generar síntesis estructurada: solución propuesta, argumentos, desacuerdos, riesgos, decisiones pendientes y plan sugerido.
- El plan queda en estado `draft` hasta aprobación humana; no se ejecuta código automáticamente.
- **Aceptación:** un usuario puede seguir las rondas, ver desacuerdos y aprobar o rechazar el plan.
- **Pruebas:** límites de rondas, fallo parcial, cancelación, ausencia de consenso y validación del formato final.

### [ ] K-007 — Convertir el plan aprobado en tareas
- Añadir tareas asociadas a proyectos, con título, descripción, estado y criterios de aceptación.
- Transformar una síntesis aprobada en tareas editables (sin ejecutar agentes).
- **Aceptación:** las tareas se muestran, editan y persisten; ninguna tarea se crea automáticamente a partir de un plan rechazado.
- **Pruebas:** conversión estructurada, aprobación/rechazo y persistencia.

### [ ] K-008 — Estabilizar y documentar el MVP
- Añadir pruebas de integración del flujo proyecto → chat → debate → aprobación → tareas.
- Corregir problemas de inicio, persistencia y gestión de errores; comprobar que no se registran secretos.
- Documentar compatibilidad y límites de las suscripciones, requisitos de las herramientas oficiales y ausencia de sincronización de chats nativos; sin APIs de pago ni fallback de facturación.
- Mostrar cuota restante de la cuenta y próximo reinicio de las ventanas que exponga oficialmente cada conector (p. ej., 5 horas y semanal). Presentarla en una zona común, con fecha de actualización; no atribuirla a un proyecto ni asumir ventanas idénticas para todas las cuentas/modelos.
- Consultar cuotas solo mediante mecanismos oficiales del CLI, sin inferencias, lectura de credenciales ni endpoints privados. Para Codex, revisar [`account/rateLimits/read`](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt). Mostrar «no disponible» si no se puede consultar, sin inventar porcentajes ni activar consumo adicional. Actualizar tras envíos y permitir refresco manual con frecuencia acotada.
- **Aceptación:** existe un flujo completo reproducible en Ubuntu y un README que permite levantarlo desde cero; se distinguen cuota restante, reinicio, datos desactualizados y datos no disponibles, teniendo en cuenta uso de la cuenta fuera de Konsora.
- **Pruebas:** suite automatizada y checklist de prueba manual; cuotas simuladas de varias ventanas/modelos, ventanas ausentes, errores, datos obsoletos y actualización sin consumir cuota de inferencia.

## Posterior al MVP (no implementar aún)

### [ ] K-009 — Memoria compartida por proyecto
- Notas, documentos y decisiones con procedencia; búsqueda textual FTS5 y recuperación contextual.
- **Aceptación:** los modelos reciben únicamente fragmentos autorizados, relevantes y trazables; se puede inspeccionar qué contexto se usó.

### [ ] K-010 — Tablero visual y dependencias
- Vistas Kanban y grafo de dependencias de tareas, inspiradas en Kanvas, valorando reutilización con licencia compatible.
- **Aceptación:** gestión visual sin ciclos de dependencia y estados consistentes.

### [ ] K-011 — Agentes CLI y ejecución supervisada
- Ampliar los conectores de consulta existentes con ejecución supervisada; definir permisos, límites y aprobaciones explícitas antes de escribir o ejecutar código.
- Antes de lanzar una tarea, consultar las cuotas de K-008 y estimar el consumo según modelo, contexto, alcance y experiencia de tareas anteriores cuando exista. Comparar con un margen de reserva configurable y advertir cuando la cuota pueda ser insuficiente; permitir posponer, reducir alcance o escoger otro modelo con aprobación humana.
- Presentar la previsión como estimación con incertidumbre, sin garantizar que la tarea terminará dentro de la cuota. La ventana de 5 horas no representa horas de ejecución disponibles. Si faltan datos o están obsoletos, mostrarlo explícitamente, sin suponer cuota ilimitada ni comprar créditos o cambiar a APIs de pago.
- **Aceptación:** una tarea aprobada puede delegarse y deja un historial verificable de operaciones y resultados; antes de lanzarla se muestran cuota consultada, estimación, incertidumbre y reserva, y los avisos requieren una decisión explícita del usuario.
- **Pruebas:** estimaciones simuladas por modelo/tarea, reserva configurable, cuota insuficiente/agotada, cambios de cuota entre planificación y lanzamiento, datos ausentes/obsoletos y ausencia de ejecución o gasto automático.

### [ ] K-012 — Empaquetado y distribución Ubuntu
- Integrar inicio/parada segura del backend y procesos CLI con Tauri, autenticación local del servicio, respeto al almacenamiento de credenciales de cada CLI, instalador y pruebas en una instalación limpia.
- **Aceptación:** un usuario de Ubuntu puede instalar y usar Konsora sin ejecutar servicios manualmente.

### [ ] K-013 — Compatibilidad oficial de Antigravity
- Objetivo: incorporar Antigravity mediante un mecanismo que permita expresamente usar la suscripción desde Konsora. No implementar endpoints privados, copiar tokens, rotar cuentas ni sustituirlo por una API de pago.
- **Bloqueo conocido (2026-10-29):** la [FAQ oficial](https://antigravity.google/docs/faq/) indica que envolver Antigravity CLI en aplicaciones de terceros no está soportado con planes de consumo. El modo headless para scripts/CI no autoriza ese uso.
- **Aceptación:** documentación oficial que permita el caso de Konsora, permisos y límites identificados y prueba real con la suscripción. Mientras no exista, mantener pendiente y explicar la incompatibilidad.

## Decisiones abiertas (solo resolver cuando bloqueen una tarea)

- Distribución inicial: desarrollo con dos procesos locales; empaquetado integrado en K-012.
- Primer conector decidido: Codex CLI y login de ChatGPT; después Claude Code si sus condiciones permiten la integración. Antigravity queda condicionado a K-013.
- El login y sus credenciales pertenecen a cada CLI. Antes de distribuir, asegurar comunicación local y ciclo de vida de sus procesos.
- Modelos y límites de suscripción: usar los disponibles para la cuenta, configurar sin fijar modelos ni asumir cuota ilimitada. No activar APIs de pago.

## Registro breve de progreso

| Fecha | Tarea | Resultado / bloqueos |
| --- | --- | --- |
| 2026-10-28 | K-001 | Completada: Tauri + React + TypeScript y FastAPI; tipos y builds web/nativo correctos, 6 pruebas de API correctas y arranque/conexión/error/recuperación/cierre verificados en Ubuntu. Detalle en [verificación K-001](../verification/K-001.md). Siguiente: K-002. |
| 2026-10-29 | K-002 | Completada: SQLite con migraciones transaccionales y gestión de proyectos con borrado confirmado; 31 pruebas correctas, tipos y builds web/nativo correctos. CRUD y recuperación ante bloqueo probados en interfaz; persistencia verificada al reiniciar API y escritorio Ubuntu. README abreviado. Detalle en [verificación K-002](../verification/K-002.md). Siguiente: K-003. |
| 2026-10-29 | K-003 (API) | Revertida por petición del usuario mediante `git revert d4a8a77`, commit `0cabaf4`. El árbol volvió exactamente al estado de K-002, conservando su historial y K-001. |
| 2026-10-29 | Cambio de enfoque | Sin APIs de pago: Codex CLI, Claude Code y Antigravity solo mediante mecanismos oficiales compatibles con suscripciones. K-003 se rehace empezando por Codex; Antigravity tiene una incompatibilidad documentada en K-013. |
| 2026-10-29 | K-003 (CLI) | Completada con Codex CLI y sesión de ChatGPT: prueba real satisfactoria desde la UI, simulador y 72 pruebas correctas, builds web/nativo y apertura/cierre de escritorio correctos. Credenciales gestionadas por el CLI, sin login por API ni ejecución de herramientas. Siguiente: K-004. |
| 2026-10-29 | K-004 | Completada: chats por proyecto, mensajes ordenados y contexto persistente, modelo por conversación, errores y cancelación. 100 pruebas y builds correctos; continuidad real con ChatGPT después de reiniciar, aislamiento en UI e historial recuperado en escritorio Ubuntu. Sin dependencias nuevas ni APIs de pago. Siguiente: K-005. |
| 2026-10-29 | Ajuste K-004 | Desplegable de modelos desde catálogo oficial y estado compacto sin panel de prueba. 111 pruebas, builds web/nativo y UI correctos; catálogo real verificado sin inferencias. Cuotas restantes y reinicios previstos para K-008; previsión de consumo y reserva antes de tareas para K-011. Siguiente: K-005. |
| 2026-10-30 | Plan K-005 | Dividida en K-005A (debate persistente y pruebas con dos simuladores explícitos, sin suscripción) y K-005B (Claude Code oficial y validación real, pendiente de suscripción y compatibilidad). Solo planificación; ambas fases siguen sin implementar. Siguiente: K-005A. K-006 conserva la dependencia de K-005 completa. |
| 2026-10-30 | K-005A | Completada: debates simulados por proyecto, contexto fijado y propuestas independientes persistentes, errores individuales, cancelación y recuperación tras interrupción. 146 pruebas, builds web/nativo y UI correctos; chats conservados. La regresión detectó y permitió corregir una espera del supervisor de CLI al superar la salida. Sin dependencias nuevas ni uso de cuotas. Siguiente: K-005B, pendiente de suscripción y compatibilidad oficial; K-005 y K-006 no se dan por completadas. |
