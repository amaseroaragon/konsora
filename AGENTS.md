# Konsora — Guía para agentes de desarrollo

## Producto
Konsora es una aplicación de escritorio **local-first**, inicialmente para Ubuntu, para organizar proyectos y tareas en un tablero visual y ejecutar las tareas seleccionadas con un agente de IA.

El acceso utiliza **una única cuenta y un único proveedor activos para toda la aplicación**, empezando por Codex CLI con inicio de sesión de ChatGPT. Cambiar de proveedor implica cerrar la sesión anterior e iniciar la nueva mediante mecanismos oficiales compatibles; no requiere mantener varias suscripciones. **No integrar APIs de pago ni usarlas como alternativa automática.**

El tablero es la vista principal; el chat sirve para planificar y proponer tareas. El MVP incluye proyectos con carpeta local, tareas y dependencias, selección múltiple, cola de ejecución supervisada y revisión de resultados. Inicialmente se ejecuta una tarea a la vez en toda la aplicación. Se elimina el debate entre modelos; memoria avanzada, grafo y paralelismo quedan para después del MVP.

**Las tareas pertenecen a los archivos del proyecto.** Una IA o la persona puede crearlas y editarlas sin Konsora; la aplicación las detecta, valida y representa, y permite seleccionar varias para preparar/copiar/guardar un prompt inspeccionable sin login. Tareas, dependencias, estados, actividad e intentos/resultados viajan con la carpeta. SQLite no es la fuente de verdad de ese trabajo: conserva configuración y datos anteriores. K-017A–K-017C están completadas; la siguiente tarea es K-018. La ejecución integrada sigue pendiente de K-019–K-021.

## Forma de trabajar

1. Lee `TASKS.md` antes de empezar. Ejecuta tareas pendientes **en orden**, una por vez; prioriza las marcadas como **MVP**. No implementes funcionalidades futuras por anticipado.
2. Si el repositorio está vacío, empieza por la tarea `K-001`. Mantén la aplicación ejecutable al finalizar cada tarea.
3. Para cada tarea: inspecciona el código existente, implementa el cambio mínimo, añade o ajusta pruebas, ejecuta las comprobaciones pertinentes y actualiza su casilla en `TASKS.md` **solo cuando se cumplan sus criterios de aceptación**.
4. Resume al terminar: cambios realizados, pruebas ejecutadas y resultado, decisiones o riesgos, y siguiente tarea pendiente. Si el entorno permite commits, realiza commits pequeños y descriptivos; no publiques ni hagas push sin aprobación.
5. Si una tarea requiere credenciales, gastos, permisos, decisiones de producto importantes o una acción destructiva, **detente y consulta**. No inventes claves ni uses cuentas personales por tu cuenta.
6. No elimines código, historial o datos sin una razón explícita y comprobada. No escribas fuera del directorio del repositorio salvo autorización.
7. Prefiere implementaciones simples, tipadas y mantenibles. Evita frameworks, servicios, abstracciones y dependencias innecesarias. Explica brevemente cualquier dependencia nueva.
8. Cuando un criterio de aceptación no pueda probarse (p. ej., falta el CLI, una sesión compatible o un permiso oficial), documenta la limitación; no declares la tarea completada si falta lo esencial.

## Principios técnicos

