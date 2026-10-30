# Konsora — Plan de implementación

Rediseño solicitado por el usuario el **2026-10-30**: un espacio visual de proyectos y tareas, con selección múltiple y ejecución supervisada mediante **una única cuenta y un único proveedor activos**. Se elimina el debate y la necesidad de mantener varias suscripciones.

Este es el único backlog operativo. Ejecutar las tareas pendientes en el orden indicado, una por vez. Marcar `[x]` solo con aceptación y pruebas completas; documentar cualquier bloqueo esencial sin darlo por resuelto con simuladores. El avance de implementación se refleja en las casillas y los informes de verificación.

**Corrección de producto, 2026-10-30:** las tareas son archivos del proyecto que una IA puede crear/editar por su cuenta. Konsora es su interfaz de lectura, selección, preparación de prompts y ejecución supervisada. La implementación actual de K-016/K-017 usa SQLite y debe adaptarse antes de seguir con K-018. Esta corrección actualiza el plan; no afirma haber implementado todavía esa adaptación.

## Producto y recorrido principal

**Abrir carpeta → detectar tareas en archivos → ver tablero → seleccionar varias → preparar y revisar prompt → autorizar lote → ejecutar → guardar resultados en el proyecto → revisar y aceptar.**

- Navegación de proyectos siempre accesible, tablero como vista principal y detalle de tarea con descripción, criterios, dependencias, actividad y resultado. El chat es una ayuda para planificar dentro del proyecto.
- Primera vista: Kanban con tarjetas y selección múltiple. El grafo de dependencias es una ampliación posterior, no requisito para empezar a trabajar.
- Fuente de verdad portable: `.konsora/tasks.json` para tareas y artefactos bajo `.konsora/` para estados, actividad e intentos/resultados. Un único formato canónico versionado, legible y editable sin Konsora; no mantener una copia SQL autoritativa ni exigir exportación para usar las tareas fuera de la aplicación. El contrato exacto se cierra en K-017A.
- Konsora detecta cambios hechos por herramientas externas y por IA. La creación desde el chat y la edición desde el tablero escriben el mismo formato. Leer, seleccionar y preparar/copiar prompts funciona sin una cuenta de proveedor; la ejecución integrada conserva sus aprobaciones y su proveedor único.
- Un cambio externo nunca equivale a aprobar un lote ni a aceptar un resultado. Invalidar las vistas previas/autorizaciones afectadas aunque el modelo no haya actualizado el campo de versión. Los prompts incluyen únicamente tareas seleccionadas y contexto autorizado.
- Una configuración global de proveedor/cuenta; los proyectos y tareas no escogen proveedores distintos. Se puede elegir un modelo disponible dentro del proveedor activo. Cambiar de proveedor exige cerrar la sesión anterior e iniciar la nueva mediante mecanismos oficiales compatibles.
- Seleccionar varias tareas significa preparar un lote explícito. **MVP: una ejecución de agente a la vez en toda la aplicación**, en orden de dependencias y después orden elegido por el usuario. No se promete paralelismo por seleccionar varias tarjetas.
- Solo se ejecutan tareas seleccionadas y autorizadas. Las dependencias externas al lote se muestran como bloqueos; no se incorporan ni ejecutan automáticamente. Una dependencia se satisface cuando el usuario acepta su resultado.
- Se conserva Tauri + React + TypeScript y FastAPI. SQLite queda para configuración, registro de proyectos/chats existentes, históricos anteriores y cachés reconstruibles; el trabajo del proyecto vive en sus archivos. La elección visual no requiere otro framework.
- Sin debates, revisión cruzada entre proveedores, síntesis de consenso, rotación de cuentas, APIs de pago ni cambio automático de proveedor. Memoria avanzada y ejecución paralela quedan fuera del MVP.

## Auditoría y trabajo anterior

La [auditoría del repositorio](docs/auditoria-2026-10-30.md) detalla evidencias, límites y decisiones. El [plan anterior archivado](docs/plans/2026-10-30-plan-anterior.md) y los informes de verificación conservan su valor histórico, pero no fijan el siguiente trabajo.

