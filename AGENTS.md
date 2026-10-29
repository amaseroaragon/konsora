# Konsora — Guía para agentes de desarrollo

## Producto
Konsora es una aplicación de escritorio **local-first**, inicialmente para Ubuntu, que unifica el trabajo con distintos modelos y agentes de IA.

El acceso se realiza mediante **Codex CLI, Claude Code y, cuando exista un mecanismo oficialmente compatible, Antigravity**, aprovechando las suscripciones del usuario. Se empieza por Codex CLI con inicio de sesión de ChatGPT. **No integrar APIs de pago ni usarlas como alternativa automática.**

Capacidades objetivo: proyectos y chats, memoria persistente compartida, deliberación entre modelos, tareas y dependencias, ejecución supervisada y trazabilidad. **No** se pretende construir todo en la primera versión.

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
- Propuesta inicial (ajustable si surge un impedimento demostrado): **Tauri + React + TypeScript** para escritorio; **Python + FastAPI** para orquestación e integraciones; **SQLite** para persistencia. Separa claramente los contratos frontend/backend.
- El backend debe escuchar únicamente en loopback y no exponer servicios públicamente por defecto. Antes de distribuir, asegurar la comunicación local y el ciclo de vida del proceso.
- Cada herramienta oficial gestiona su propio inicio de sesión y puede mantener o renovar su almacén local de credenciales. Konsora no lee, copia ni exporta esos archivos ni recibe tokens en la UI; no incluyas secretos en código, commits, logs o ejemplos.
- Usa únicamente mecanismos oficiales que permitan expresamente la integración con la suscripción correspondiente. La existencia de un modo headless no demuestra que pueda envolverse en aplicaciones de terceros. Comprueba documentación y condiciones antes de implementar cada conector; documenta los bloqueos sin sustituirlos por APIs de pago, scraping, endpoints privados, extracción de OAuth o rotación de cuentas.
- El primer conector es Codex CLI con sesión de ChatGPT. Rechaza la autenticación por API y no heredes claves del entorno. Las pruebas reales pueden consumir la cuota de suscripción ya autorizada para esta integración; nunca compres créditos ni actives consumo adicional.
- En K-003 solo se envían prompts de texto: sin herramientas, comandos ni cambios en proyectos. Usa procesos sin shell, permisos mínimos, tiempo y salida acotados y limpieza al cancelar. La ejecución supervisada de tareas sigue en K-011.
- La memoria compartida es **externa a los modelos** y pertenece a Konsora; no afirmes sincronizar automáticamente memorias nativas de proveedores.
- Los debates entre modelos deben tener número máximo de rondas, presupuestos configurables y registro de propuestas, objeciones y decisiones. No fuerces consenso artificial.
- Los agentes deben tener permisos mínimos; la ejecución de código o cambios significativos necesita un flujo de aprobación explícito.

## Calidad mínima

- Código legible, tipado cuando proceda, con errores gestionados y estados de carga/errores en UI.
- Pruebas de lógica y API; verificaciones manuales descritas para funcionalidad de escritorio.
- Comandos de desarrollo y puesta en marcha documentados en `README.md`.
- Toda funcionalidad tiene criterios verificables y no se marca como terminada solo porque «parezca funcionar».

## Alcance

Construir primero un flujo vertical completo: **crear proyecto → consultar Codex CLI con la suscripción → conversar → integrar un segundo CLI oficialmente compatible → debatir → guardar un plan y tareas**. Ampliar memoria y ejecución supervisada después.

Antigravity es un objetivo condicionado: su FAQ oficial actualmente excluye envolver `agy` en aplicaciones de terceros con planes de consumo. No implementarlo hasta que exista un mecanismo permitido para Konsora; documentar la fuente y revisar en su tarea específica.
