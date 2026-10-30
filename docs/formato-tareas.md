# Archivos portables de tareas — v1

El único origen del tablero es `.konsora/tasks.json` en la carpeta asociada. No se interpreta `TASKS.md` ni Markdown arbitrario. Una IA externa puede escribir el JSON sin Konsora ni una cuenta de proveedor. El [ejemplo mínimo](examples/portable-project/.konsora/tasks.json) y el [JSON Schema](schemas/tasks-v1.schema.json) definen el contrato.

La raíz contiene `schema_version: 1`, `tasks` y, opcionalmente, `attempts`, `activity` y `reviews`. Se mantiene el historial en el mismo documento para guardar tareas/resultados/revisiones juntos mediante una única sustitución atómica. No hay un segundo archivo ni una tabla SQL que prevalezca sobre él.

Cada tarea tiene ID estable (1–80 letras ASCII, dígitos, punto, guion o guion bajo; empieza por letra/dígito), título (1–120), descripción y criterios (hasta 16000 cada uno), orden entero no negativo, estado, versión positiva y dependencias del mismo documento. IDs humanos como `T-001` y UUID son válidos. Fechas ISO con zona horaria opcionales; omitirlas no genera fechas nuevas al leer. No se admiten campos desconocidos, IDs/claves JSON repetidos, autodependencias, referencias inexistentes ni ciclos.

Estados declarados: `proposal`, `pending`, `in_progress`, `in_review`, `done`. Los intentos tienen estado independiente: `running`, `succeeded`, `failed`, `cancelled`, `interrupted`; conservan instantánea de tarea, modelo/conector, fechas, resultado y error. Actividad ordenada por ID; el actor declarado en un archivo externo es informativo, no una prueba de identidad. Ninguno de estos registros inicia procesos.

Una huella SHA-256 del documento original detecta cambios incluso sin aumentar `version`; la huella canónica de cada tarea vincula sus revisiones a su contenido. Cambios de formato invalidan vistas previas del documento pero no fabrican una nueva revisión humana de una tarea idéntica.

## Aceptación humana

`done` escrito externamente se presenta como **en revisión** hasta su aceptación explícita en Konsora. Solo una revisión con huella de tarea y firma HMAC-SHA256 válida para esta instalación y carpeta satisface una dependencia. La firma se guarda en `reviews`; la clave aleatoria propia de Konsora se mantiene junto a la base de la aplicación, fuera de la carpeta del proyecto, con permisos privados. No es una credencial del proveedor. Si el almacenamiento de la aplicación está dentro del proyecto se rechaza la firma: debe configurarse fuera de él antes de aceptar resultados.

Copiar la carpeta conserva tareas, resultados e historial de revisiones, pero requiere volver a confirmar las aceptaciones en la instalación/carpeta de destino. Modificar una tarea invalida la revisión de su contenido anterior. Los archivos no contienen autorizaciones de ejecución; preparar/copiar un prompt tampoco las crea. Las firmas no protegen frente a procesos del mismo usuario con acceso sin restricciones a la clave; el aislamiento del ejecutor se implementa en K-019.

Límites: 8 MiB por documento, 2000 tareas, 200 dependencias por tarea, 20000 intentos, 50000 eventos y 10000 revisiones. Las rutas no son parte de los IDs ni permiten referenciar archivos externos. Los secretos de proveedor y la clave de revisión nunca se exportan al proyecto.
