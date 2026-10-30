# Konsora

El backlog operativo vigente es [TASKS.md](../TASKS.md). El tablero es la vista principal y reutiliza proyectos y chats existentes; la ejecución supervisada aún no está disponible.

## Corrección de arquitectura pendiente: tareas en archivos

El producto debe leer tareas que una IA o la persona crea directamente en la carpeta del proyecto. El formato inicial previsto es `.konsora/tasks.json`, con esquema versionado e IDs estables; actividad, revisiones e intentos/resultados también serán archivos del proyecto. Se podrá abrir/copiar la carpeta y recuperar el trabajo sin la base privada de otra instalación. SQLite solo podrá actuar como caché reconstruible de ese trabajo, además de conservar configuración e históricos anteriores.

**La implementación actual aún usa SQLite para tareas, actividad e intentos.** Este cambio documental no ha migrado datos ni modificado el comportamiento del tablero. K-016 y K-017 acreditan esa implementación anterior y sus componentes se reutilizarán. El siguiente orden es **K-017A (contrato) → K-017B (archivos, detección y migración) → K-017C (selección a prompt) → K-018**. Las secciones técnicas siguientes describen el código actual hasta completar esa adaptación.

El contrato tendrá una única fuente canónica: la UI escribirá el mismo archivo que puede editar una IA externa. Abrir/asociar la carpeta no inicializará archivos automáticamente; migrar tareas SQL requerirá acción explícita y revisión de conflictos, conservando los originales. Desvincular o eliminar el registro de proyecto no borrará archivos de trabajo.

La detección de cambios externos, las huellas del contenido y la comprobación de conflictos evitarán trabajar sobre una vista previa desactualizada. Un archivo modificado por una IA no concede permisos ni acredita aceptación humana. Leer, seleccionar y preparar/copiar un prompt no requerirá login; ejecutar desde Konsora mantendrá su aprobación y supervisión. Copiar un prompt para otra herramienta no implica que Konsora supervise esa ejecución externa.

Aplicación de escritorio local-first para organizar el trabajo con modelos y agentes de IA desde Ubuntu.

## Funcionalidades actuales

- Crear, listar, abrir y renombrar proyectos.
- Eliminar proyectos con confirmación explícita.
- Guardar los proyectos en SQLite y recuperarlos tras reiniciar.
- Asociar, comprobar, cambiar o desvincular una carpeta local por proyecto, con selector nativo Ubuntu.
- Crear, editar y organizar tareas en el tablero por estados, con filtros, dependencias, actividad y resultados consultables.
- Seleccionar varias tarjetas del proyecto; ejecución todavía deshabilitada.
- Crear y abrir chats por proyecto, conservar mensajes ordenados y continuar con su historial tras reiniciar.
- Elegir conector y modelo en cada conversación, con estados de carga, error y cancelación.
- Comprobar la conexión con el servicio local y reintentar ante errores.
- Consultar Codex CLI con una sesión de ChatGPT, sin claves ni facturación por API.
- Probar el flujo con un simulador sin conexión ni consumo de cuota.

## Instalación

