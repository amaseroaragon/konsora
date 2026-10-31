# Desarrollo de Konsora

Konsora visualiza tareas en archivos y permite seleccionar varias para generar un prompt que se copia y pega fuera de la aplicación. El [plan vigente](../TASKS.md) limita el MVP a ese flujo; no hay chats, cuentas, consultas de proveedores ni ejecución de agentes.

## Instalación

Para utilizar un paquete ya construido, consulta [Instalación Ubuntu](instalacion-ubuntu.md). Los siguientes requisitos son solo para desarrollar/compilar.

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

No es necesario instalar Codex, Claude Code ni otro CLI de IA. No hacen falta login, claves, suscripciones ni cuota para abrir el tablero o generar/copiar prompts.

## Arranque de desarrollo

Para escritorio basta con:

```bash
npm run dev:desktop
```

El script prepara el backend con PyInstaller y Tauri lo inicia en un puerto libre de `127.0.0.1`. La clave aleatoria de instancia se entrega por stdin y permanece en Rust; el WebView utiliza IPC. No se incluye en JavaScript, URLs ni logs. Cerrar Konsora detiene su servicio; un EOF del padre también lo detiene. No se reutilizan servidores abiertos en 8000 ni otros puertos.

Para desarrollo **en navegador**, inicia `npm run dev:api` y `npm run dev:web` en dos terminales. La API crea `.local/dev-session.json` con permisos 0600 (no versionarlo); Vite mantiene un proxy `/api` autenticado. Abre `http://127.0.0.1:1420/api/health`: el diálogo HTTP del navegador usa usuario `konsora` y la clave `token` del archivo privado, consultada localmente con tu editor. Luego abre `/`. Es una credencial temporal de desarrollo local, sin relación con cuentas de IA. No la copies a `.env`, código ni logs. Ctrl+C cierra cada proceso y elimina su sesión; después de una caída, comprueba que el PID guardado ya no existe antes de retirar el archivo obsoleto. No sobrescribir una sesión activa.

Para otra sesión aislada, exporta **en ambas terminales** `KONSORA_WEB_PORT` y `KONSORA_DEV_SESSION_FILE` (ruta absoluta dentro de un directorio privado). No uses el servidor estático `preview` para probar API: el proxy solo está disponible en desarrollo. Todas las rutas del backend requieren Bearer de instancia, un origen permitido, Host exacto y cliente loopback; CORS por sí solo no concede acceso.

