# Konsora

Aplicación de escritorio local-first para organizar el trabajo con modelos y agentes de IA desde Ubuntu.

## Funcionalidades actuales

- Crear, listar, abrir y renombrar proyectos.
- Eliminar proyectos con confirmación explícita.
- Guardar los proyectos en SQLite y recuperarlos tras reiniciar.
- Comprobar la conexión con el servicio local y reintentar ante errores.

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

Los datos se guardan en `.local/konsora.sqlite3`. Para elegir otro archivo, exporta `KONSORA_DATABASE_PATH` antes de iniciar la API. No se necesitan claves ni servicios de pago.

## Comprobaciones

```bash
npm run check          # Tipos, compilación web y pruebas de API
npm run build:desktop # Compilación nativa sin instalador
```