| Tarea anterior | Situación tras el rediseño |
| --- | --- |
| K-001, K-002 | Completadas históricamente: base de escritorio, servicio y proyectos persistentes. Se reutilizan. |
| K-003, K-004 | Completadas históricamente: Codex de texto y chats por proyecto. Se adaptan a cuenta global; no acreditan ejecución de tareas. |
| K-005A | Completada históricamente con simuladores; debate fuera del producto. Retirada funcional en K-014 sin borrar datos. |
| K-005B, K-006 | Canceladas: segundo proveedor para debatir, rondas y síntesis. No contratar Claude ni continuar estas tareas. |
| K-007 | Sustituida por K-016 y K-022: tareas manuales desde el principio y propuestas opcionales desde el chat. Sin depender de un debate. |
| K-008 | Sustituida por K-023 y K-024: cuota del proveedor activo y validación del nuevo flujo. |
| K-009 | Memoria avanzada aplazada; el contexto explícito mínimo se incluye en el MVP. |
| K-010, K-011 | Adelantadas al MVP y divididas en K-016–K-021: tablero, dependencias y ejecución seleccionada. |
| K-012 | Sustituida por K-019 y K-025: seguridad local antes de ejecutar y distribución al cerrar el MVP. |
| K-013 | No habilita integración alguna; compatibilidad de proveedores alternativos se revisará en K-026. |

Los identificadores K-001–K-013 no se reutilizan con otro significado. Los siguientes empiezan en K-014 para mantener trazabilidad.

K-016 y K-017 conservan su casilla y evidencia de la implementación anterior en SQLite. Sus contratos, validaciones y componentes se reutilizan; no acreditan todavía tareas en archivos. **Orden pendiente vigente: K-017A → K-017B → K-017C → K-018 → resto del MVP.**

## MVP — Orden de implementación

### [x] K-014 — Retirar el debate y alinear la aplicación
- Eliminar la navegación Debate, simuladores de participantes y rutas que crean o ejecutan debates; retirar las menciones a Claude como segundo participante.
- Mantener intactos proyectos, conversaciones y mensajes. Conservar las tablas y registros históricos de debates/propuestas, sin ofrecer nuevas operaciones ni convertirlos en tareas automáticamente; no reescribir ni quitar migraciones ya aplicadas.
- Ajustar las pruebas del contrato retirado y conservar la regresión útil de procesos, errores y persistencia. Referenciar el nuevo plan desde la documentación técnica vigente.
- **Aceptación:** no se puede crear ni ejecutar un debate desde UI o API; siguen funcionando proyectos y chats con las bases existentes, incluidos registros históricos intactos.
- **Pruebas:** migración/apertura desde esquema v3, conservación de filas históricas, rutas retiradas inaccesibles, regresión de proyectos/chats, tipos, build y comprobación de escritorio.
- **Verificación:** [K-014](docs/verification/K-014.md), 2026-10-30: 115 pruebas API, tipos, build web/nativo y comprobación del escritorio correctos.

### [x] K-015 — Asociar los proyectos a carpetas locales
- Añadir carpeta de trabajo opcional a proyectos existentes y selección explícita de una carpeta existente para los que se vayan a ejecutar. Crear/abrir un proyecto no lanza agentes ni modifica sus archivos.
- Validar ruta canónica, disponibilidad y acceso; distinguir proyectos sin carpeta, carpeta perdida y errores recuperables. Resolver enlaces simbólicos antes de autorizar el alcance; rechazar ubicaciones que impliquen acceso indiscriminado al sistema.
- Conservar los proyectos actuales sin inventarles rutas. Mantener el borrado como eliminación de registros locales confirmada, sin borrar nunca la carpeta de trabajo.
- **Aceptación:** una carpeta autorizada queda asociada y persiste; solo se puede ejecutar sobre ella tras la aprobación de ejecución correspondiente. Los proyectos antiguos siguen abriéndose.
- **Pruebas:** migración sin pérdidas, rutas inexistentes/simbólicas, errores de permisos, cambio de carpeta y borrado de proyecto sin modificar archivos. Verificación manual del selector Ubuntu.
- **Verificación:** [K-015](docs/verification/K-015.md), 2026-10-30: 70 pruebas afectadas correctas, tipos/build web y nativo, selector Ubuntu y conservación de archivos al borrar el proyecto.

