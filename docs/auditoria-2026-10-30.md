# Auditoría y rediseño de Konsora — 2026-10-30

## Conclusión

El código responde al plan anterior: proyectos, conversaciones y un módulo de debate simulado. La necesidad expresada ahora es gestionar y ejecutar trabajo desde un tablero con una sola cuenta. El desajuste principal estaba en la prioridad del producto: tablero y ejecución se habían dejado para después del MVP, y las tareas dependían de un debate con dos proveedores. No hace falta reconstruir toda la aplicación; sí cambiar su flujo principal y añadir el modelo y supervisor de tareas que aún no existen.

Esta revisión es documental. El debate permanece en el código hasta K-014, y no se presentan como existentes ni el tablero ni la ejecución. El nuevo orden, aceptación y pruebas están en [TASKS.md](../TASKS.md).

## Evidencias del repositorio

| Área | Estado observado | Decisión |
| --- | --- | --- |
| Escritorio y servicio | React/TypeScript en Tauri y FastAPI; scripts de desarrollo separados. El `main.rs` solo crea la ventana y no administra la API. | Reutilizar tecnologías; integrar ciclo de vida al distribuir, con seguridad local antes de ejecutar agentes. |
| Proyectos | CRUD persistente; `Project` contiene identidad, nombre y fechas. No tiene carpeta de trabajo. | Conservar y añadir asociación explícita a carpeta antes de cualquier ejecución. |
| Almacenamiento | SQLite con tres migraciones transaccionales: proyectos; conversaciones/mensajes; debates/propuestas. No hay tablas de tareas, dependencias, lotes ni intentos. | Migraciones aditivas; conservar datos existentes y crear las entidades de trabajo. |
| Interfaz | `App.tsx` abre proyectos; `ProjectViews.tsx` ofrece Conversaciones y Debate, con chats por defecto. No hay tablero ni selección de tareas. | Tablero principal, navegación de proyectos y panel de detalle; chat secundario. |
| Chat | Historial aislado por proyecto, modelo y procedencia por mensaje; proveedor/modelo se eligen por conversación. | Reutilizar historial y catálogo; proveedor global y autorización explícita antes de transmitir contexto antiguo tras cambiar de cuenta/proveedor. |
| Conector real | `CodexCLIConnector` admite la serie 0.165.x, comprueba login de ChatGPT y rechaza API. `AgentConnector` solo ofrece estado, modelos y envío de texto. | Base útil para sesión y consulta; no acredita un contrato de ejecución ni una gestión de logout/login desde la aplicación. |
| Restricciones de consulta | `command()` fuerza directorio temporal, sandbox de solo lectura y herramientas desactivadas. `parse_output()` rechaza herramientas inesperadas. | Mantener las restricciones del chat y diseñar por separado el modo de trabajo sobre archivos. No basta con enviar una descripción de tarea al chat. |
| Procesos | `cli_process.py` usa argumentos sin shell, entorno por lista positiva, límites y limpieza del grupo de procesos. `send_while_connected()` cancela al desconectarse el cliente. El bloqueo del conector vive en memoria y devuelve ocupado; no es una cola. | Reutilizar las garantías de procesos; el supervisor de tareas debe persistir intentos y sobrevivir a navegación/reconexión sin duplicar ni cancelar trabajo implícitamente. |
| Debate | Rutas, vistas, simuladores y tablas propios; no existe conector real de Claude. K-005A acredita simulación, no deliberación real ni tareas. | Retirar la función y sus operaciones; preservar las filas históricas y la evidencia de verificación. Cancelar Claude para debate, rondas y consenso. |
| Seguridad local | Desarrollo en loopback, CORS y CSP; chat/conectores/debates validan host/origen. Las rutas de proyectos no aplican esa dependencia y no existe autenticación de instancia. | Extender protección antes de permitir escritura de agentes; loopback y CORS no sustituyen autenticación. |
| Cuota y resultado | Clasificación de errores de cuota, sin consulta de ventanas/reinicios ni estimación; no hay registro de operaciones, cambios o revisión de tareas. | Estado global de cuota cuando haya mecanismo oficial; intentos y resultados revisables, sin promesas de consumo exacto. |

