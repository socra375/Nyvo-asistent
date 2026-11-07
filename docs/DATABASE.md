# Base de datos de Nyvo: protección contra fugas

Base: Postgres en Neon (proyecto `Nyvo-BD`). Esquema en `server/db/migrations/`. Este documento dice **qué se guarda, por qué, cuánto tiempo, qué impide la propia base y qué queda pendiente**.

## Principios
1. **Lo que no se guarda no se puede filtrar.** Nyvo no copia clientes, cobros ni facturas: AINova es la fuente de verdad y Nyvo la consulta por su API. En la base de Nyvo solo quedan identificadores y el estado de lo que hizo.
2. **Lo que se guarda, el menor tiempo posible.** Cada tabla declara su retención y una purga automática la aplica.
3. **La base no confía en el código.** Los errores de programación más peligrosos (mezclar datos de dos usuarios, guardar un secreto en claro, volcar datos en un campo libre) los rechaza la propia base.
4. **Los secretos nunca están en claro.** Contraseñas con hash scrypt, tokens de sesión solo como SHA-256, tokens de Google con AES-256-GCM.

## Auditoría del 7 de noviembre de 2026 (base real, solo lectura)

| Hallazgo | Riesgo | Estado |
|---|---|---|
| **Neon Auth activo con registro abierto** por correo y contraseña, sin verificar el correo, con organizaciones activas y un endpoint público, dentro de **esta misma base**. Nyvo no lo usa | Cualquiera con la URL podía crear usuarios y organizaciones en la base de Nyvo (datos ajenos y consumo de espacio) | **Cerrado el registro** (`disable_sign_up`). Falta decidir si se desactiva del todo (ver «Pendiente») |
| La aplicación se conecta como `neondb_owner`: dueño de las tablas, con `BYPASSRLS` y `CREATEROLE` | Un fallo de inyección SQL daría control total; además la seguridad por filas no se aplicaría a ese rol | **Pendiente** (fase B, abajo) |
| Nada obligaba a que `user_id` y `conversation_id` coincidieran en `messages`, `jobs` y `pending_actions` | Un error de código podía colgar datos de un usuario de la conversación de otro | **Resuelto** (002: claves foráneas compuestas) |
| Nada impedía guardar una contraseña, un token de sesión o de Google en claro | Un descuido filtraría un secreto usable | **Resuelto** (002: CHECK de forma) |
| Campos libres sin límite (`jsonb`, texto) | Podían acumular copias de datos de clientes | **Resuelto** (002: límites de tamaño) y se guarda menos (ver abajo) |
| Sin retención: sesiones, estados OAuth, límites de uso, tarjetas, trabajos y auditoría crecían sin fin | Cuanto más tiempo vive un dato, más se puede filtrar | **Resuelto** (purga automática) |
| 5 claves foráneas sin índice | Borrados lentos y bloqueos | **Resuelto** (002) |
| `PUBLIC` sin permisos sobre las tablas | — | Ya estaba bien; 002 lo **garantiza** también para tablas futuras |
| Data API de Neon | Habría expuesto las tablas por HTTP | **No está activada** (no existen sus roles `anonymous`, `authenticated` ni `authenticator`) |

Estado de los datos en esa fecha: todas las tablas vacías (también las de Neon Auth), así que no había nada que migrar ni que corregir.

## Mapa de datos

| Tabla | Qué guarda | Sensibilidad | Retención |
|---|---|---|---|
| `users` | Correo y hash de contraseña | Media | Hasta que el dueño la borre |
| `sessions` | SHA-256 del token de sesión | Alta | Se borra al caducar |
| `oauth_accounts` | Tokens de Google, cifrados (prefijo `v1.`) | Crítica | Hasta desconectar |
| `oauth_states` | Estado y verificador PKCE (cifrado), un solo uso | Alta | Se borra al caducar (10 min) |
| `connector_settings` | Ajustes de conectores, nunca claves | Baja | Hasta que el dueño la borre |
| `conversations`, `messages` | Chat; puede citar datos de clientes | Alta | Hasta que el dueño borre la conversación |
| `pending_actions` | Tarjetas: `args` puede contener datos de clientes | Alta | Detalle vaciado a los 30 días; fila borrada a los 180 |
| `jobs` | Trabajos en segundo plano (el texto va en `messages`, no aquí) | Media | Detalle vaciado a los 14 días; fila borrada a los 90 |
| `memory_notes`, `writing_style` | Preferencias y estilo del dueño | Media / baja | Hasta que el dueño las borre o exporte |
| `audit_log` | Quién hizo qué; sin textos largos ni secretos | Media (IP) | IP borrada a los 90 días; fila a los 365 |
| `rate_limits` | Contadores por IP o usuario | Baja | 1 día |

Este mapa también está dentro de la base, en el comentario de cada tabla (`obj_description`), y una prueba falla si aparece una tabla sin comentario.

## Quién protege qué

| Defensa | La base | La aplicación |
|---|---|---|
| Aislamiento entre usuarios | Claves foráneas compuestas `(conversation_id, user_id)`; un trabajo sin usuario no puede tener conversación | Toda consulta filtra por `user_id` (probado por la API con dos usuarios) |
| Secretos | CHECK: hash `scrypt$…`, token de sesión = 64 hex, tokens cifrados con prefijo `v1.` | Cifrado AES-256-GCM, hash scrypt, SHA-256 |
| Tamaños | CHECK en `args`, `result`, `payload`, `detail`, mensajes, notas y estilo | Recorta antes de guardar y guarda solo identificadores del resultado de una herramienta |
| Retención | Índices para purgar rápido | `purgeIfDue` (una vez por hora, dentro del procesador de trabajos) |
| Permisos | `PUBLIC` sin acceso, también en tablas futuras | Consultas parametrizadas |