### [x] K-016 — Modelo de tareas, dependencias y registro de intentos
- Crear tareas por proyecto: título, descripción, criterios de aceptación, orden, fechas y versión. Separar el estado de trabajo de la tarea del estado de cada intento de ejecución.
- Estados de tarea: propuesta, pendiente, en curso, en revisión y hecha. Bloqueada se calcula por dependencias sin aceptar; cancelaciones y errores pertenecen al intento y se muestran en la tarjeta. Solo el usuario acepta una propuesta o marca hecha una tarea.
- CRUD tipado y persistente, cambios de estado validados y dependencias del mismo proyecto sin ciclos. Registrar actividad y resultados; conservar intentos al reintentar, sin sobrescribir evidencias.
- **Aceptación:** tareas manuales editables y persistentes, aisladas por proyecto; las dependencias se desbloquean al aceptar resultados. Un movimiento de tarjeta no inicia un agente ni acredita éxito.
- **Pruebas:** contratos API, CRUD, transiciones, ciclos/autodependencias, dependencias entre proyectos rechazadas, rollback, reinicio e historial de intentos. Proteger el borrado de tareas de las que dependen otras y de tareas activas.
- **Verificación:** [K-016](docs/verification/K-016.md), 2026-10-30: 19 pruebas de tareas y 43 de regresión afectada correctas; contrato TypeScript comprobado. Sin ejecución de agentes.

### [x] K-017 — Tablero como interfaz principal y selección múltiple
- Mantener una navegación lateral de proyectos y abrir su tablero por defecto. Añadir columnas por estado, tarjetas, filtros básicos y panel de detalle; chat como vista secundaria. Mostrar bloqueos, errores y actividad.
- Selección por tarjeta, seleccionar/deseleccionar las visibles y contador claro. Mantener la selección al inspeccionar una tarjeta y reiniciarla al cambiar de proyecto; los filtros no deben ocultar qué se va a ejecutar.
- Preparar la barra «Ejecutar seleccionadas» con resumen de tareas elegibles y bloqueadas. Hasta K-021, mostrar ejecución no disponible; no simular éxito ni lanzar el conector de texto como si ejecutara trabajo.
- **Aceptación:** se crean, editan y organizan tareas desde el tablero y se seleccionan varias sin mezclar proyectos. Acciones por teclado y estados vacíos/carga/error utilizables en Ubuntu.
- **Pruebas:** selección, filtros, persistencia y accesibilidad; UI con al menos dos proyectos y tareas bloqueadas; tipos y build web/nativo. Cambiar de proyecto no pierde las tarjetas guardadas.
- **Verificación:** [K-017](docs/verification/K-017.md), 2026-10-30: tres pruebas focalizadas, recorrido UI con dos proyectos, filtros/selección, revisión/persistencia/errores y tipos/build web/nativo correctos. Ejecución deshabilitada.

### [ ] K-017A — Contrato portable de tareas y resultados en el proyecto
- Definir y documentar el esquema versionado de `.konsora/tasks.json`: IDs estables, título, descripción, criterios, orden, estado y dependencias locales. Elegir una única representación; no interpretar Markdown arbitrario ni el `TASKS.md` de desarrollo como órdenes ejecutables.
- Definir archivos portables de actividad, revisiones e intentos/resultados bajo `.konsora/`, con referencias a IDs e instantáneas/huellas del contenido utilizado. Los IDs no dependen del registro SQLite, de rutas absolutas ni de la instalación de Konsora.
- Publicar esquema y ejemplo mínimo que cualquier IA pueda generar sin la aplicación. Conservar los campos y garantías útiles de K-016; validar duplicados, ciclos, autodependencias, referencias inexistentes, tamaño, esquema no compatible y JSON incompleto/inválido.
- Separar estado declarado en archivos de aceptación humana y autorización de ejecución. Un resultado marcado hecho externamente no desbloquea trabajo automáticamente; especificar cómo se verifica la revisión y qué se invalida al cambiar el contenido o trasladar el proyecto, sin dar por fiables los archivos solo por contener un campo «aprobado».
- **Aceptación:** tareas y resultados se entienden y validan desde una carpeta de ejemplo sin SQLite ni sesión de proveedor; formato y reglas permiten crearlos con una IA externa. Ningún archivo por sí solo inicia trabajo o fabrica una aprobación.
- **Pruebas:** ejemplos válidos, formato/esquema inválidos, duplicados, dependencias/ciclos y cambio de contenido sin incrementar versión. Documentar el contrato antes de sustituir la persistencia.

