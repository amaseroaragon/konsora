# Konsora

El backlog operativo vigente es [TASKS.md](../TASKS.md). El tablero y la ejecución supervisada se implementarán en su orden; por ahora se reutilizan los proyectos y chats existentes.

Aplicación de escritorio local-first para organizar el trabajo con modelos y agentes de IA desde Ubuntu.

## Funcionalidades actuales

- Crear, listar, abrir y renombrar proyectos.
- Eliminar proyectos con confirmación explícita.
- Guardar los proyectos en SQLite y recuperarlos tras reiniciar.
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

## Conversaciones por proyecto

1. Crea o abre un proyecto. En «Conversaciones», escribe un nombre y pulsa **+ Nuevo chat**.
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
npm run check          # Tipos, compilación web y pruebas de API
npm run build:desktop # Compilación nativa sin instalador
```

Las pruebas automatizadas usan simuladores y ejecutables ficticios locales; no invocan el Codex real ni consumen cuota. Retirada de debates y conservación del historial: [verificación K-014](verification/K-014.md). Los informes anteriores son históricos. Conversaciones: [verificación K-004](verification/K-004.md). Conector y prueba real inicial: [verificación K-003](verification/K-003.md).
