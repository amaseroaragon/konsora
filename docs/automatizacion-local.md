# Inspección y pruebas visuales locales en Ubuntu

Verificado el 2026-10-31. No usa APIs de pago, modelos ni credenciales de proveedores. No cambia el código de producto ni desactiva su autenticación. Las herramientas de Computer Use no exponían ventanas, pero el proceso local sí podía acceder al bus de accesibilidad.

## Solución comprobada

- **Ventana Wayland abierta:** Python del sistema + introspección GI + AT-SPI. Permite leer nombres/roles/texto y activar botones/casillas de Konsora. Se abrió y cerró un detalle en la ventana original sin editar tareas.
- **Capturas y pruebas repetibles:** el mismo binario de Konsora en Xvfb, con sesión D-Bus y directorios XDG separados. AT-SPI navega; ImageMagick captura solo la ventana de prueba. El servicio de Konsora arranca normalmente y sigue autenticado. No se toca el registro de proyectos del usuario.
- **Teclado y formularios de la auditoría:** eventos XTEST locales y portapapeles GTK de la sesión aislada. Se validó el cambio de estado React después de pegar texto; asignar texto mediante accesibilidad no siempre equivale a una entrada del usuario en WebKit. El pequeño CLI versionado cubre inspección, clics y capturas; no es todavía una suite completa ni un robot de teclado.

La sesión del usuario es Wayland. `xdotool` no estaba instalado y no es una solución general para ventanas Wayland, como advierte su [documentación oficial](https://github.com/jordansissel/xdotool#wayland). La captura directa `org.gnome.Shell.Screenshot.ScreenshotWindow` fue rechazada con `AccessDenied`; no se cambió la configuración de GNOME para saltarlo. Para capturar la ventana Wayland original se puede usar el [portal Screenshot](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Screenshot.html), con su interacción/consentimiento normal: esa vía no se ha probado aquí. Las capturas adjuntas proceden de Xvfb, no del compositor Wayland.

## Requisitos

Ya estaban disponibles Python 3 del sistema, `gi`, el typelib `Atspi`, GTK, `xwininfo`, ImageMagick (`import`), D-Bus y Xvfb extraído bajo `.tools/xvfb/root/usr/bin/Xvfb`. No se instaló software. En otra máquina los paquetes Ubuntu correspondientes son `python3-gi`, `gir1.2-atspi-2.0`, `gir1.2-gtk-3.0`, `x11-utils`, `imagemagick`, `dbus` y `xvfb`. El lanzador prefiere Xvfb del PATH y utiliza la copia local solo si existe.

AT-SPI necesita acceso a la sesión del usuario; un sandbox puede impedirlo. Ejecutar desde una terminal de la sesión gráfica. Referencia de [Atspi.Accessible](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/class.Accessible.html).

## Inspeccionar la ventana abierta

Obtener el PID local (sin imprimir entornos ni secretos):

```bash
pgrep -af 'target/(debug|release)/konsora-desktop'
/usr/bin/python3 scripts/inspect-ui.py --pid PID tree
/usr/bin/python3 scripts/inspect-ui.py --pid PID click 'Carpeta y proyecto'
/usr/bin/python3 scripts/inspect-ui.py --pid PID tree
```

Sustituir `PID` por el proceso correcto. Los nombres se toman del árbol actual, no se adivinan. El script rechaza controles ambiguos/deshabilitados. Activar un botón solo confirma que se solicitó la acción: releer el árbol y comprobar el resultado. `click` puede escribir o borrar si se elige uno de esos controles; usar datos desechables para tales pruebas.

## Sesión aislada para capturas

Con un build release existente:

```bash
/usr/bin/python3 scripts/visual-session.py
```

Si no está compilado, usar `npm run build:desktop`. También se puede iniciar el desarrollo habitual con `npm run dev:desktop` y ejecutar otra instancia aislada del binario debug mientras Vite permanece activo:

```bash
/usr/bin/python3 scripts/visual-session.py --binary apps/desktop/src-tauri/target/debug/konsora-desktop
```

El lanzador imprime la ruta de `session.json`. Cada ejecución crea datos nuevos en `.local/visual-sessions/`; no copia ni asocia proyectos automáticamente. Xvfb escucha solo por socket local. La prueba tiene un escritorio virtual de 1600×1000 y una ventana con el tamaño definido por Konsora. No se añade `-ac` ni se abre un puerto de control remoto.

En otra terminal, sustituir la ruta de ejemplo por la impresa:

```bash
/usr/bin/python3 scripts/inspect-ui.py --session .local/visual-sessions/SESION/session.json tree
/usr/bin/python3 scripts/inspect-ui.py --session .local/visual-sessions/SESION/session.json shot inicio.png
/usr/bin/python3 scripts/inspect-ui.py --session .local/visual-sessions/SESION/session.json click '+ Nuevo proyecto'
/usr/bin/python3 scripts/inspect-ui.py --session .local/visual-sessions/SESION/session.json tree
/usr/bin/python3 scripts/inspect-ui.py --session .local/visual-sessions/SESION/session.json shot dialogo.png
/usr/bin/python3 scripts/inspect-ui.py --session .local/visual-sessions/SESION/session.json click 'Cancelar'
```

Las capturas se guardan en la carpeta de la sesión; un nombre existente se rechaza. Ctrl+C en el lanzador cierra los procesos de esa sesión, no la ventana personal. Los archivos de prueba y logs se conservan para diagnóstico. Los manifiestos son locales y de confianza; no ejecutar comandos con manifiestos recibidos de terceros.

## Pruebas visuales y límites

Las capturas permiten revisión humana y comparación antes/después con el mismo tamaño, datos, fuentes y posición de desplazamiento. Una comparación de píxeles por sí sola no demuestra que el flujo funcione: acompañarla de afirmaciones sobre selección, texto generado, archivo guardado y estado final. Las fechas, foco, animaciones y barras de desplazamiento pueden producir diferencias legítimas. Xvfb no verifica decoraciones de GNOME, escalado HiDPI ni permisos del compositor Wayland.

En esta auditoría se comprobó carpeta → tablero → selección parcial → filtro → revisión → copia exacta, invalidación por contexto, error/recuperación de JSON, exportación sin sobrescritura y pérdida de borrador. [Resultados y capturas](verification/UX-2026-10-31.md). Las pruebas exploratorias se realizaron en `.local/ux-audit/`; los dos scripts de `scripts/` son las utilidades mínimas reutilizables, no una suite automática de esos escenarios.

Para una futura suite que necesite selectores DOM, Tauri documenta [tauri-driver + WebKitWebDriver en Linux](https://tauri.app/develop/tests/webdriver/manual-setup/). No se instalaron: AT-SPI y Xvfb bastaron para esta inspección y además permiten recorrer el selector GTK nativo. Playwright en Chromium comprobaría la versión web, pero no sustituiría este recorrido del WebView de escritorio.