### [ ] K-017B — Usar los archivos como fuente del tablero y migrar sin pérdidas
- Sustituir el almacenamiento autoritativo de tareas de K-016 por lectura/escritura del contrato K-017A dentro de la carpeta aprobada. El tablero y el detalle reutilizan los componentes actuales; SQLite solo podrá indexar/cachar datos reconstruibles.
- Detectar creación, cambios, sustitución atómica y desaparición del archivo al abrir/actualizar el proyecto y mientras esté abierto. Mostrar estados de carga, cambios externos, error de formato y conflicto; no convertir un archivo temporalmente inválido en un tablero vacío válido ni reescribirlo automáticamente.
- Escrituras desde UI acotadas al archivo autorizado, con huella del contenido leído, comprobación de cambios y escritura atómica. Documentar los límites ante editores no cooperativos; conservar borradores y evitar sobrescrituras silenciosas. Resolver enlaces y rechazar rutas/artefactos que salgan de la carpeta aprobada.
- No crear archivos al abrir/asociar una carpeta. Si falta el archivo, ofrecer inicialización explícita. Los proyectos sin carpeta y las tareas SQL existentes siguen consultables como datos anteriores, con migración explícita por proyecto y vista previa de destino/conflictos. No borrar filas, historial ni migraciones, ni sobrescribir un archivo de tareas ya existente.
- Conservar IDs, dependencias, actividad y resultados al migrar. Abrir la misma carpeta en una instalación limpia debe reconstruir sus tarjetas e historial sin la base anterior. Desvincular/eliminar el registro de proyecto no borra `.konsora/` ni otros archivos.
- **Aceptación:** una IA crea o modifica el archivo con Konsora cerrado o abierto y el tablero lo detecta; editar en UI cambia ese mismo archivo. Copiar la carpeta permite recuperar tareas/resultados. No hay dos fuentes de verdad.
- **Pruebas:** migración con datos existentes, reinicio/reconstrucción sin caché, cambios externos, archivo inválido/desaparecido, conflictos y fallos de escritura, enlaces fuera del alcance y selección tras cambios. Un recorrido UI con dos carpetas y un archivo generado externamente; tipos y builds afectados.

### [ ] K-017C — Preparar prompts desde tareas seleccionadas en archivos
- Añadir vista previa y acción de copiar/guardar un prompt portable a partir exclusivamente de las tareas seleccionadas, con sus IDs/huellas, descripción, criterios, orden y contexto aprobado. Funciona sin login y puede usarse con una IA externa; guardarlo requiere elegir explícitamente un destino dentro del proyecto.
- Mostrar dependencias externas a la selección como bloqueos, sin añadirlas ni incluir su trabajo automáticamente. Mostrar claramente qué archivo y revisión se están usando, incluidas las seleccionadas ocultas por filtros.
- Releer/revalidar antes de preparar o copiar/guardar; si cambia o desaparece alguna tarea, invalidar la vista previa y pedir revisión. Abrir o sincronizar archivos no selecciona tareas ni genera prompts por cuenta propia.
- Copiar un prompt no autoriza ni acredita ejecución. Si se usa con una herramienta externa, Konsora solo detecta sus archivos/resultados y los ofrece a revisión; no promete supervisar procesos que no lanzó. La ejecución integrada permanece deshabilitada hasta K-019–K-021.
- **Aceptación:** al seleccionar A y C en un archivo con A/B/C, la vista previa contiene trabajo de A y C y puede copiarse sin proveedor; B no se incorpora. Cambiar A externamente invalida esa vista previa. No se invocan agentes.
- **Pruebas:** selección parcial, dependencias fuera de selección, texto/contexto incluido, cambios de archivo sin incremento de versión, ausencia de sesión y un recorrido UI de archivo → selección → prompt inspeccionable.

