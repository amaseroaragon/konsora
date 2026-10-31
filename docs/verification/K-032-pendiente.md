# Punto de pausa — K-032 / K-024 / K-025

Pausa solicitada por la persona el 2026-10-30. Registro histórico del punto de pausa; retomado el 2026-10-31. K-032 se cerró posteriormente en [su verificación](K-032.md); consultar el [backlog JSON](../../.konsora/tasks.json) para el estado vigente.

## Cambios en curso

- Middleware de instancia: Bearer privado, host/origen y cliente loopback obligatorios, sin secretos en respuestas.
- Servicio con puerto asignado por el SO, configuración privada por stdin y parada al cerrar el padre.
- Transporte Tauri por IPC: Rust conserva la clave; JavaScript no la recibe.
- Proxy web de desarrollo con autenticación HTTP y archivo privado de sesión.
- Empaquetado del backend con PyInstaller para no requerir Python en la instalación final.
- Pruebas existentes adaptadas al cliente autorizado y ocho casos de seguridad nuevos.

## Verificado

- 106 pruebas API correctas (incluidas las ocho de seguridad).
- Tres pruebas de lógica del tablero correctas.
- Tipos y build web correctos tras añadir los tipos de Node.
- Backend PyInstaller generado correctamente.

## Pendiente al retomar

1. Terminar/revisar la compilación Rust y validar el arranque y la copia en escritorio aislado; revisar tiempos de arranque, recuperación, parada y ausencia de secretos en logs. K-032 sigue abierta.
2. Actualizar `docs/desarrollo.md`: aún describe el antiguo arranque manual sin autenticación. El desarrollo nativo ahora prepara su backend; el desarrollo web usa `npm run dev:api` y `npm run dev:web`, con archivo privado `.local/dev-session.json` y autenticación HTTP de usuario `konsora`/clave de esa sesión. No publicar la clave en UI ni logs.
3. K-024: recorrido completo de dos proyectos, selección/filtros/dependencias, cambios/conflictos, migración, recuperación, portapapeles y fallback.
4. K-025: instancia única, instalación/diagnóstico, migración conservadora de datos anteriores y comprobación de instalación/cierre/permisos.
5. Actualizar evidencias/backlog y crear commits pequeños una vez verificado cada bloque. Los cambios siguen sin commit para no presentar una tarea incompleta como terminada.

## Entorno de QA

No utilizar ni detener los servidores existentes de la persona en 8000/1420. Usar puertos y datos aislados y comprobar identidad de la base antes de escribir. Se preparó Xvfb local en `.tools/xvfb/root/usr/bin/Xvfb`; usar DBus/XDG aislados para el recorrido nativo. No se han arrancado servicios de QA de esta iteración. Los artefactos y dependencias auxiliares están en directorios ignorados del repositorio.
