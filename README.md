# Konsora

Aplicación de escritorio local-first para organizar el trabajo con modelos y agentes de IA desde Ubuntu.

## Funcionalidades actuales

- Crear, listar, abrir y renombrar proyectos.
- Eliminar proyectos con confirmación explícita.
- Guardar los proyectos en SQLite y recuperarlos tras reiniciar.
- Comprobar la conexión con el servicio local y reintentar ante errores.
- Probar prompts con un proveedor simulado, sin internet ni consumo de tokens.
- Integración con la API oficial de OpenAI y errores de autenticación/red visibles. La prueba real con credenciales está pendiente.

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

Los datos se guardan en `.local/konsora.sqlite3`. Para elegir otro archivo, exporta `KONSORA_DATABASE_PATH` antes de iniciar la API. Los proyectos y el simulador no necesitan claves ni servicios de pago.

## Probar modelos

En «Prueba un modelo», selecciona **Simulado**, escribe un prompt y pulsa **Probar sin conexión**. Los prompts y las respuestas de esta pantalla no se guardan; las conversaciones persistentes llegarán en K-004.

Para usar **OpenAI**, necesitas una clave de OpenAI Platform y saldo o créditos de API. **ChatGPT Plus no incluye este consumo**. Otros planes pueden tener [créditos de API que deben activarse](https://developers.openai.com/api/docs/guides/chatgpt-api-credits); el acceso por API requiere su propia credencial. Konsora no utiliza la sesión ni las credenciales de ChatGPT/Codex.

Configura la clave y el ID exacto de un modelo de texto al que tenga acceso tu cuenta **solo en la terminal de la API**. Estos comandos solicitan la clave sin mostrarla ni escribir su valor en el historial:

```bash
set +x
read -r -s -p "Clave de API de OpenAI: " OPENAI_API_KEY
printf '\n'
export OPENAI_API_KEY
read -r -p "ID del modelo de OpenAI: " KONSORA_OPENAI_MODEL
export KONSORA_OPENAI_MODEL
npm run dev:api
```

Inicia la interfaz en otra terminal y pulsa **Actualizar proveedores**. Elegir OpenAI o consultar su configuración no envía peticiones externas. **Enviar a OpenAI · consume saldo** transmite el prompt y autentica mediante HTTPS exclusivamente contra `api.openai.com`. No hay reintentos automáticos; puedes limitar la salida entre 16 y 2048 tokens. Un timeout no garantiza que el proveedor no haya consumido tokens.

La clave permanece en la memoria y el entorno del backend durante la sesión: no se guarda en SQLite ni en archivos, no se devuelve a la UI y no se incluye en los logs de la aplicación. No la pegues en prompts, en el chat de desarrollo ni en variables `VITE_*` o archivos `.env`. Tras detener la API, ejecuta `unset OPENAI_API_KEY` en esa terminal. Reinicia la API al cambiar las variables.

Las peticiones usan `store: false` para desactivar el almacenamiento de respuestas de esta API; esto no equivale a una garantía de retención cero del proveedor. El destino es fijo y se desactivan proxies del entorno y redirecciones. Las conexiones que necesiten un proxy corporativo no están soportadas todavía. La configuración de credenciales es para desarrollo local; el llavero del sistema y la autenticación por sesión local siguen pendientes de K-012.

## Comprobaciones

```bash
npm run check          # Tipos, compilación web y pruebas de API
npm run build:desktop # Compilación nativa sin instalador
```