### [ ] K-018 — Una cuenta y un proveedor activos para toda la aplicación
- **Precondición:** K-017A–K-017C completadas. La cuenta se exige para envíos/ejecución integrada, no para leer archivos, usar el tablero o preparar/copiar prompts.
- Crear configuración global persistente, empezando por Codex CLI + sesión de ChatGPT. Sustituir el selector de proveedor de cada chat por el proveedor activo; conservar la selección de modelos de ese proveedor. El simulador es un modo de prueba explícito, no una segunda cuenta.
- Añadir estado y acciones de inicio/cierre de sesión mediante el flujo oficial del CLI; Konsora no recibe contraseñas, claves ni tokens. Si no existe una integración de login segura y documentada, guiar al flujo oficial externo y verificar su resultado, documentando la limitación.
- Definir la transición: detener admisión de trabajo, terminar o cancelar explícitamente lo activo, invalidar autorizaciones de cola, cerrar y comprobar la sesión anterior, iniciar y verificar la nueva. No invocar otro proveedor mientras haya uno activo; solo mostrar alternativas oficialmente validadas.
- Preservar la procedencia histórica de mensajes e intentos. No enviar historial de otro proveedor/cuenta por el mero cambio de sesión: abrir un chat nuevo por defecto y exigir autorización explícita para reutilizar contexto anterior. Si no se puede verificar la identidad por un mecanismo oficial, invalidar autorizaciones al reconectar y documentarlo.
- **Aceptación:** todos los proyectos usan el mismo proveedor activo; logout bloquea envíos y ejecuciones. Los chats antiguos siguen consultables sin reetiquetar sus mensajes. No se necesita una segunda suscripción para cerrar esta tarea.
- **Pruebas:** sin sesión, login por API rechazado, cierre/login fallidos, reinicio, carreras con cola/chat, bloqueo de proveedor inactivo desde API y ausencia de credenciales en UI/almacenamiento/logs. CLI falso y verificación manual del flujo oficial sin cambiar la cuenta del usuario por cuenta propia.

### [ ] K-019 — Contrato oficial de ejecución y seguridad del servicio local
- Revisar y documentar la versión y el mecanismo oficial de Codex que permita ejecutar trabajo desde Konsora con ChatGPT. Evaluar permisos, aprobaciones y eventos del CLI/App Server; no asumir que basta con habilitar herramientas en el conector de texto.
- Definir un contrato tipado de ejecución separado del de conversación: proyecto/carpeta, tarea versionada, contexto autorizado, modelo, permisos, límites, eventos, resultado y cancelación. Mantener el chat de texto con sus restricciones actuales.
- Proteger las operaciones locales, incluidas las de proyectos, con autenticación de instancia y comprobación de origen/host; CORS o loopback por sí solos no autentican un cliente local. El secreto de instancia es propio de Konsora y no es una credencial del proveedor.
- Establecer permisos limitados a la carpeta aprobada, sin heredar claves ni configuraciones que habiliten hooks, plugins, MCP o servicios ajenos de forma implícita. Definir aprobación/rechazo de acciones fuera del alcance y cómo se detiene la ejecución si el mecanismo no puede imponerlo. No usar permisos amplios como solución a bloqueos.
- Vincular el contrato a las tareas e instantáneas/huellas leídas de K-017A–K-017C. Tratar el texto de archivos como contenido de tarea, nunca como permisos, configuración ejecutable o aprobación. Proteger la integridad de la aceptación humana frente a cambios realizados por el agente en archivos del proyecto.
- **Aceptación:** mecanismo oficial y límites documentados con fuentes y fecha; acciones no autorizadas rechazadas por el backend. Si no hay aislamiento/aprobaciones compatibles, queda bloqueada la ejecución real y la tarea sigue pendiente.
- **Pruebas:** cliente/origen/host no autorizados, secreto inválido, rutas fuera del proyecto, variables heredadas y aprobación rechazada mediante CLI falso. Verificar el contrato con la versión local sin lanzar trabajo real todavía.