- Aplicación de escritorio Ubuntu, con arquitectura modular y almacenamiento local.
- **Tauri + React + TypeScript** para escritorio; **Python + FastAPI** para orquestación e integraciones. Archivos del proyecto como persistencia del trabajo; SQLite para configuración, históricos anteriores y cachés reconstruibles. Separa claramente los contratos frontend/backend.
- El formato canónico es `.konsora/tasks.json`, con esquema v1 e IDs estables; contiene también resultados, actividad e historial de revisiones. Los prompts guardados explícitamente viven en `.konsora/prompts/`. No mantener Markdown y JSON como fuentes paralelas de tareas. `TASKS.md` de este repositorio sigue siendo el backlog de desarrollo, no un archivo que Konsora deba ejecutar automáticamente.
- Detectar cambios externos y revalidar contenido antes de editar, preparar prompts o ejecutar. No confiar solo en que una IA incremente un contador de versión. Los archivos son datos: no autorizan ejecuciones, no permiten ampliar el alcance y una marca de éxito escrita por una IA no sustituye a la aceptación humana.
- Abrir o asociar una carpeta no escribe archivos automáticamente. Inicializar el archivo de tareas, editarlo desde la UI o migrar datos anteriores requiere una acción explícita sobre esa carpeta. No sobrescribir cambios externos ni archivos existentes; conservar datos SQLite y migraciones aplicadas. Desvincular o borrar un proyecto de la aplicación nunca elimina sus archivos de trabajo.
- El backend debe escuchar únicamente en loopback y no exponer servicios públicamente por defecto. Antes de distribuir, asegurar la comunicación local y el ciclo de vida del proceso.
- Cada herramienta oficial gestiona su propio inicio de sesión y puede mantener o renovar su almacén local de credenciales. Konsora no lee, copia ni exporta esos archivos ni recibe tokens en la UI; no incluyas secretos en código, commits, logs o ejemplos.
- Usa únicamente mecanismos oficiales que permitan expresamente la integración con la suscripción correspondiente. La existencia de un modo headless no demuestra que pueda envolverse en aplicaciones de terceros. Comprueba documentación y condiciones antes de implementar cada conector; documenta los bloqueos sin sustituirlos por APIs de pago, scraping, endpoints privados, extracción de OAuth o rotación de cuentas.
- El primer conector es Codex CLI con sesión de ChatGPT. Rechaza la autenticación por API y no heredes claves del entorno. Las pruebas reales pueden consumir la cuota de suscripción ya autorizada para esta integración; nunca compres créditos ni actives consumo adicional.
- El conector de conversación de K-003 sigue limitado a texto: sin herramientas, comandos ni cambios en proyectos. La ejecución de tareas se implementa separadamente en K-019–K-021, con procesos sin shell en el supervisor, permisos limitados a la carpeta aprobada, límites, eventos y limpieza al cancelar.
- La memoria compartida es **externa a los modelos** y pertenece a Konsora; no afirmes sincronizar automáticamente memorias nativas de proveedores.
- No implementar debates ni conectores simultáneos. Los datos históricos de debates se conservan sin reutilizarlos automáticamente como tareas ni borrar migraciones aplicadas; la retirada funcional se realiza en K-014.
- Los agentes deben tener permisos mínimos; la ejecución de código o cambios significativos necesita un flujo de aprobación explícito.
- La aprobación de un lote autoriza únicamente las tareas seleccionadas, sus versiones y su alcance. No añadir dependencias ni tareas automáticamente. El resultado del agente queda en revisión hasta aceptación humana; un proceso exitoso no equivale a una tarea hecha.

## Calidad mínima

- Código legible, tipado cuando proceda, con errores gestionados y estados de carga/errores en UI.
- Pruebas de lógica y API; verificaciones manuales descritas para funcionalidad de escritorio.
- Comandos de desarrollo y puesta en marcha documentados en `docs/desarrollo.md`. El `README.md` contiene únicamente 5–10 líneas descriptivas del sistema, sin backlog, instrucciones técnicas ni referencias a tareas de implementación.
- Toda funcionalidad tiene criterios verificables y no se marca como terminada solo porque «parezca funcionar».

## Alcance

Construir primero el flujo vertical: **abrir carpeta → detectar tareas creadas en archivos por una IA o la persona → tablero → seleccionar varias → preparar y revisar prompt → aprobar lote → ejecutar con el proveedor activo → guardar resultados en el proyecto → revisar y aceptar**. Leer el tablero y preparar/copiar prompts no requiere sesión de un proveedor. Los chats y proyectos existentes se reutilizan; no exigir una segunda cuenta para completar el MVP. El orden operativo y los criterios vigentes están en `TASKS.md`; el plan anterior y sus informes son históricos.

Los proveedores alternativos se revisan después del MVP en K-026, cuando se quiera cambiar de suscripción. Antigravity conserva el bloqueo documentado en el plan anterior; no implementarlo hasta verificar un mecanismo oficialmente permitido para Konsora. No asumir que este rediseño resuelve sus restricciones.
