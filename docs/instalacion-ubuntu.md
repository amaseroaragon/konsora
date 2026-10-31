# Instalación Ubuntu

El MVP se distribuye como `.deb` para **Ubuntu 24.04 amd64**, con sesión gráfica y DBus. El servicio Python va empaquetado: no hace falta instalar Python, Node, Rust ni herramientas de IA para utilizarlo. La compilación se realiza en Ubuntu 24.04; no se declara compatibilidad con versiones anteriores ni otras arquitecturas sin verificarlas.

## Crear e instalar el paquete

Con los requisitos de desarrollo de [la guía](desarrollo.md):

```bash
npm run package:ubuntu
```

El instalador queda en `apps/desktop/src-tauri/target/release/bundle/deb/`. Desde la carpeta que contiene el `.deb`:

```bash
sudo apt install ./Konsora_0.1.0_amd64.deb
```

Abre **Konsora** desde Aplicaciones o ejecuta `konsora-desktop`. No arranques una API manualmente. La aplicación inicia su servicio privado en un puerto libre de loopback; no necesita 8000 ni 1420. Otra apertura enfoca la ventana existente. Cerrar la última ventana detiene el servicio; si el padre cae, el cierre de su stdin detiene al hijo. Si el servicio falla durante el uso, conserva el borrador, pulsa **Comprobar conexión**, después **Actualizar proyectos/tareas**, y revisa el archivo antes de repetir una escritura.

## Datos y actualización

El registro e historial local están en `${XDG_DATA_HOME:-~/.local/share}/app.konsora.desktop/`, con directorio 0700 y archivos nuevos privados. Las tareas y prompts siguen en las carpetas asociadas (`.konsora/tasks.json` y `.konsora/prompts/`). Abrir una carpeta no escribe archivos automáticamente.

Cierra Konsora antes de instalar otra versión con el mismo comando de apt. El paquete no instala ni elimina archivos en tus proyectos, ni contiene scripts que borren el directorio de datos. Desinstalar el paquete o borrar únicamente la caché de Konsora no elimina tareas ni el registro. No borres el directorio de datos si quieres conservar asociaciones, histórico SQL y firmas de revisión. Para mover tareas a otro ordenador basta su carpeta; las aceptaciones humanas pueden requerir revisión allí, como explica el formato.

## Importar un registro anterior (opcional)

No se busca ni mueve automáticamente la base de desarrollo `.local/konsora.sqlite3`. Para conservar esos proyectos/historial en la instalación, **antes de su primera apertura**, cierra Konsora y el servidor anterior y ejecuta:

```bash
/usr/lib/Konsora/backend/backend \
  --data-dir "${XDG_DATA_HOME:-$HOME/.local/share}/app.konsora.desktop" \
  --import-registry /ruta/absoluta/al/registro/anterior/konsora.sqlite3
```

La operación hace un backup SQLite consistente y migra únicamente la copia, conserva todas las tablas/filas y copia `instance-review.key` si existe junto al origen. No modifica el registro original ni recorre/escribe las carpetas de proyectos. El origen y su clave deben permanecer juntos hasta completar la importación. Un destino con registro o clave existentes se rechaza: no hay mezcla ni sobrescritura silenciosa. Si ya abriste la instalación, puedes volver a asociar las carpetas sin perder sus tareas; cualquier sustitución del registro requiere gestionar explícitamente su copia de seguridad, fuera de este importador.

## Diagnóstico

Con Konsora cerrada:

```bash
/usr/lib/Konsora/backend/backend \
  --data-dir "${XDG_DATA_HOME:-$HOME/.local/share}/app.konsora.desktop" \
  --diagnose
```

Devuelve solo versión de esquema, integridad, número de proyectos y permisos; no muestra tareas, claves ni credenciales. No inicia HTTP ni migra el registro. Un bloqueo activo rechaza el mantenimiento. Comprueba los permisos del directorio y reinstala el paquete si falta un recurso. No elimines bases ni archivos de proyectos para resolver un fallo de arranque.

La sesión de desarrollo web tiene un mecanismo separado descrito en [desarrollo](desarrollo.md). No uses `uvicorn main:app` ni expongas el backend en una interfaz pública. La autenticación propia de Konsora no gestiona cuentas de proveedores.

Se han seguido los contratos oficiales de [instancia única](https://v2.tauri.app/plugin/single-instance/) y [paquetes Debian](https://v2.tauri.app/distribute/debian/). La evidencia y límites de instalación están en [K-025](verification/K-025.md).
