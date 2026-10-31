# Konsora — Plan de implementación

**Alcance vigente, 2026-10-30:** el MVP es un visualizador de tareas en archivos que permite seleccionar varias y generar un prompt para copiar y pegar en una herramienta de IA externa. No incluye chats, cuentas de proveedores ni ejecución automática.

Este es el único backlog operativo. Ejecutar las tareas pendientes del MVP en el orden indicado, una por vez. Marcar `[x]` únicamente con aceptación y comprobaciones pertinentes. Los planes e informes anteriores son históricos y no amplían este alcance.

## Recorrido del MVP

**Abrir carpeta → detectar tareas → ver tablero → seleccionar varias → revisar prompt → copiar y pegar fuera de Konsora.**

- Las tareas y su historial viven en `.konsora/tasks.json`, con formato v1 documentado e IDs estables. Una IA o la persona puede escribir el archivo sin Konsora. No se interpreta Markdown arbitrario ni el `TASKS.md` de desarrollo como instrucciones ejecutables.
- El tablero detecta cambios externos, muestra estados y dependencias y conserva la selección al filtrar o inspeccionar. Cambiar de proyecto reinicia la selección. No hay pestañas de chats o conversaciones.
- La vista previa incluye únicamente tareas seleccionadas y contexto expresamente añadido. Las dependencias fuera de selección se muestran como referencias, sin añadir su trabajo. Cambios del archivo, selección o contexto invalidan la vista previa.
- La acción principal es **Copiar prompt**. La exportación opcional a `.konsora/prompts/` se conserva, sin sobrescribir archivos. Copiar/guardar no lanza herramientas ni acredita ejecución o éxito.
- Cada persona elige dónde pegarlo: Codex, Claude Code u otra herramienta. El MVP no instala, busca, abre ni consulta esos ejecutables; no necesita cuentas, sesiones, modelos, cuotas ni conexión a un proveedor.
- Se mantienen las operaciones manuales de tareas ya existentes y la consulta del historial portable. Los registros de intentos/resultados importados no representan procesos supervisados por Konsora. No hay cola, botones de ejecución ni simuladores de agentes.
- Tauri + React + TypeScript, FastAPI en loopback y archivos de proyecto. SQLite conserva registro de proyectos y datos anteriores; no es la fuente de tareas de un archivo existente. Abrir/asociar no escribe archivos automáticamente; inicializar/migrar requiere una acción explícita.
- No se borran tablas, registros históricos, migraciones aplicadas ni archivos de proyectos por retirar funcionalidades. Borrar un registro local de proyecto exige confirmación y conserva su carpeta.

## Trabajo anterior y trazabilidad

Los identificadores no se reutilizan. El [plan de ejecución integrada archivado](docs/plans/2026-10-30-plan-ejecucion-integrada.md), el [primer plan](docs/plans/2026-10-30-plan-anterior.md) y los informes de verificación conservan la evidencia de su alcance de entonces.

| Trabajo | Situación actual |
| --- | --- |
| K-001, K-002 | Base de escritorio/servicio y proyectos locales reutilizados. |
| K-003, K-004 | Conector y conversaciones implementados históricamente; retirados del producto en K-031. Datos conservados. |
| K-005A, K-014 | Debate retirado; tablas/registros históricos conservados. |
| K-005B, K-006 | Canceladas: no debates ni segundo participante. |
| K-007–K-013 | Plan original sustituido; no son tareas operativas pendientes. |
| K-015 | Carpetas persistentes y selector nativo completados. |
| K-016, K-017 | Modelo inicial y tablero completados; persistencia adaptada posteriormente a archivos. |
| K-017A | Formato portable v1, esquema y ejemplo completados. [Evidencia](docs/verification/K-017A.md). |
| K-017B | Archivos como fuente, cambios externos y migración sin pérdidas completados. [Evidencia](docs/verification/K-017B.md). |
| K-017C | Selección → prompt → copia/exportación revalidadas completado. [Evidencia](docs/verification/K-017C.md). |
| K-018 | Cancelada: gestor global de cuenta/proveedor y login/logout en Konsora. |
| K-022 | Cancelada: chat de planificación y propuestas generadas dentro de Konsora. La IA externa crea los archivos. |
| K-019–K-021, K-023, K-026–K-029 | Funcionalidades posteriores al MVP, sin autorización para adelantarlas. |

## MVP — Orden operativo

