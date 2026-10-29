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
- **Verificación 2026-10-29:** 72 pruebas, tipos y builds web/nativo correctos. UI → backend → Codex CLI 0.165.0 → sesión de ChatGPT devuelve `KONSORA_CLI_OK`; cancelación y errores probados con CLI falso, panel y cierre nativos verificados. Sin APIs de pago. Detalle en [verificación K-003](docs/verification/K-003.md).

### [x] K-004 — Conversaciones por proyecto
- Crear conversaciones y mensajes persistentes asociados a un proyecto.
- Interfaz para abrir chats, enviar mensajes, escoger modelo y consultar historial; incluir estados de carga y error.
- Selector de modelo mediante desplegable alimentado por el catálogo oficial de Codex y estado compacto del conector, sin panel de prompts de prueba.
- **Aceptación:** una conversación continúa tras reiniciar la aplicación y no mezcla mensajes de distintos proyectos.
- **Pruebas:** aislamiento por proyecto, orden de mensajes, persistencia y prueba manual de UI.
- **Verificación 2026-10-29:** 100 pruebas correctas, tipos y builds web/nativo correctos. Historial y modelo por chat persistentes y aislados; continuidad probada con Codex real tras reiniciar API e interfaz, y recuperación del historial al reiniciar escritorio Ubuntu. Detalle en [verificación K-004](docs/verification/K-004.md).
- **Ajuste de interfaz 2026-10-29:** desplegable con catálogo real del CLI y conservación de modelos guardados; panel de prueba sustituido por estado compacto y comprobación sin inferencia. 111 pruebas correctas, builds web/nativo y UI verificados. Cuotas planificadas en K-008 y previsión de tareas en K-011.

### [ ] K-005 — Claude Code y deliberación independiente
- Verificar el mecanismo oficial permitido para integrar Claude Code con suscripción, sus condiciones y autenticación. No asumir que el Agent SDK admite credenciales de suscripción. Si el proveedor no permite el uso desde Konsora, documentar el bloqueo sin APIs de pago.
- Implementar el segundo conector compatible y una pantalla «Debate» por proyecto.
- Ejecutar dos propuestas **independientes** a partir del mismo problema y contexto, antes de compartirlas.
- **Aceptación:** se conservan por separado ambas propuestas con identidad del modelo, fecha y estado; se informa de errores individuales.
- **Pruebas:** tests con dos conectores simulados que comprueben independencia y persistencia, y validación real con suscripción cuando el mecanismo esté permitido.

### [ ] K-006 — Rondas de debate y síntesis
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
| 2026-10-28 | K-001 | Completada: Tauri + React + TypeScript y FastAPI; tipos y builds web/nativo correctos, 6 pruebas de API correctas y arranque/conexión/error/recuperación/cierre verificados en Ubuntu. Detalle en [verificación K-001](docs/verification/K-001.md). Siguiente: K-002. |
| 2026-10-29 | K-002 | Completada: SQLite con migraciones transaccionales y gestión de proyectos con borrado confirmado; 31 pruebas correctas, tipos y builds web/nativo correctos. CRUD y recuperación ante bloqueo probados en interfaz; persistencia verificada al reiniciar API y escritorio Ubuntu. README abreviado. Detalle en [verificación K-002](docs/verification/K-002.md). Siguiente: K-003. |
| 2026-10-29 | K-003 (API) | Revertida por petición del usuario mediante `git revert d4a8a77`, commit `0cabaf4`. El árbol volvió exactamente al estado de K-002, conservando su historial y K-001. |
| 2026-10-29 | Cambio de enfoque | Sin APIs de pago: Codex CLI, Claude Code y Antigravity solo mediante mecanismos oficiales compatibles con suscripciones. K-003 se rehace empezando por Codex; Antigravity tiene una incompatibilidad documentada en K-013. |
| 2026-10-29 | K-003 (CLI) | Completada con Codex CLI y sesión de ChatGPT: prueba real satisfactoria desde la UI, simulador y 72 pruebas correctas, builds web/nativo y apertura/cierre de escritorio correctos. Credenciales gestionadas por el CLI, sin login por API ni ejecución de herramientas. Siguiente: K-004. |
| 2026-10-29 | K-004 | Completada: chats por proyecto, mensajes ordenados y contexto persistente, modelo por conversación, errores y cancelación. 100 pruebas y builds correctos; continuidad real con ChatGPT después de reiniciar, aislamiento en UI e historial recuperado en escritorio Ubuntu. Sin dependencias nuevas ni APIs de pago. Siguiente: K-005. |
| 2026-10-29 | Ajuste K-004 | Desplegable de modelos desde catálogo oficial y estado compacto sin panel de prueba. 111 pruebas, builds web/nativo y UI correctos; catálogo real verificado sin inferencias. Cuotas restantes y reinicios previstos para K-008; previsión de consumo y reserva antes de tareas para K-011. Siguiente: K-005. |
