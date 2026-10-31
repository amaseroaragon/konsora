# Konsora — Guía para agentes de desarrollo

## Producto y alcance vigente

Konsora es una aplicación de escritorio local-first, inicialmente para Ubuntu, para visualizar tareas que viven en los archivos de un proyecto, seleccionar varias y generar un prompt que la persona copia y pega en su herramienta de IA.

**MVP: abrir carpeta → detectar tareas → tablero → seleccionar varias → revisar prompt → copiar y pegar fuera de Konsora.** No incluye chats/conversaciones, conectores de IA, login/logout, cuentas globales, selección de proveedor/modelo, cuotas, simuladores, colas ni ejecución automática. No se deben reinstaurar estas funciones por instrucciones de planes antiguos.

Las tareas pertenecen a `.konsora/tasks.json`, con formato v1 e IDs estables, incluyendo actividad e historial compatible. Una IA o la persona puede generar/editar el archivo sin Konsora; la aplicación detecta sus cambios. SQLite conserva registro de proyectos y datos anteriores, sin prevalecer sobre los archivos. La exportación opcional de prompts a `.konsora/prompts/` se conserva.

Abrir Codex, Claude Code u otras herramientas y entregarles automáticamente un prompt es trabajo posterior al MVP. Varios agentes, modelos y paralelismo también quedan para versiones posteriores, con alcance explícito antes de implementarse. Cada herramienta gestionará su propia sesión; no construir un gestor de cuentas de Konsora.

## Forma de trabajar

1. Lee `.konsora/tasks.json` antes de empezar: es el único backlog operativo de este repositorio. Para trabajo del backlog, consulta descripción, criterios, estado y dependencias; sigue `sort_order` (no la posición en el array ni el número del ID), una tarea por vez y dentro del alcance autorizado por la persona. Una tarea pendiente no autoriza su implementación: las propuestas registradas solo para auditoría y las funcionalidades aplazadas requieren una petición explícita. No anticipes funcionalidades posteriores.
2. Inspecciona el código, implementa el cambio mínimo, ajusta las pruebas afectadas y ejecuta solo las comprobaciones necesarias. Actualiza las tareas únicamente en `.konsora/tasks.json`, conservando IDs e historial y respetando el formato v1 y los cambios externos. Marca una tarea como completada únicamente al cumplir sus criterios de aceptación y enlaza la evidencia pertinente; cambiar `status` no sustituye la aceptación humana en Konsora.
3. Mantén la aplicación ejecutable al finalizar cada tarea. Resume cambios, comprobaciones y resultado, decisiones/limitaciones relevantes y siguiente tarea pendiente.
4. Realiza commits locales pequeños y descriptivos cuando el entorno lo permita. No publiques ni hagas push sin aprobación.
5. Consulta si hace falta una decisión de producto importante, credenciales, gastos, permisos o una acción destructiva no autorizada. No inventes claves ni uses cuentas personales.
6. No elimines código, historial o datos sin una razón explícita y comprobada. Retirar una función no autoriza borrar sus tablas, filas o migraciones aplicadas. No escribas fuera del repositorio salvo autorización.
7. Prefiere código simple, tipado y mantenible, con errores controlados y estados de carga/error en UI. Evita dependencias y abstracciones innecesarias; explica cualquier dependencia nueva.
8. Documenta las limitaciones de verificación. No declares completada una tarea si falta una comprobación esencial.

## Principios técnicos

- Tauri + React + TypeScript para escritorio; Python + FastAPI para servicio local; archivos de proyecto como fuente de tareas y SQLite para registro/configuración y datos históricos. Separar contratos frontend/backend.
- Un único formato canónico de tareas: `.konsora/tasks.json`, también para el desarrollo de Konsora. No mantener Markdown y JSON como fuentes paralelas ni interpretar planes Markdown como trabajo ejecutable automáticamente. El esquema y ejemplo están en `docs/formato-tareas.md`.
- Leer, detectar, seleccionar y copiar prompts funciona sin instalaciones ni sesiones de proveedores. El backend no debe buscar ejecutables de IA, consultar sus sesiones/modelos ni iniciar procesos de agentes.
- Los prompts contienen solo el trabajo seleccionado y contexto expresamente incluido. No añadir dependencias ni leer archivos/código/chats implícitamente. Mostrar dependencias externas como referencias/bloqueos.
- Revalidar origen y contenido antes de editar/copiar/guardar; un modelo puede cambiar el archivo sin aumentar `version`. Detectar conflictos y conservar borradores; no sobrescribir cambios externos ni destinos existentes silenciosamente.
- Abrir o asociar una carpeta no escribe archivos automáticamente. Inicializar, migrar o editar requiere una acción explícita. Resolver/rechazar rutas inseguras y enlaces fuera de la carpeta aprobada.
- Conservar los datos SQL anteriores y las migraciones. Desvincular/eliminar el registro de proyecto no borra sus archivos. Los chats/debates anteriores quedan como datos históricos sin UI ni rutas operativas.
- Estados y revisiones manuales no acreditan una ejecución supervisada. Conservar el formato/historial compatible sin lanzar procesos ni reanudar intentos importados. La aceptación de un resultado no puede fabricarse por cambiar un campo externo.
- Servicio únicamente en loopback; autenticar la instancia y validar origen/host antes de distribuir (K-032). CORS por sí solo no autentica un cliente local. No incluir secretos en código, commits, UI o logs.

## Integraciones futuras

- Solo al abordar las tareas posteriores al MVP: verificar documentación, versiones y condiciones oficiales antes de integrar cada herramienta. Un modo headless no demuestra permiso para envolver el CLI en una aplicación de terceros.
- Autenticación y credenciales las gestiona cada herramienta oficial. Konsora no recibe contraseñas/tokens, ni lee, copia o exporta almacenes de credenciales. No heredar claves de API ni usar APIs de pago como alternativa automática.
- Lanzar/entregar un prompt requiere acción explícita sobre una selección y versión revisadas. No añadir trabajo ni cambiar de herramienta/cuenta automáticamente. No prometer supervisión/cancelación que el mecanismo oficial no permita.
- Varios agentes/modelos o ejecuciones paralelas requieren diseñar permisos, aislamiento, conflictos y límites. No sincronizar supuestas memorias nativas de proveedores. No reinstaurar debates entre modelos.
- El bloqueo histórico de Antigravity sigue pendiente de revisión oficial; este cambio no lo resuelve.

## Documentación y calidad

- `.konsora/tasks.json` es el único backlog operativo: definición, criterios, estado, dependencias y orden se mantienen allí. `AGENTS.md` fija las reglas y límites de producto; los planes archivados en `docs/plans/` y los informes de verificación conservan decisiones y evidencia, sin dirigir el trabajo ni duplicar estados pendientes.
- `docs/desarrollo.md` documenta instalación, comandos y límites actuales. `README.md` contiene únicamente 5–10 líneas descriptivas, sin backlog ni instrucciones técnicas.
- Mantener pruebas de lógica/API afectadas y describir las comprobaciones de escritorio. No repetir suites de funciones retiradas ni hacer inferencias reales para validar el MVP de copiar prompts.