### [ ] K-020 — Ejecutar una tarea y revisar su resultado
- Implementar un supervisor en el backend con intentos/resultados persistentes en los archivos del proyecto, eventos acotados y una sola ejecución global. Solicitar aprobación concreta de tarea/huella, carpeta, modelo, contexto, permisos y límites antes de cada intento real. Revalidar los archivos de origen; no ejecutar desde una copia SQL desactualizada.
- Ejecutar procesos sin shell en el supervisor. El agente solo podrá usar herramientas/comandos dentro del alcance aprobado, a diferencia de las consultas de texto. Guardar resumen, operaciones/cambios observables, comprobaciones y errores sin secretos; permitir inspeccionar diferencias cuando sea un repositorio Git, sin commits/push automáticos ni descartar cambios previos.
- Separar la vida del trabajo de la conexión HTTP: navegar, cambiar de proyecto o desconectar la UI no cancela ni duplica una tarea. Cancelación explícita detiene el grupo de procesos; el cierre de la aplicación detiene el trabajo de forma controlada. Tras un cierre inesperado, marcar el intento interrumpido y pedir revisión antes de repetir; no prometer deshacer cambios parciales.
- El éxito del proceso lleva la tarea a revisión; solo el usuario marca hecha o la devuelve a pendiente con comentarios. Error, cancelación o cuota agotada conservan resultados parciales y requieren una nueva autorización para reintentar.
- **Aceptación:** una tarea autorizada modifica únicamente una carpeta de prueba aprobada y deja un resultado revisable en su tarjeta. El backend rechaza doble inicio y conserva el historial tras reiniciar.
- **Pruebas:** supervisor con CLI falso, eventos, aprobaciones, timeout, límites, descendientes, cancelación, fallos de escritura, reconexión y recuperación. Prueba real mínima con la sesión ChatGPT autorizada, en una carpeta de prueba dentro del repositorio y sin otros datos del usuario.

### [ ] K-021 — Ejecutar las tareas seleccionadas en una cola persistente
- Convertir la selección del tablero en un lote con vista previa de tareas, orden, carpeta, proveedor/modelo, bloqueos y permisos. Una aprobación del lote autoriza únicamente esas versiones y su alcance; no pedir un clic adicional por cada tarea sin cambios.
- Persistir el lote y sus intentos en el proyecto; la coordinación global entre proyectos puede usar estado operativo de la aplicación, sin reemplazar esos archivos. Validar idempotencia y revalidar antes de cada arranque: contenido/huella de tarea y carpeta sin cambios, sesión activa, permisos y dependencias. Invalidar aprobación por cambios externos aunque no incrementen versión, o por cambios de alcance, carpeta o sesión; nunca ampliar el lote automáticamente.
- Ejecutar una tarea a la vez globalmente. Las independientes siguen el orden aprobado; las dependientes esperan la aceptación humana de sus predecesoras. Mostrar las dependencias no seleccionadas y permitir quitarlas del lote o dejarlas esperando, sin ejecutarlas.
- Permitir cancelar lo pendiente, detener lo activo y pausar/reanudar con estado visible. Ante fallo, cuota, permiso rechazado o sesión perdida, pausar el lote y explicar cómo continuar; sin reintentos automáticos. Tras reiniciar no reanudar trabajo sin revisión y nueva autorización.
- **Aceptación:** al seleccionar A y C entre A/B/C, solo A y C pueden ejecutarse; duplicar una petición no crea dos intentos. Cambiar la vista no pierde el lote. Seleccionar no equivale a autorizar ni a ejecutar.
- **Pruebas:** lotes con dependencias dentro/fuera de selección, doble clic, lotes concurrentes, cambios tras aprobación, fallo parcial, pausa, cancelación, cambio de sesión y reinicio. Verificación UI → API → agente → archivos → revisión, con tres tareas y una no seleccionada.

