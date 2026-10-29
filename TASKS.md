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

### [ ] K-003 — Conexión a proveedores de modelos
- Definir interfaz `ModelProvider` común y un adaptador para **un** proveedor oficial mediante API (OpenAI **o** Anthropic, el que pueda probarse con credenciales disponibles).
- Añadir configuración local segura de credenciales; evitar registrar o devolver claves a la UI. No subir credenciales al repositorio.
- La UI debe mostrar proveedor/modelo disponibles y errores de autenticación/red.
- **Aceptación:** puede enviarse un prompt y recibirse respuesta; hay una implementación simulada para probar sin gastar tokens.
- **Pruebas:** tests de adaptador simulado y manejo de errores; test manual real solo si hay credenciales.

### [ ] K-004 — Conversaciones por proyecto
- Crear conversaciones y mensajes persistentes asociados a un proyecto.
- Interfaz para abrir chats, enviar mensajes, escoger modelo y consultar historial; incluir estados de carga y error.
- **Aceptación:** una conversación continúa tras reiniciar la aplicación y no mezcla mensajes de distintos proyectos.
- **Pruebas:** aislamiento por proyecto, orden de mensajes, persistencia y prueba manual de UI.

### [ ] K-005 — Segundo proveedor y deliberación independiente
- Implementar adaptador para un segundo proveedor oficial y una pantalla «Debate» por proyecto.
- Ejecutar dos propuestas **independientes** a partir del mismo problema y contexto, antes de compartirlas.
- **Aceptación:** se conservan por separado ambas propuestas con identidad del modelo, fecha y estado; se informa de errores individuales.
- **Pruebas:** tests con dos proveedores simulados que comprueben independencia y persistencia.

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
- Documentar limitaciones reales: APIs y suscripciones son distintas; la app no sincroniza chats nativos de terceros.
- **Aceptación:** existe un flujo completo reproducible en Ubuntu y un README que permite levantarlo desde cero.
- **Pruebas:** suite automatizada y checklist de prueba manual.

## Posterior al MVP (no implementar aún)

### [ ] K-009 — Memoria compartida por proyecto
- Notas, documentos y decisiones con procedencia; búsqueda textual FTS5 y recuperación contextual.
- **Aceptación:** los modelos reciben únicamente fragmentos autorizados, relevantes y trazables; se puede inspeccionar qué contexto se usó.

### [ ] K-010 — Tablero visual y dependencias
- Vistas Kanban y grafo de dependencias de tareas, inspiradas en Kanvas, valorando reutilización con licencia compatible.
- **Aceptación:** gestión visual sin ciclos de dependencia y estados consistentes.

### [ ] K-011 — Agentes CLI y ejecución supervisada
- Integrar herramientas CLI oficiales compatibles; definir permisos, límites y aprobaciones explícitas antes de escribir o ejecutar.
- **Aceptación:** una tarea aprobada puede delegarse y deja un historial verificable de operaciones y resultados.

### [ ] K-012 — Empaquetado y distribución Ubuntu
- Integrar inicio/parada segura del backend con Tauri, almacenamiento de credenciales del sistema, instalador y pruebas en una instalación limpia.
- **Aceptación:** un usuario de Ubuntu puede instalar y usar Konsora sin ejecutar servicios manualmente.

## Decisiones abiertas (solo resolver cuando bloqueen una tarea)

- Distribución inicial: desarrollo con dos procesos locales; empaquetado integrado en K-012.
- Primer proveedor a conectar: OpenAI o Anthropic según credenciales oficiales disponibles.
- Política de almacenamiento de credenciales y ciclo de vida del backend antes de distribuir.
- Modelos/precios específicos y límites por proveedor: configurar, no codificar en duro.

## Registro breve de progreso

| Fecha | Tarea | Resultado / bloqueos |
| --- | --- | --- |
| 2026-10-28 | K-001 | Completada: Tauri + React + TypeScript y FastAPI; tipos y builds web/nativo correctos, 6 pruebas de API correctas y arranque/conexión/error/recuperación/cierre verificados en Ubuntu. Detalle en [verificación K-001](docs/verification/K-001.md). Siguiente: K-002. |
| 2026-10-29 | K-002 | Completada: SQLite con migraciones transaccionales y gestión de proyectos con borrado confirmado; 31 pruebas correctas, tipos y builds web/nativo correctos. CRUD y recuperación ante bloqueo probados en interfaz; persistencia verificada al reiniciar API y escritorio Ubuntu. README abreviado. Detalle en [verificación K-002](docs/verification/K-002.md). Siguiente: K-003. |