El escritorio conserva el registro de proyectos y los datos históricos en `${XDG_DATA_HOME:-~/.local/share}/app.konsora.desktop/konsora.sqlite3`, dentro de un directorio 0700. El servicio web de desarrollo usa `.local/dev-data/konsora.sqlite3`. Los registros antiguos de `.local/konsora.sqlite3` permanecen intactos; su [importación opcional](instalacion-ubuntu.md#importar-un-registro-anterior-opcional) exige una acción explícita antes de la primera apertura. El archivo `.konsora/tasks.json` de cada proyecto sigue siendo la fuente de tareas.

## Carpeta y archivo de tareas

Crea o abre un proyecto desde la barra lateral. Despliega **Carpeta y proyecto**, pulsa **Seleccionar carpeta…**, elige una carpeta existente y guarda la asociación. En desarrollo web se introduce la ruta absoluta. Se valida su destino canónico y acceso, rechazando ubicaciones inseguras. Abrir/asociar no crea archivos ni inicia herramientas.

El origen es `.konsora/tasks.json`; el [formato v1, esquema y ejemplo](formato-tareas.md) permiten que una IA externa lo genere. No se interpreta Markdown arbitrario ni el backlog de desarrollo `TASKS.md`.

Si falta el archivo, **Preparar archivo de tareas** muestra destino y confirmación antes de crearlo. Con tareas SQL anteriores aparece **Revisar migración a archivos**, que incluye conteos de tareas, intentos y eventos. No se borran las filas anteriores ni se sobrescribe un `tasks.json` existente. Una carpeta copiada permite reconstruir tarjetas e historial sin la base privada de otra instalación.

El tablero relee el archivo cada 2,5 segundos y al actualizar. Los cambios externos se detectan aunque no aumente `version`. Ante JSON inválido o desaparición se conserva la última lectura como no editable; al corregir el archivo se recupera la vista. Los guardados en conflicto conservan el borrador; **Recargar detalle** lo descarta explícitamente para releer. El formato documenta los límites de concurrencia con editores que no cooperan con el bloqueo.

**Comprobar carpeta** actualiza disponibilidad; **Desvincular carpeta** retira solo la asociación. El borrado confirmado de un registro de proyecto elimina sus datos SQL locales, incluidos históricos anteriores, y conserva intactos la carpeta, las tareas y sus archivos.

## Tablero y selección

El proyecto abre directamente el tablero. La configuración de carpeta es un desplegable; no hay navegación de chats. Se conservan columnas por estado, tarjetas, búsqueda, filtros por estado/bloqueo, edición manual, dependencias y orden.

Usa las casillas por tarjeta o **Seleccionar visibles**/**Deseleccionar visibles**. Los filtros no eliminan selecciones: el resumen enumera todas e indica cuántas están ocultas. Abrir un detalle conserva la selección; cambiar de proyecto o recargar la aplicación la reinicia sin perder tareas guardadas.

Los estados se actualizan manualmente. El historial compatible de resultados/intentos se puede consultar, pero no representa trabajo ejecutado por este MVP. Una tarea declarada hecha externamente requiere aceptación humana; las firmas de revisión se documentan en el formato. Si el almacenamiento de Konsora está dentro de la carpeta del proyecto, utiliza un directorio de datos de Konsora fuera antes de aceptar resultados para proteger su clave propia. Esto no se necesita para visualizar o copiar prompts.

Tab, Espacio y Enter permiten operar controles; Escape cierra el detalle. El área de columnas tiene desplazamiento horizontal propio. Los estados vacíos, de carga y de error incluyen recuperación.

## Generar y copiar el prompt

1. Selecciona las tareas deseadas, incluidas las que queden ocultas por filtros.
2. Añade, si quieres, texto en **Contexto adicional que autorizas incluir**. No se leen archivos de código, otros chats o notas implícitamente.
3. Pulsa **Preparar prompt** y revisa el origen, las tareas y los bloqueos. Las dependencias no seleccionadas aparecen solo como referencias; su trabajo no se añade.
4. Pulsa **Copiar prompt** y pégalo en tu herramienta de IA. Se relee el origen antes de copiar; si el portapapeles no permite escritura directa, se selecciona el texto validado para Ctrl+C.

Cambiar archivo, selección o contexto invalida la vista previa y obliga a regenerarla. Para exportar, escribe un nombre simple `.md` y pulsa **Guardar prompt nuevo**. El destino es `.konsora/prompts/` dentro del proyecto; no se sobrescriben archivos ni se modifica `tasks.json` al copiar/guardar.

Copiar no abre ni envía nada a Codex, Claude Code u otra herramienta. La persona pega el texto y gestiona allí sus permisos/sesión/ejecución. El MVP no supervisa ese proceso, no consulta modelos o cuotas y no tiene botón de ejecución. Abrir herramientas y entregar automáticamente el prompt, varios agentes/modelos y colas son posteriores al MVP.

## API local actual

- `/health`: estado del servicio.
- `/projects`: registro local, asociación de carpeta y borrado confirmado.
- `/projects/{id}/tasks`: tareas, detalle, estados manuales y migración/inicialización explícitas.
- `/projects/{id}/tasks/board`: tareas y origen/revisión de una misma lectura.
- `/projects/{id}/tasks/prompt/preview`: selección, `expected_revision` y contexto.
- `/projects/{id}/tasks/prompt/validate`: revalidación con `prompt_fingerprint` antes de copiar.
- `/projects/{id}/tasks/prompt/save`: guardado explícito con nombre `.md`.

Las escrituras de tareas exigen `expected_version` y `expected_revision`; las ediciones parciales conservan campos omitidos y rechazan `null`. El prompt admite hasta 16000 caracteres de contexto y 256000 de salida, sin recorte automático. Los IDs/dependencias/rutas se validan según el formato.

Las rutas de `/connectors` y de conversaciones ya no existen: devuelven 404 y no aparecen en OpenAPI. Sus tablas/mensajes antiguos, igual que debates y propuestas, permanecen intactos hasta un borrado local explícitamente confirmado. No se inicia, detiene o cierra sesión en herramientas externas al abrir/cerrar Konsora.

## Comprobaciones

```bash
npm run test:board     # Tres casos de selección, resumen y filtros
npm run test:api       # Contratos actuales, archivos, prompts y conservación de datos
npm run build:desktop  # Tipos y builds web/nativo sin instalador
```

`npm run check` reúne tipos, build web y pruebas. En cambios acotados, ejecutar únicamente las comprobaciones afectadas. Las pruebas del MVP no llaman a modelos ni consumen cuotas; las de conectores/conversaciones retirados se sustituyen por inaccesibilidad de rutas y conservación del historial.

Las verificaciones [K-031](verification/K-031.md), [K-032](verification/K-032.md) [K-024](verification/K-024.md) y [K-025](verification/K-025.md) acreditan simplificación, seguridad, flujo de copia y distribución. Los informes anteriores describen su implementación histórica y no añaden funcionalidades al MVP actual.

## Automatización visual local

Para inspeccionar la ventana de Ubuntu por AT-SPI y obtener capturas en una sesión Xvfb aislada, consulta [Automatización local](automatizacion-local.md). No requiere APIs de pago ni modifica la autenticación del servicio.