### [ ] K-022 — Planificar desde el chat y proponer tareas para el tablero
- Reutilizar el chat del proveedor activo para transformar una petición en propuestas estructuradas con título, descripción, criterios y dependencias locales. Ofrecer selección y edición antes de aceptar las propuestas.
- Guardar las propuestas aceptadas en el mismo formato de archivos de K-017A, con procedencia y contexto explícitamente autorizado. Presentar una vista previa de escritura, revalidar cambios externos y evitar duplicados; no incorporar otros archivos/chats o datos históricos de otra cuenta por defecto. El chat es opcional: una IA externa puede generar el archivo y Konsora lo detecta mediante K-017B.
- **Aceptación:** la persona puede crear tareas manualmente o planificarlas conversando; las propuestas rechazadas no se convierten en pendientes y ninguna propuesta inicia ejecución.
- **Pruebas:** formato inválido, dependencias inválidas, aceptación parcial, rechazo, duplicación y aislamiento por proyecto. UI y prueba real mínima de propuesta sin herramientas ni cambios de archivos.

### [ ] K-023 — Cuota del proveedor activo y límites antes de ejecutar
- Consultar únicamente mecanismos oficiales sin inferencia para las ventanas/reinicios que realmente exponga la cuenta activa. Registrar fecha y mostrar datos no disponibles o desactualizados, sin porcentajes inventados ni lectura de credenciales.
- Mostrar cuota y avisos en la aprobación del lote; respetar límites configurables de duración/salida y una reserva cuando los datos permitan evaluarla. Detener la cola ante cuota agotada sin comprar créditos, cambiar de cuenta/proveedor o activar una API.
- Las estimaciones, si tienen evidencia suficiente, se identifican como inciertas. No equiparar una ventana de cinco horas con tiempo de ejecución ni bloquear el uso por carecer de una predicción fiable; ante datos ausentes, el usuario decide con esa limitación visible.
- **Aceptación:** cuota y reinicio son de la cuenta global, con estado de frescura y avisos antes del lote. La ausencia de un endpoint oficial se acredita como limitación y se muestra «no disponible».
- **Pruebas:** varias ventanas, datos ausentes/obsoletos, consulta sin consumo, cambios entre tareas, agotamiento y ausencia de fallback de pago. Validación del mecanismo oficial si existe.

### [ ] K-024 — Verificar el flujo completo del MVP
- Integrar carpeta → archivo generado por una IA externa o la persona → detección/tablero → edición en ese archivo → selección/prompt → aprobación de lote → ejecución → resultados en archivos → revisión. Cubrir caminos de error y recuperación con simuladores y pruebas reales acotadas de Codex.
- Comprobar que no reaparecen debates, proveedores por proyecto ni tareas ejecutadas sin selección. Verificar chats e información anteriores, permisos y ausencia de secretos en eventos/logs.
- **Aceptación:** flujo reproducible en Ubuntu, tablero usable con teclado, tareas y resultados recuperables desde la carpeta sin la base/caché anterior, detección de ediciones externas y reinicio sin duplicaciones. No dar por completo el MVP si falta la ejecución real seleccionada; el uso de archivos y la preparación de prompts no deben exigir login.
- **Pruebas:** suite API/lógica, tipos, build web/nativo y checklist manual del escritorio, dos proyectos, lote parcial, revisión de dependencias, cancelación, cuota/sesión y reinicio. Publicar evidencia en `docs/verification/`.

### [ ] K-025 — Arranque integrado y distribución Ubuntu
- Integrar arranque/parada del backend y supervisor con Tauri y autenticación de instancia de K-019; detectar puertos ocupados y evitar servicios/procesos huérfanos. Usar una ubicación local de datos apropiada para la instalación y migración conservadora desde desarrollo.
- Preparar instalador y diagnóstico controlado; documentar instalación, desarrollo y límites en `docs/`, manteniendo el README en 5–10 líneas descriptivas.
- Mantener tareas y resultados en sus carpetas originales, sin moverlos al directorio privado de la instalación. Actualizar/desinstalar Konsora o eliminar su caché no debe borrar esos archivos. Abrir/copiar una carpeta no restaura automáticamente autorizaciones de ejecución anteriores.
- **Aceptación:** instalar, abrir, usar y cerrar Konsora en Ubuntu sin iniciar el backend manualmente; proyectos e historial sobreviven a la actualización y no queda trabajo ejecutándose al cerrar.
- **Pruebas:** instalación limpia, actualización con datos anteriores, múltiples aperturas, puerto ocupado, CLI ausente, cierre con ejecución activa y permisos del almacenamiento.

