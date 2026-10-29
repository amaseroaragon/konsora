# Konsora

Aplicación de escritorio local-first para organizar el trabajo con modelos y agentes de IA desde Ubuntu.

## Funcionalidades actuales

- Crear, listar, abrir y renombrar proyectos.
- Eliminar proyectos con confirmación explícita.
- Guardar los proyectos en SQLite y recuperarlos tras reiniciar.
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

Los datos se guardan en `.local/konsora.sqlite3`. Para elegir otro archivo, exporta `KONSORA_DATABASE_PATH` antes de iniciar la API. Los proyectos y el simulador no requieren una cuenta. Las consultas reales utilizan los límites de tu suscripción de ChatGPT mediante Codex CLI; Konsora no integra APIs de pago.

## Codex CLI con tu suscripción

Instala el [Codex CLI oficial](https://learn.chatgpt.com/docs/cli) y entra con ChatGPT desde tu terminal:

```bash
codex --version
codex login
codex login status
```

Esta integración está validada con **Codex CLI 0.165.x**; otras versiones se rechazan hasta verificar sus opciones de aislamiento. El último comando debe indicar `Logged in using ChatGPT`. Konsora consulta ese estado sin leer archivos de autenticación. Si detecta login por API, deshabilita el envío: cambia la sesión mediante el CLI oficial, sin introducir claves en Konsora.

1. Inicia API e interfaz con los comandos anteriores.
2. En «Consulta con tu suscripción», prueba **Simulado** para verificar sin consumir cuota.
3. Elige **Codex CLI** y pulsa **Actualizar conectores** si acabas de iniciar sesión.
4. Escribe el prompt, confirma el uso de cuota y pulsa **Consultar Codex con ChatGPT**. La confirmación se solicita en cada envío.

El modelo predeterminado lo elige Codex. Para elegir uno accesible para tu cuenta, exporta `KONSORA_CODEX_MODEL` en la terminal del backend y reinicia el servicio. Si `codex` no está en su `PATH`, configura `KONSORA_CODEX_BIN` con la ruta del ejecutable oficial. No se admite configurar comandos, flags o URLs desde la UI.

K-003 es una consulta de texto: no envía archivos de proyectos, no guarda conversaciones y desactiva herramientas, comandos, hooks, plugins y subagentes. Usa un directorio temporal bajo `.local/codex`, sandbox de solo lectura, entorno sin claves de API y configuración aislada por invocación; el CLI conserva y renueva su propia sesión. La configuración personal de modelos/plugins no se carga en estas consultas. El login y los tokens nunca se copian al repositorio ni se devuelven a la UI.

Hay un límite de 120 segundos para la consulta y 512 KiB por flujo de salida. **Cancelar consulta** detiene el proceso local y sus descendientes; no devuelve la cuota ya consumida. No hay reenvíos automáticos desde Konsora. Las respuestas se muestran como texto y los fallos del CLI se convierten en mensajes controlados, sin mostrar sus diagnósticos.

Claude Code queda para K-005, previa comprobación de sus condiciones de integración. Antigravity sigue condicionado a K-013: su [FAQ oficial](https://antigravity.google/docs/faq/) no permite envolver su CLI en aplicaciones de terceros con planes de consumo. No se sustituye por una API de pago. El historial de conversaciones y la ejecución supervisada corresponden a K-004 y K-011; la autenticación del servicio local y el empaquetado se completarán antes de distribuir en K-012.

## Comprobaciones

```bash
npm run check          # Tipos, compilación web y pruebas de API
npm run build:desktop # Compilación nativa sin instalador
```

Las pruebas automatizadas usan ejecutables ficticios locales; no invocan el Codex real ni consumen cuota. Detalle y prueba real: [verificación K-003](docs/verification/K-003.md).
