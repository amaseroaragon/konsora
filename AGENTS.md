# Konsora — Guía para agentes de desarrollo

## Producto
Konsora es una aplicación de escritorio **local-first**, inicialmente para Ubuntu, que unifica el trabajo con distintos modelos y agentes de IA.

Capacidades objetivo: proyectos y chats, memoria persistente compartida, deliberación entre modelos, tareas y dependencias, ejecución supervisada y trazabilidad. **No** se pretende construir todo en la primera versión.

## Forma de trabajar

1. Lee `TASKS.md` antes de empezar. Ejecuta tareas pendientes **en orden**, una por vez; prioriza las marcadas como **MVP**. No implementes funcionalidades futuras por anticipado.
2. Si el repositorio está vacío, empieza por la tarea `K-001`. Mantén la aplicación ejecutable al finalizar cada tarea.
3. Para cada tarea: inspecciona el código existente, implementa el cambio mínimo, añade o ajusta pruebas, ejecuta las comprobaciones pertinentes y actualiza su casilla en `TASKS.md` **solo cuando se cumplan sus criterios de aceptación**.
4. Resume al terminar: cambios realizados, pruebas ejecutadas y resultado, decisiones o riesgos, y siguiente tarea pendiente. Si el entorno permite commits, realiza commits pequeños y descriptivos; no publiques ni hagas push sin aprobación.
5. Si una tarea requiere credenciales, gastos, permisos, decisiones de producto importantes o una acción destructiva, **detente y consulta**. No inventes claves ni uses cuentas personales por tu cuenta.
6. No elimines código, historial o datos sin una razón explícita y comprobada. No escribas fuera del directorio del repositorio salvo autorización.
7. Prefiere implementaciones simples, tipadas y mantenibles. Evita frameworks, servicios, abstracciones y dependencias innecesarias. Explica brevemente cualquier dependencia nueva.
8. Cuando un criterio de aceptación no pueda probarse (p. ej., no hay claves API), documenta la limitación; no declares la tarea completada si falta lo esencial.

## Principios técnicos

- Aplicación de escritorio Ubuntu, con arquitectura modular y almacenamiento local.
- Propuesta inicial (ajustable si surge un impedimento demostrado): **Tauri + React + TypeScript** para escritorio; **Python + FastAPI** para orquestación e integraciones; **SQLite** para persistencia. Separa claramente los contratos frontend/backend.
- El backend debe escuchar únicamente en loopback y no exponer servicios públicamente por defecto. Antes de distribuir, asegurar la comunicación local y el ciclo de vida del proceso.
- Nunca incluyas API keys ni tokens en el código, commits, logs o archivos de ejemplo. Usa mecanismos seguros de almacenamiento de credenciales para la versión distribuible.
- Accede a modelos mediante **API oficiales** o herramientas **CLI oficiales compatibles**. No uses scraping ni mecanismos para eludir restricciones de suscripciones.
- La memoria compartida es **externa a los modelos** y pertenece a Konsora; no afirmes sincronizar automáticamente memorias nativas de proveedores.
- Los debates entre modelos deben tener número máximo de rondas, presupuestos configurables y registro de propuestas, objeciones y decisiones. No fuerces consenso artificial.
- Los agentes deben tener permisos mínimos; la ejecución de código o cambios significativos necesita un flujo de aprobación explícito.

## Calidad mínima

- Código legible, tipado cuando proceda, con errores gestionados y estados de carga/errores en UI.
- Pruebas de lógica y API; verificaciones manuales descritas para funcionalidad de escritorio.
- Comandos de desarrollo y puesta en marcha documentados en `README.md`.
- Toda funcionalidad tiene criterios verificables y no se marca como terminada solo porque «parezca funcionar».

## Alcance

Construir primero un flujo vertical completo: **crear proyecto → usar modelos por API → debatir entre dos modelos → guardar un plan y tareas**. Ampliar memoria, CLI y funciones avanzadas después.