## Después del MVP — No implementar todavía

### [ ] K-026 — Cambiar a un segundo proveedor oficialmente compatible
- Elegir la alternativa cuando el usuario quiera cambiar su suscripción; no exigir contratarla para desarrollar el MVP. Revisar entonces condiciones, versión, login/logout y ejecución permitida desde terceros, documentando fuentes.
- Añadir el adaptador dentro del contrato de cuenta global de K-018, nunca como participante paralelo. Migrar la configuración de uso, no las credenciales ni los historiales nativos; conservar los datos locales y pedir permiso antes de enviar contexto antiguo.
- **Aceptación:** cerrar la sesión anterior y entrar en la nueva desde el flujo guiado; todas las nuevas consultas/tareas usan solo el proveedor nuevo. Prueba real con la suscripción correspondiente, sin APIs de pago. Sin permiso oficial o sesión real, mantener pendiente.
- **Pruebas:** transición de sesión, intentos de usar el proveedor inactivo, cuenta ausente, fallo de logout/login, procedencia histórica, cancelación y lote invalidado.
- Antigravity sigue condicionado a permiso oficial expreso; el bloqueo anterior no se considera resuelto por este cambio de plan.

### [ ] K-027 — Grafo visual de dependencias
- Vista adicional del mismo tablero, con conexiones editables y navegación entre tareas; sin duplicar datos ni sustituir la validación de ciclos del backend.
- **Aceptación/pruebas:** estados y selección coherentes con Kanban, ciclos rechazados y actualización persistente entre vistas; revisión de licencia antes de reutilizar código de terceros.

### [ ] K-028 — Contexto persistente y búsqueda por proyecto
- Notas/documentos/decisiones y recuperación explícita con procedencia, propiedad de Konsora. No sincronizar memorias nativas de proveedores.
- **Aceptación/pruebas:** selección inspeccionable del contexto transmitido, aislamiento de proyectos y respeto a las autorizaciones al cambiar de proveedor.

### [ ] K-029 — Ejecuciones paralelas con aislamiento
- Valorar solo tras usar la cola secuencial: aislamiento de carpetas/worktrees, conflictos y límites globales de cuota. No requiere varios proveedores ni cuentas.
- **Aceptación/pruebas:** tareas independientes sin colisiones ni pérdidas de cambios, cancelación y trazabilidad por intento. Requiere diseño y aprobación de alcance antes de implementarse.

## Registro de esta revisión

- **2026-10-30:** auditados código, esquema SQLite, navegación, conector, procesos, pruebas y arranque Tauri. Reutilizar la base; retirar el debate; adelantar tablero y ejecución al MVP. README reducido a 10 líneas y guía técnica trasladada a `docs/desarrollo.md`. Instrucciones de agentes alineadas con el nuevo alcance.
- Esta revisión documental no completó tareas de implementación.
- **2026-10-30 (K-014):** retirados Debate, sus rutas y simuladores, conservando migraciones y datos históricos. **Siguiente tarea: K-015.**
- **2026-10-30 (K-015):** carpeta opcional persistente, validación canónica, estados recuperables y selector nativo verificados. **Siguiente tarea: K-016.**
- **2026-10-30 (K-016):** modelo y API de tareas, dependencias, actividad e intentos persistentes verificados, con aceptación humana y control de versiones. **Siguiente tarea: K-017.**
- **2026-10-30 (K-017):** tablero principal, navegación lateral, detalle y selección múltiple por proyecto verificados. **Siguiente tarea: K-018.**
- **2026-10-30 (corrección de fuente de verdad):** aclarado que las tareas son archivos creados/editados por IA o por la persona dentro del proyecto; Konsora los detecta y prepara prompts desde la selección. Añadidas K-017A–K-017C antes de K-018 y adaptado el flujo posterior. K-016/K-017 siguen como evidencia histórica de la base SQLite; esta revisión no migra datos ni completa las tareas nuevas. **Siguiente tarea: K-017A.**