### [x] K-031 — Retirar chats, proveedores y ejecución del MVP
- Eliminar vistas/componentes de conversaciones y selectores de proveedor/modelo, indicador/comprobación de Codex, simuladores y código que invoca CLIs.
- Retirar las rutas HTTP de conversaciones, catálogo y consultas de proveedores; no consultar instalaciones/sesiones al abrir Konsora. Conservar sus tablas, filas y migraciones como histórico, sin reconvertirlas en tareas.
- Quitar el botón «Ejecutar seleccionadas», incluso deshabilitado. El proyecto abre directamente el tablero; la carpeta/configuración queda en un desplegable, sin navegación de chats. Simplificar el texto de copia y mantener la exportación opcional ya existente.
- Separar utilidades compartidas de los módulos retirados y ajustar las pruebas del contrato eliminado. Actualizar las instrucciones, README y guía de desarrollo al alcance actual.
- **Aceptación:** abrir proyecto, seleccionar tareas y copiar prompt funciona sin CLI, login ni conexión a proveedor. No hay UI/rutas de chat, inferencia, modelos o ejecución. Proyectos, archivos de tareas y filas históricas permanecen intactos.
- **Pruebas:** rutas retiradas 404/ausentes de OpenAPI y conservación de filas; copia de selección parcial con creación de procesos prohibida; tipos/build web/nativo y un recorrido UI sin solicitudes a proveedores. No repetir pruebas de los conectores retirados.
- **Verificación:** [K-031](docs/verification/K-031.md): 98 pruebas API restantes y tres de selección correctas; tipos/build web/nativo y recorrido de copia con dos proyectos, sin rutas de chat/proveedor ni invocaciones CLI. Datos históricos conservados. **Siguiente tarea: K-032.**

### [x] K-032 — Proteger el servicio local del MVP
- Extraer la seguridad local de la antigua K-019: autenticación de instancia y validación de origen/host para operaciones de proyectos, archivos y prompts. El servicio sigue escuchando solo en loopback; CORS no sustituye a la autenticación.
- Integrar el secreto propio de Konsora con el arranque de escritorio, sin credenciales de proveedor ni exposición en logs. Mantener el desarrollo web local documentado y recuperar errores sin perder archivos/borradores.
- **Aceptación:** un cliente/origen/host no autorizado no puede leer ni modificar datos del proyecto. El escritorio conserva su flujo carpeta → selección → copia.
- **Pruebas:** secreto ausente/incorrecto, origen/host rechazados y un recorrido autorizado; comprobación de ausencia de secretos en respuestas y logs.

- **Verificación:** [K-032](docs/verification/K-032.md): servicio autenticado, transporte IPC privado, 106 pruebas API y recorrido nativo de carpeta/copia/cierre correctos. **Siguiente tarea: K-024.**

### [x] K-024 — Verificar y cerrar el flujo del MVP simplificado
- Verificar carpeta → archivo generado externamente → detección/tablero → selección → vista previa → copiar/pegar, sin instalar herramientas de IA ni iniciar sesión. Incluir dos proyectos, dependencias fuera de selección, filtros y cambios externos.
- Comprobar edición/migración sin pérdidas, archivo inválido/desaparecido, conflictos y recuperación al reiniciar. La copia debe contener solo el trabajo seleccionado y contexto explícito; guardar un prompt es opcional y no sobrescribe archivos.
- **Aceptación:** flujo reproducible en Ubuntu con teclado y portapapeles/fallback Ctrl+C, tareas recuperables desde la carpeta sin la base antigua y ausencia de chats, cuentas, inferencias o ejecución. El cierre del MVP no requiere una prueba real con IA.
- **Pruebas:** API/lógica afectadas, tipos/build web/nativo y un checklist de escritorio. Publicar evidencia en `docs/verification/`; no probar proveedores ausentes del producto.

- **Verificación:** [K-024](docs/verification/K-024.md): recorrido completo de selección/copia, errores y recuperación correcto; migración e historial cubiertos por API. **Siguiente tarea: K-025.**

### [ ] K-025 — Arranque integrado y distribución Ubuntu
- Integrar arranque/parada del backend Tauri con la autenticación local de K-032. Detectar puertos ocupados, evitar procesos huérfanos y usar una ubicación de datos apropiada con migración conservadora.
- Preparar instalación/diagnóstico y documentarlos en `docs/`; mantener el README en 5–10 líneas descriptivas. No mover tareas/resultados a una base privada ni exigir CLIs de IA.
- **Aceptación:** instalar, abrir, visualizar y copiar un prompt sin arrancar el backend manualmente. Actualizar/desinstalar o eliminar la caché no borra los archivos del proyecto; cerrar no deja el servicio activo.
- **Pruebas:** instalación limpia, actualización de datos anteriores, múltiples aperturas, puerto ocupado, cierre y permisos. Sin supervisores de agentes ni credenciales de terceros.

## Después del MVP — No implementar todavía