## Qué se guarda de las acciones y de los trabajos
- De lo que devuelve una herramienta se guardan solo `id`, `pageId`, `url`, `number`, `status`, `estado`, `seccion` y el tamaño en caracteres. Nunca el contenido (`slimResult`).
- La respuesta de un trabajo en segundo plano queda en el mensaje de la conversación; en `jobs.result` solo van el tamaño y las tarjetas.
- Los textos de error se recortan a 300 caracteres.

## Pendiente, y por qué no está hecho

**1. Rol de mínimo privilegio + seguridad por filas (RLS) — fase B.**
Comprobado: `neondb_owner` tiene `BYPASSRLS`, así que activar RLS con la conexión actual no protegería nada. Hace falta un rol de ejecución distinto (`nyvo_app`: solo `SELECT/INSERT/UPDATE/DELETE` en las tablas de Nyvo, sin DDL, sin `BYPASSRLS`) con su propia contraseña en Vercel (`DATABASE_URL_APP`); las migraciones seguirían usando el dueño en el build. Después, políticas `user_id = current_setting('app.user_id')::uuid` y un ayudante que fije ese valor en cada transacción (cambia todas las consultas). No se hace ahora porque:
- hoy hay un solo usuario y las defensas de arriba ya impiden el cruce;
- exige crear un rol y manejar una contraseña nueva, que conviene hacer a propósito y no de pasada.
Es el siguiente paso recomendado antes de que haya un segundo usuario.

**2. Neon Auth.** Está provisionado y no se usa. Con el registro cerrado el riesgo baja mucho, pero sigue siendo superficie innecesaria (y trae el esquema `neon_auth` y las variables `NEON_AUTH_*`, `VITE_NEON_AUTH_URL`). Desactivarlo es la opción más limpia; no lo hice porque es borrar una integración y lo decides tú.

**3. `audit_log` no es a prueba de manipulación.** La aplicación puede modificarlo (lo necesita para la purga). Que sea inmutable requiere el rol separado del punto 1.

**4. Los mensajes están en texto claro** en la base (cifrados en reposo por Neon, no por la aplicación). Cifrarlos desde la aplicación impediría buscarlos y complica la exportación; no se hace salvo que el dueño lo pida.

**5. Copia de seguridad.** El historial de recuperación del proyecto es de 6 horas (plan gratuito): un dato borrado por privacidad puede seguir en el historial ese tiempo.

## Reglas para tablas nuevas (las comprueban las pruebas)
1. Lleva `user_id not null` con clave foránea a `users`. Excepciones justificadas: `schema_migrations`, `rate_limits`, `users`.
2. Si cuelga de otra tabla de datos de un usuario, usa **clave foránea compuesta** `(padre_id, user_id)`.
3. Los secretos se guardan cifrados o con hash, con un CHECK que rechace el texto en claro.
4. Todo `jsonb` o texto libre lleva un límite de tamaño.
5. Declara su retención y la aplica la purga de `server/retention.ts`.
6. Lleva `comment on table` con sensibilidad y retención.
7. Toda clave foránea lleva índice.
8. **No copies datos personales de clientes de AINova:** guarda su identificador y consúltalos por la API.

## Diseño previsto para las fases 2 y 3
Sale del documento de arquitectura de los cuatro subagentes (Rose, Johan, Mia y Nyvo). Aquí solo lo que afecta a la base:

- **Johan (CRM):** es el especialista «Negocios», que ya consulta AINova. **No lleva base propia** de clientes; hacerla duplicaría datos personales (nombre, teléfono, correo, repositorios, pagos) en un segundo sitio.
- **Rose (mensajes entrantes):** AINova ya tiene su chat con un agente propio que responde. Si Nyvo recibe eventos, la tabla sería `inbox_events` con clave única `(user_id, source, external_id)` para no procesar dos veces, **sin guardar el mensaje** (solo una referencia) y con retención de 30 días.
- **Mia (formularios y agenda):** el perfil del formulario va a AINova; en Nyvo solo el id del evento de calendario y su estado.
- **Habilidades (`skills`):** tabla por usuario con repositorio, ruta, **commit fijado**, nombre, descripción, contenido (dato no confiable, con límite de tamaño), hash del contenido, estado (`pendiente`, `activa`, `desactivada`) y fecha de aprobación; clave única `(user_id, repo, ruta, commit)`.
- **Documentación `/Clientes/{Nombre}/…` en Drive o Notion:** copia datos personales fuera de la base. Usar el identificador de AINova en la ruta y mínimos datos, y pasar por tarjeta de confirmación (no cabe en la excepción de notas y reportes).

Dos puntos de ese documento chocan con reglas ya acordadas y hay que decidirlos antes de construirlos:
1. **«Rose responde automáticamente»** frente a «todo cambio externo pide confirmación».
2. **«Nyvo asimila la habilidad en su propio prompt base»** frente a «una habilidad nunca amplía permisos; su contenido es dato no confiable; se instala con tarjeta y commit fijado».