Requiere Ubuntu 24.04 con sesión gráfica, Node.js 22.12+ (22 LTS recomendado), npm, Python 3.12 y [Rust estable](https://www.rust-lang.org/tools/install).

```bash
sudo apt update
sudo apt install -y build-essential pkg-config curl wget file \
  libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev python3-venv

npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r services/api/requirements-dev.txt
```

## Ejecución

Desde la raíz del repositorio, inicia el servicio local:

```bash
npm run dev:api
```

En otra terminal, abre la aplicación:

```bash
npm run dev:desktop
```

La API escucha en `127.0.0.1:8000`. Detén cada proceso con `Ctrl+C`; cerrar la ventana no detiene la API. Para usar la interfaz en el navegador, ejecuta `npm run dev:web` en lugar del escritorio y abre `http://127.0.0.1:1420`.

Los proyectos, chats y mensajes, junto con los registros históricos de debates y propuestas, se guardan en `.local/konsora.sqlite3`. Las migraciones conservan los datos existentes. Para elegir otro archivo, exporta `KONSORA_DATABASE_PATH` antes de iniciar la API. Los proyectos y el simulador de chat no requieren una cuenta. Las consultas reales de los chats utilizan los límites de tu suscripción de ChatGPT mediante Codex CLI; Konsora no integra APIs de pago.

## Tablero y selección

La barra lateral de proyectos permanece accesible. Al abrir un proyecto se muestra **Tablero**; **Chat de planificación** conserva los chats existentes y **Carpeta y proyecto** reúne la configuración local. Al borrar el proyecto abierto se abre el siguiente disponible.

Pulsa **+ Nueva tarea** para guardar título, descripción, criterios y dependencias del mismo proyecto. Abre una tarjeta para editarla, cambiar su orden o gestionar su estado; el panel muestra bloqueos, intentos, resultados, errores y actividad. Los cambios de estado son manuales y no lanzan agentes. Las propuestas se aceptan explícitamente y solo **Aceptar resultado y marcar hecha** desbloquea dependencias. Los errores del backend se muestran sin perder el borrador. Borrar una tarea exige confirmación y conserva las restricciones de K-016.

Usa las casillas por tarjeta o **Seleccionar visibles**/**Deseleccionar visibles**. Buscar, filtrar por estado o mostrar solo bloqueadas no elimina selecciones: el resumen enumera todas, indica cuántas están ocultas y distingue pendientes sin bloqueos, bloqueadas y otros estados. **Limpiar selección** la vacía. Inspeccionar una tarjeta o ir al chat conserva la selección; cambiar de proyecto o recargar la aplicación la reinicia. Las tareas guardadas permanecen en SQLite.

**Ejecutar seleccionadas** está deshabilitado con una explicación visible; seleccionar no autoriza ni inicia trabajo. No se simulan resultados ni se invoca el conector de chat para ejecutar tarjetas.

Controles accesibles mediante Tab, Espacio y Enter; Escape cierra el detalle y el diálogo conserva el foco dentro mientras está abierto. El área de columnas admite desplazamiento horizontal con teclado; el resto de la página se adapta al tamaño de ventana. Estados vacíos, carga y errores de lectura incluyen acciones de recuperación.

`npm run test:board` ejecuta tres pruebas focalizadas de selección, resumen y filtros sin dependencias nuevas. Evidencia del recorrido visual: [K-017](verification/K-017.md).

## Carpetas de trabajo

Abre un proyecto, entra en **Carpeta y proyecto** y pulsa **Seleccionar carpeta…**, elige una carpeta existente y pulsa **Guardar carpeta**. La ruta canónica guardada se muestra en el proyecto. Cancelar el selector no cambia la asociación. En el navegador de desarrollo se introduce la ruta absoluta en el campo correspondiente.

**Comprobar carpeta** actualiza su disponibilidad; **Desvincular carpeta** elimina solo la asociación. Los estados distinguen ausencia de asociación, carpeta disponible, perdida, sin acceso y ruta insegura. Ante una carpeta perdida o permisos insuficientes se conserva la ruta para poder recuperarla o cambiarla. El borrado confirmado de un proyecto elimina sus registros locales, nunca la carpeta ni sus archivos.

La migración SQLite v4 añade `workspace_path` opcional; todos los proyectos anteriores quedan sin carpeta. `PATCH /projects/{id}/workspace` recibe `{ "workspace_path": "/ruta/al/proyecto" }`, o `null` para desvincular. No se asigna una carpeta al crear o abrir un proyecto. La validación exige un directorio existente con acceso de lectura/escritura/travesía, resuelve enlaces y rechaza rutas relativas, raíces amplias, el directorio personal completo y ubicaciones del sistema/configuración personal. Si la ruta canónica guardada se sustituye posteriormente por un enlace a otra carpeta, se marca insegura.

Seleccionar una carpeta no ejecuta agentes ni concede autorización para ejecutar tareas; el aislamiento y la revalidación inmediatamente antes de ejecutar corresponden a K-019–K-021. No se crean archivos de sondeo ni se recorre el contenido para validar la carpeta.

Se añade únicamente el [plugin oficial de diálogos de Tauri](https://v2.tauri.app/plugin/dialog/), en JavaScript y Rust, para el selector nativo. La ventana principal recibe `dialog:allow-open`, sin permisos de comandos de archivos ni shell. Evidencia: [K-015](verification/K-015.md).

## Tareas y dependencias (API)

La migración SQLite v5 añade tareas, dependencias, intentos y actividad sin cambiar las migraciones anteriores ni reutilizar debates históricos. El contrato TypeScript está en `apps/desktop/src/tasks.ts`; la UI utiliza ese contrato sin iniciar agentes.

Todas las rutas siguientes dependen de `/projects/{project_id}/tasks`:

| Método | Ruta | Operación |
| --- | --- | --- |
| GET | raíz | Listar por orden, fecha e ID; incluir dependencias, bloqueos y último error de intento. |
| POST | raíz | Crear con `title`, `description`, `acceptance_criteria`, `sort_order` y `dependencies`; solo estado inicial `pending` o `proposal`. |
| GET | `/{task_id}` | Detalle con tarea, intentos y actividad ordenados. |
| PATCH | `/{task_id}` | Editar campos concretos con `expected_version`; los omitidos se conservan y no se admite `null`. |
| POST | `/{task_id}/status` | Cambiar estado con `status`, `expected_version` y comentario opcional. |
| DELETE | `/{task_id}?expected_version=N&confirm=true` | Borrar con confirmación; rechaza tareas activas o con otras tareas dependientes. |

Título: 1–120 caracteres. Descripción y criterios: texto de hasta 16000 cada uno. Orden: entero no negativo; por defecto se añade al final. Dependencias: hasta 200 UUID únicos del mismo proyecto, sin autodependencias ni ciclos. Los cambios y su actividad se confirman juntos; una versión obsoleta devuelve 409. Los errores de validación no reflejan el cuerpo enviado.

Transiciones manuales: `proposal → pending → in_progress → in_review → done`; desde en curso, en revisión o hecha se puede volver a pendiente. Una tarea bloqueada no puede avanzar a en curso, revisión o hecha. Solo aceptar como hecha la dependencia desbloquea las sucesoras; un proceso exitoso o una tarjeta en revisión no bastan. Cambiar título, descripción, criterios o dependencias de una tarea hecha/en revisión la devuelve a pendiente. Para editar el alcance de una tarea en curso, devolverla primero a pendiente. Mover una tarjeta no crea intentos ni inicia agentes.

Los intentos tienen estado independiente (`running`, `succeeded`, `failed`, `cancelled`, `interrupted`), versión e instantánea de la tarea, conector/modelo, fechas, resultado y error. Su registro es interno y no tiene rutas HTTP de inicio/finalización: las funciones actuales solo persisten datos para el supervisor futuro. Un intento exitoso deja la tarea en revisión, los demás la devuelven a pendiente con sus evidencias parciales. Reintentar crea otro registro; un intento terminado no se puede sobrescribir. Mientras haya un intento activo se bloquean ediciones, movimientos y borrado, incluido el del proyecto. El borrado explícito y confirmado de una tarea/proyecto elimina también su historial local; nunca borra archivos de la carpeta.

Evidencia y comandos focalizados: [K-016](verification/K-016.md). En esta tarea no se ejecutan procesos, no se consumen cuotas y no se implementa la cola ni la recuperación del supervisor de K-020.

## Conversaciones por proyecto

1. Crea o abre un proyecto. En **Chat de planificación**, escribe un nombre y pulsa **+ Nuevo chat**.
2. Envía un mensaje al **Simulado** para probar sin conexión ni cuota.
3. Para conversar con ChatGPT, elige **Codex CLI** y selecciona un modelo en el desplegable. La primera opción usa `KONSORA_CODEX_MODEL` o el predeterminado del CLI. El catálogo procede de Codex y no garantiza acceso a todos sus modelos: un rechazo del CLI se muestra como error. Un modelo guardado anteriormente se conserva aunque ya no figure en el catálogo.
4. Confirma el envío del mensaje y del historial, y pulsa **Enviar a Codex**. Cada envío real requiere una confirmación nueva; no hay reintentos automáticos.
5. Tras reiniciar, abre el mismo proyecto y chat para consultar el historial y continuar. El conector y el modelo elegidos se guardan al completar un turno. Cada respuesta conserva la identidad del conector/modelo usado, aunque cambies el siguiente turno.

Solo se transmite el historial del chat abierto, como texto, sin archivos del proyecto. Cada mensaje admite hasta 16000 caracteres y el contexto serializado completo hasta 64000; al superar este último límite se pide abrir otro chat, conservando todo el historial anterior. Konsora no recorta ni resume mensajes automáticamente ni sincroniza chats o memorias nativos de los proveedores.

El mensaje y su respuesta se guardan juntos al terminar correctamente. Ante error o cancelación, el borrador permanece en pantalla y los turnos anteriores se conservan. **Actualizar historial y conectores** permite comprobar si un turno llegó a guardarse cuando se pierde la conexión justo después de responder. No reenvíes sin revisar el historial en ese caso. Cambiar de chat/proyecto o cerrar la ventana cancela la petición en curso; los borradores sin enviar no se guardan al salir del chat. Eliminar un proyecto elimina también sus chats, mensajes y registros históricos, previa confirmación explícita.

## Registros históricos

La navegación, los simuladores y todas las rutas HTTP de debates se han retirado. Sus tablas y registros históricos se conservan en SQLite, sin nuevas operaciones, recuperación que cambie sus estados ni conversión automática en tareas. Las migraciones v1–v3 siguen intactas y las bases anteriores se abren con sus proyectos y chats. El borrado confirmado de un proyecto mantiene su cascada sobre todo el historial local.

## Codex CLI con tu suscripción

Instala el [Codex CLI oficial](https://learn.chatgpt.com/docs/cli) y entra con ChatGPT desde tu terminal:

```bash
codex --version
codex login
codex login status
```

Esta integración está validada con **Codex CLI 0.165.x**; otras versiones se rechazan hasta verificar sus opciones de aislamiento. El último comando debe indicar `Logged in using ChatGPT`. Konsora consulta ese estado sin leer archivos de autenticación. Si detecta login por API, deshabilita el envío: cambia la sesión mediante el CLI oficial, sin introducir claves en Konsora.

1. Inicia API e interfaz con los comandos anteriores.
2. El estado compacto al pie de la aplicación indica si Codex está conectado. **Comprobar Codex** consulta instalación y login, sin enviar prompts ni consumir cuota de inferencia.
3. Abre un proyecto/chat y elige **Codex CLI**. Pulsa **Actualizar historial y conectores** si acabas de iniciar sesión.
4. Escoge el modelo, escribe el mensaje, confirma el uso de cuota y pulsa **Enviar a Codex**. La confirmación se solicita en cada envío. Para probar sin cuota, elige **Simulado** en el chat.

El modelo predeterminado lo elige Codex. Para configurar un valor por defecto en Konsora, exporta `KONSORA_CODEX_MODEL` en la terminal del backend y reinicia el servicio; cada chat puede escoger otro modelo para sus envíos. Se utiliza la opción oficial [`--model` de Codex CLI](https://learn.chatgpt.com/docs/models). Si `codex` no está en su `PATH`, configura `KONSORA_CODEX_BIN` con la ruta del ejecutable oficial. No se admite configurar comandos, flags o URLs desde la UI.

Los chats por proyecto usan consultas de texto: sin archivos de proyectos, herramientas, comandos, hooks, plugins ni subagentes. Usan un directorio temporal bajo `.local/codex`, sandbox de solo lectura, entorno sin claves de API y configuración aislada por invocación; el CLI conserva y renueva su propia sesión. La configuración personal de modelos/plugins no se carga en las inferencias. El login y los tokens nunca se copian al repositorio ni se devuelven a la UI.

El desplegable consulta [`codex debug models`](https://learn.chatgpt.com/docs/cli/reference#codex-debug-models) sin lanzar turnos. Solo muestra nombres e identificadores visibles del catálogo, sin listas fijas; consultar el catálogo no confirma el acceso a un modelo. Si falla, permite reintentar y conserva el modelo del chat y la opción predeterminada. Este comando experimental se valida con la misma versión 0.165.x; utiliza su configuración habitual con proveedor oficial y login ChatGPT forzados, sin hooks/plugins, en un directorio aislado. Se acota a 15 segundos y 8 MiB por flujo para sus metadatos; el límite de las respuestas de chat sigue siendo 512 KiB.

Hay un límite de 120 segundos para la consulta y 512 KiB por flujo de salida. **Cancelar mensaje** detiene el proceso local y sus descendientes; no devuelve la cuota ya consumida. No hay reenvíos automáticos desde Konsora. Las respuestas se muestran como texto y los fallos del CLI se convierten en mensajes controlados, sin mostrar sus diagnósticos.

La cuenta global se implementa en K-018; el contrato y seguridad de ejecución en K-019, la ejecución supervisada en K-020–K-021, la cuota en K-023 y la distribución Ubuntu en K-025. Hasta entonces, los chats solo ofrecen consultas de texto y el backend se inicia manualmente.

Los proveedores alternativos se revisarán después del MVP en K-026; no se necesita una segunda suscripción. Antigravity conserva el bloqueo documentado en el [plan histórico](plans/2026-10-30-plan-anterior.md) hasta verificar un mecanismo oficialmente permitido. No se sustituye por una API de pago.

## Comprobaciones

```bash
npm run check          # Tipos, compilación web, selección del tablero y pruebas de API
npm run build:desktop # Compilación nativa sin instalador
```

Las pruebas automatizadas usan simuladores y ejecutables ficticios locales; no invocan el Codex real ni consumen cuota. Retirada de debates y conservación del historial: [verificación K-014](verification/K-014.md). Los informes anteriores son históricos. Conversaciones: [verificación K-004](verification/K-004.md). Conector y prueba real inicial: [verificación K-003](verification/K-003.md).