### [ ] K-030 — Abrir una herramienta de IA y entregarle el prompt
- Diseñar la selección de ejecutor (Codex, Claude Code u otro validado), modelo/opciones y lanzamiento explícito a partir del prompt revisado. Cada herramienta gestiona su propia sesión; no crear un gestor de cuentas de Konsora ni exigir cerrar sesiones de otras herramientas.
- Verificar primero mecanismos, documentación y condiciones oficiales. No asumir que un CLI headless permite una integración de terceros. Si no hay entrega automática permitida, conservar copiar/pegar; sin APIs de pago, endpoints privados ni extracción de tokens.
- **Aceptación/pruebas:** con aprobación explícita se abre el ejecutor elegido en la carpeta y recibe exactamente el prompt revisado mediante argumentos/stdin oficiales, sin shell ni ampliación de selección. Rechazar cambios de origen y ejecutables ausentes; documentar qué puede observar/cancelar Konsora y qué gestiona la herramienta externa. Requiere concretar el alcance antes de implementarse.

### [ ] K-019 — Contrato oficial y permisos de ejecución integrada
- Solo si se pide supervisión integrada además del lanzador, definir contrato separado de generación de prompts: tarea/huella, carpeta, contexto, modelo, permisos, límites, eventos y cancelación. La seguridad local del MVP ya se resuelve en K-032.
- Validar aislamiento, aprobaciones y sesión oficial del ejecutor escogido; proteger la aceptación humana frente a cambios del agente. Sin mecanismo compatible, mantener la ejecución integrada bloqueada y la copia manual disponible.
- **Aceptación/pruebas:** documentación oficial fechada, versión validada, operaciones fuera de alcance rechazadas y contrato comprobado con CLI falso antes de trabajo real autorizado.

### [ ] K-020 — Supervisar una ejecución y revisar su resultado
- Basarse en K-019, registrar intentos/resultados en el proyecto, ejecutar sin shell, gestionar límites/cancelación/reconexión y conservar cambios previos. El éxito queda en revisión humana.
- **Aceptación/pruebas:** una ejecución explícitamente aprobada en carpeta de prueba, historial persistente, errores/descendientes/cierre sin procesos huérfanos. No se implementa como parte del MVP de copiar prompts.

### [ ] K-021 — Cola persistente de ejecuciones seleccionadas
- Basarse en K-020; aprobación vinculada a versiones/alcance, orden/dependencias y revalidación antes de arrancar. Una ejecución global inicialmente, sin incorporar dependencias ni reintentos automáticos.
- **Aceptación/pruebas:** selección parcial, idempotencia, cambios externos, pausa/cancelación, fallos y reinicio con revisión/nueva autorización. No afecta al flujo de copia manual.

### [ ] K-026 — Añadir otros ejecutores oficialmente compatibles
- Ampliar K-030 cuando se quiera usar otra herramienta; validar entonces login, entrega de prompts y ejecución permitida. No implica suscripciones simultáneas ni rotación automática de cuentas.
- **Aceptación/pruebas:** elegir el ejecutor compatible y entregarle únicamente el prompt revisado. Sin permiso oficial, conservar la copia manual. El bloqueo histórico de Antigravity sigue pendiente de revisión oficial; este cambio de alcance no lo resuelve.

### [ ] K-023 — Información de cuota, si la integración futura la necesita
- Consultar solo mecanismos oficiales sin inferencia cuando existan; mostrar datos ausentes/desactualizados sin porcentajes inventados. Sin compra de créditos, cambio automático de proveedor ni fallback de pago.
- **Aceptación/pruebas:** consulta oficial validada para el ejecutor correspondiente y errores controlados. No es un requisito para visualizar/copiar tareas.

### [ ] K-029 — Varios agentes y ejecuciones paralelas
- Definir selección de agentes/modelos, aislamiento por carpetas/worktrees, conflictos, límites y permisos después de validar el flujo de ejecución que se quiera ofrecer.
- **Aceptación/pruebas:** tareas seleccionadas sin colisiones ni cambios no autorizados, cancelación y trazabilidad. Requiere diseño y aprobación de alcance antes de implementarse.

### [ ] K-027 — Grafo de dependencias
- Vista adicional de los mismos archivos/selección, sin duplicar fuentes ni saltarse validación de ciclos. Evaluar cuando aporte valor al uso real del tablero.

### [ ] K-028 — Contexto persistente y búsqueda por proyecto
- Notas y búsqueda con procedencia y selección explícita del contexto. No sincronizar memorias nativas ni recuperar el chat retirado como interfaz principal.

## Registro de esta revisión

- **2026-10-30:** el usuario reduce el MVP a visualizar tareas de archivos y generar un prompt para copiar/pegar. Cuentas globales (K-018) y chat interno (K-022) cancelados; ejecución, agentes, modelos y cuota aplazados. K-031 retira las funciones actuales descartadas; K-032 separa la seguridad local necesaria antes de distribuir. No se marca el MVP entero como completado por actualizar el plan.
- **2026-10-30 (K-031):** retirados chats, conectores, modelos, comprobación de Codex y código de invocación de CLIs; eliminada la acción de ejecución. Flujo de selección/copia verificado, sin borrar tablas ni filas históricas. **Siguiente tarea pendiente: K-032.**
