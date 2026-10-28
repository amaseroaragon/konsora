# Konsora

Aplicación de escritorio local-first para reunir el trabajo con modelos y agentes de IA. La base inicial (K-001) incluye una ventana Tauri con React y TypeScript y una API local FastAPI. El alcance y el orden de implementación están en [TASKS.md](TASKS.md).

## Requisitos en Ubuntu

Preparado para Ubuntu 24.04 con sesión gráfica. Se necesitan Node.js 22.12 o posterior compatible con Vite (se recomienda Node 22 LTS), npm, Python 3.12 y Rust estable con Cargo.

Instala las bibliotecas de desarrollo de [Tauri para Linux](https://v2.tauri.app/start/prerequisites/):

```bash
sudo apt update
sudo apt install -y build-essential pkg-config curl wget file \
  libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev python3-venv
```

Si `apt update` falla por repositorios externos, revisa los errores de esos repositorios. No desactives la verificación de firmas. Las dependencias anteriores están en los repositorios oficiales de Ubuntu.

Para instalar Rust utiliza el [instalador oficial](https://www.rust-lang.org/tools/install). Si acabas de instalarlo, abre otra terminal para que `cargo` esté disponible. Comprueba las herramientas:

```bash
node --version
npm --version
python3 --version
cargo --version
pkg-config --modversion webkit2gtk-4.1
```

En el entorno inicial de este repositorio Rust está instalado en `.tools/cargo` y `.tools/rustup`, sin modificar el perfil del usuario. Los comandos `dev:desktop` y `build:desktop` lo detectan automáticamente. `.tools` no se versiona; no es necesario en instalaciones con Rust en el `PATH`.

## Instalación

Desde la raíz del repositorio:

```bash
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r services/api/requirements-dev.txt
```

Las versiones directas de Python están fijadas en `requirements*.txt`; npm y Cargo incluyen sus archivos de bloqueo. No se necesitan claves, cuentas ni servicios de pago.

Opcionalmente copia `.env.example` a `.env`. Vite lee ese archivo desde la raíz; `VITE_API_URL` tiene por defecto `http://127.0.0.1:8000`. Todas las variables `VITE_*` son públicas y se incluyen en el frontend: no deben contener secretos. Si cambias el puerto de la API, ajusta también el comando de arranque y `connect-src` en `apps/desktop/src-tauri/tauri.conf.json`.

## Desarrollo

Abre dos terminales en la raíz. En la primera inicia el backend:

```bash
npm run dev:api
```

La API escucha únicamente en `127.0.0.1:8000`, con recarga al editar `services/api`. Comprueba el contrato:

```bash
curl --fail http://127.0.0.1:8000/health
# {"status":"ok","service":"konsora-api"}
```

La documentación HTTP está en `http://127.0.0.1:8000/docs`.

En la segunda terminal abre el escritorio:

```bash
npm run dev:desktop
```

Tauri inicia Vite en `127.0.0.1:1420` y abre la ventana **Konsora**. La primera compilación de Rust puede tardar varios minutos. Los cambios de React se recargan durante el desarrollo. Si el puerto 1420 está ocupado, el arranque falla en lugar de cambiar a otro puerto.

Para trabajar solo en el frontend en un navegador:

```bash
npm run dev:web
# http://127.0.0.1:1420
```

Usa `dev:desktop` o `dev:web`, uno a la vez. Detén cada proceso con `Ctrl+C` en su terminal. El backend se inicia y detiene por separado; cerrar la ventana no lo detiene.

## Comprobaciones

```bash
npm run check          # TypeScript, bundle web y pruebas de API
npm run typecheck
npm run test:api
npm run build:desktop # Binario nativo, sin instalador
```

Con las versiones iniciales, Starlette emite un aviso de deprecación por el uso de HTTPX en su cliente de pruebas. Las pruebas pasan; el aviso afecta a la herramienta de pruebas, no al arranque ni a `/health`.

El bundle web queda en `apps/desktop/dist`; el binario nativo, en `apps/desktop/src-tauri/target/release/konsora-desktop`. Para abrir ese binario, inicia antes la API. El empaquetado y el ciclo de vida integrado del backend se abordarán en K-012.

El icono nativo se genera a partir de su SVG con `npm run tauri --workspace @konsora/desktop -- icon src-tauri/icons/icon.svg --output src-tauri/icons --png 128`.

Verificación manual de escritorio:

1. Ejecutar `dev:api` y `dev:desktop` desde dos terminales.
2. Confirmar que se abre una ventana con título Konsora y aparece **API conectada**.
3. Detener la API con `Ctrl+C` y pulsar **Comprobar conexión**: debe aparecer el error y una indicación para arrancar el backend.
4. Reiniciar la API y pulsar el botón: debe volver a **API conectada**.
5. Cerrar la ventana y comprobar que el proceso de desarrollo del escritorio termina. Detener la API desde su terminal.

El resultado de la verificación inicial está en [docs/verification/K-001.md](docs/verification/K-001.md).

## Estructura y contratos

```text
apps/desktop/
  src/                 # Pantalla de inicio y cliente HTTP tipado
  src-tauri/           # Ventana nativa, CSP y configuración de Tauri
services/api/
  konsora_api/         # Aplicación FastAPI y contrato /health
  tests/               # Contrato HTTP y orígenes CORS
scripts/desktop.sh     # Arranque con Rust estándar o local
```

`GET /health` devuelve `{ "status": "ok", "service": "konsora-api" }`. El backend valida el formato con Pydantic; el frontend lo tipa y valida al recibirlo. La pantalla distingue carga, éxito y error, admite reintentar y limita la espera a cinco segundos.

Dependencias: Tauri aporta la ventana nativa; React y TypeScript, la interfaz; Vite, el servidor y el bundle web. FastAPI define el contrato HTTP y Uvicorn ejecuta la API. Pytest y HTTPX se usan solo para pruebas. El resto lo proporcionan la biblioteca estándar y CSS, sin librerías de componentes.

## Alcance actual

Todavía no hay proyectos persistentes, chats, acceso a modelos ni ejecución de agentes. La siguiente tarea es K-002 (SQLite y proyectos). El backend solo sirve desarrollo local: CORS restringe los orígenes del frontend y la ventana no tiene permisos de sistema ni plugins adicionales. CORS no sustituye a la autenticación; antes de distribuir se asegurará la comunicación local y el ciclo de vida del backend, como establece K-012.