Referencias locales: [migraciones](../services/api/konsora_api/database.py), [proyectos](../services/api/konsora_api/projects.py), [navegación](../apps/desktop/src/ProjectViews.tsx), [conector](../services/api/konsora_api/connectors.py), [procesos](../services/api/konsora_api/cli_process.py), [contrato de consulta](../services/api/konsora_api/connector_routes.py), [conversaciones](../services/api/konsora_api/conversations.py), [servicio](../services/api/konsora_api/main.py) y [arranque nativo](../apps/desktop/src-tauri/src/main.rs).

## Decisiones para el nuevo producto

1. Un proveedor y una cuenta activos globalmente, comenzando por Codex/ChatGPT. Una suscripción basta para el MVP. El cambio futuro es una transición de sesión, no un enrutador entre cuentas. Konsora no necesita cerrar sesiones ajenas en otros programas: debe comprobar la transición del CLI que utiliza y bloquear sus propios envíos mientras no esté validada.
2. Crear tareas manuales y trabajar en un Kanban antes de pedir planificación a la IA. El chat podrá proponer tareas editables más adelante, sin debates ni creación/ejecución automática de propuestas.
3. Seleccionar varias tarjetas prepara un lote revisable. La primera versión las ejecuta secuencialmente; el paralelismo añade problemas de conflictos y aislamiento que se posponen explícitamente.
4. La aprobación fija tareas, versiones, carpeta, contexto, permisos y modelo. Nada fuera de esa selección se ejecuta por ser dependencia. Un cambio de sesión o alcance invalida lo autorizado y exige revisión.
5. Separar tarea e intento: un intento puede fallar o cancelarse dejando cambios parciales. Una respuesta del agente no certifica cumplimiento; las tareas pasan a revisión y el usuario acepta el resultado.
6. Mantener proyectos, chats y procedencia histórica. Retirar el debate sin borrar bases, migraciones, filas o historia Git. Los informes anteriores no se reescriben como si verificaran el nuevo producto.
7. Mantener seguridad y suscripciones oficiales: sin APIs de pago, extracción de credenciales o ampliación silenciosa de permisos. Documentar y detener el criterio afectado si no se puede verificar el mecanismo real.

## Referencia externa y límites de la auditoría

La [publicación de X facilitada](https://x.com/XMihura/status/2115110716629987376) no pudo consultarse: el acceso devolvió error y después HTTP 403. No se ha visto su vídeo ni se afirma reproducir su diseño exacto. Los requisitos principales proceden de la descripción del usuario.

Como referencia complementaria se consultó el [repositorio público Kanvas del mismo autor](https://github.com/XMihura/Kanvas): presenta un tablero de tareas con estados, dependencias y revisión humana. Sirve para orientar la interacción; no prueba qué contiene la publicación ni que exista en Konsora un lanzador de agentes. No se ha instalado, copiado ni integrado su código. Antes de cualquier reutilización se revisará licencia y compatibilidad.

No se han vuelto a validar en esta auditoría las condiciones actuales de ejecución de proveedores ni se ha iniciado/cerrado una sesión. La nueva ejecución necesita su propia comprobación oficial en K-019. Claude y Antigravity no se habilitan con este rediseño; cualquier alternativa queda condicionada a K-026 y a una prueba real cuando corresponda.

## Comprobaciones de esta revisión

- `npm run check`: comprobación de tipos, build web y **146 pruebas de API correctas**; un aviso existente de deprecación Starlette/HTTPX. La suite utiliza simuladores/CLIs falsos y no consume cuota real.
- Inspección del código, scripts, esquema e historial; no se ha modificado comportamiento de la aplicación ni añadido dependencias.
- No se ha repetido el arranque gráfico ni el build nativo: esta revisión documental no acredita el nuevo flujo de escritorio. La evidencia anterior se conserva en `docs/verification/`.
- El README queda en 10 líneas de descripción. Su guía técnica anterior se conserva en [docs/desarrollo.md](desarrollo.md), identificando el estado anterior al rediseño; el plan anterior está [archivado](plans/2026-10-30-plan-anterior.md).
- Verificación documental: enlaces locales válidos, K-014–K-029 únicas y pendientes, README de 10 líneas sin referencias al backlog y `git diff --check` correcto. `bash -n scripts/desktop.sh` correcto tras actualizar su indicación de requisitos a `docs/desarrollo.md`.

**Siguiente implementación: K-014, retirada funcional del debate.** Ninguna tarea nueva queda completada por esta auditoría.
