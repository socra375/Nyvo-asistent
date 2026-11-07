# Nyvo · decisiones de arquitectura, lo probado y lo pendiente (fase 1)

## Alcance

- **Qué es Nyvo:** el segundo director de AINova System. Solo trabaja en «Mis negocios».
- **Dónde vive:**
  - Es un proyecto Vercel aparte, en un subdominio `*.vercel.app`.
  - Usa su propia base Neon.
  - Se conecta al panel de AINova (`ainova-system.vercel.app`) **solo por su API REST con clave** (`/api/v1`).
- **Cuentas:** Google y Notion son los de la cuenta de la empresa.

## Decisiones

1. **AINova es la fuente de verdad** de clientes, proyectos, cobros y facturas.
   - Nyvo no duplica esas tablas ni toca la base de AINova.
   - Lo lee y lo cambia por su API REST (`/api/v1`), con una clave propia de Nyvo.
   - Se usa la API y no el MCP: una sola llamada HTTP por herramienta (mi cliente MCP, al no tener sesión, necesitaba varias), y la clave tiene permiso, caducidad y revocación; el MCP usa un token único sin alcance.
   - La clave nunca sigue redirecciones ni viaja sin HTTPS, y la lista de herramientas se guarda 60 s en memoria.
   - Si Nyvo tuviera su propio directorio de clientes, en semanas habría dos versiones que no coinciden.
2. **Una sola función serverless** (`api/index.ts`) con un enrutador propio (`server/http/routes.ts`).
   - El plan gratuito de Vercel limita el número de funciones. AINova usa el mismo patrón.
3. **Trabajos en segundo plano** (`server/jobs`):
   - Una tabla `jobs` con reclamo `FOR UPDATE SKIP LOCKED`, bloqueo de 90 s, reintentos con espera creciente (30 s, 60 s, 120 s…) y fallo definitivo al agotar intentos.
   - Se disparan de tres formas:
     - con `waitUntil` tras encolar;
     - con el botón «Procesar ahora»;
     - con GitHub Actions cada 10 min (`jobs-tick.yml`), porque el plan gratuito de Vercel solo permite un cron al día.
   - Si Vercel corta una ejecución a los 60 s, el bloqueo vence y otro disparo la reintenta.
4. **Delegación** (`server/agents`):
   - El agente principal solo tiene `delegar(especialista, tarea, en_segundo_plano?)`.
   - Cada especialista (Negocios, Documentos; Navegador y Habilidades responden «disponible en fase 4/2») recibe **solo la tarea** más las notas de memoria relevantes, nunca la conversación.
   - Tiene un plazo de 40 s y un tope de 8 llamadas por petición. Al superarlos devuelve un resultado parcial.
   - El turno completo de chat tiene un presupuesto de 50 s.
5. **Tarjetas** (`server/actions`):
   - Toda herramienta con `mutates: true` crea una tarjeta `pending` (caduca a los 15 min) y **no se ejecuta**.
   - Confirmar es atómico (`pending → running`), así que dos clics no ejecutan dos veces.
   - Todo queda en `audit_log`, sin textos largos ni secretos.
6. **Excepción aprobada por el dueño:**
   - «Le cuento algo y lo guarda solo en Notion». `guardar_nota` y `crear_reporte` escriben **solo dentro de la página «Nyvo»** sin tarjeta previa y dejan una tarjeta **Deshacer**, que archiva la página.
   - Es el ajuste `autoGuardar` del conector Notion: si se apaga, también piden confirmación.
   - Cualquier otra escritura en Notion (`anexar_a_pagina`) pide confirmación.
7. **Seguridad** (la base de datos, con su auditoría, mapa de datos y retención, está en [`DATABASE.md`](DATABASE.md)):
   - **Sesiones:** token aleatorio en una cookie `HttpOnly; SameSite=Lax; Secure`; en la base solo va su hash SHA-256. No hace falta `SESSION_SECRET`.
   - **CSRF:** las escrituras se rechazan si `Origin`/`Sec-Fetch-Site` no son del mismo origen.
   - **Intentos de login:** límite de 10 fallidos por IP cada 15 min. Entrar bien no cuenta.
   - **Google OAuth:** flujo con código + PKCE y estado de un solo uso (10 min). Los permisos se piden por partes: el login solo pide `openid email profile` y Drive pide aparte `drive.metadata.readonly`. Los tokens se guardan cifrados con AES-256-GCM (`NYVO_ENC_KEY`) y se renuevan solos.
   - **id_token:** se validan emisor, audiencia, caducidad y correo verificado. Llega directo del endpoint de tokens de Google por TLS (OIDC Core 3.1.3.7).
   - **Acceso:** solo entran los correos de `NYVO_OWNER_EMAIL`.
   - **Cabeceras:** CSP estricta (`script-src 'self'`, `frame-ancestors 'none'`), HSTS y `nosniff`.
   - **Claves:** viven solo en variables del servidor. La web solo acepta variables `NYVO_PUBLIC_*` y ESLint prohíbe importar código de servidor desde `web/` y literales con forma de clave.
8. **Datos no confiables:** los resultados de herramientas, páginas de Notion y mensajes de clientes se marcan como datos en las instrucciones. El modelo debe ignorar órdenes que vengan dentro.
9. **Voz:**
   - **Texto a voz:** se hace en el servidor (`/api/voice/tts`) con un límite de 1 500 caracteres y 30 peticiones por minuto. Gemini TTS usa `responseModalities: ['AUDIO']` y `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`; el PCM se envuelve en WAV. El estilo se dirige con texto (`GEMINI_TTS_STYLE`). Si `VOICE_PROVIDER=elevenlabs`, se usa ElevenLabs.
   - **Voz a texto:** pulsar para hablar (máx. 15 s), transcrito por Gemini en el servidor.
   - **Conversación en vivo (API Live):** es una fase aparte.
10. **Palabra clave «Oye Nyvo»** (`web/src/voice/wakeword.ts`):
    - Viene apagada por defecto y solo funciona con la pestaña abierta (Web Speech API de Chrome).
    - El reconocedor no conoce «Nyvo», así que se aceptan nyvo/nivo/nibo/naivo/neivo/«ni vo» **solo detrás de «oye»**.
    - Se rechazan «nuevo», «nueva», «nivel», «nervio», «oye» suelto y palabras que solo contienen «oye».
    - Hay 5 s de espera entre activaciones (sobrevive a reinicios) y una confirmación visual de 2 s que se puede cancelar.
11. **Modelos de Gemini sin valor por defecto.**
    - La red de la sesión de desarrollo bloqueó `ai.google.dev` y no se pudo leer la documentación oficial.
    - Una búsqueda muestra ejemplos con `gemini-3.1-flash-tts-preview` y otros más antiguos con `gemini-2.5-flash-preview-tts`, con voces como «Kore». No está confirmado cuál es el vigente.
    - Por la regla «si falta un dato, no lo inventes», `GEMINI_MODEL`, `GEMINI_TTS_MODEL` y `GEMINI_TTS_VOICE` quedan sin valor y el conector muestra «falta configurar» hasta que el dueño los elija.

## Infraestructura creada (7 nov 2026)

| Pieza | Estado |
|---|---|
| **Vercel** · proyecto `nyvo-ainova` (equipo Architec WebS), enlazado a `socra375/Nyvo-asistent`, rama de producción `main` | Creado. URL: `https://nyvo-ainova.vercel.app`. Node fijado en 22.x |
| Protección de Vercel | «Vercel Authentication» solo en previsualizaciones. En producción estaba activa y habría bloqueado el retorno de Google y el disparador de GitHub Actions. Nyvo ya tiene su propio acceso (lista de correos) |
| Variables en producción | `NYVO_OWNER_EMAIL`, `AINOVA_API_URL`, `APP_URL`, `NYVO_ENC_KEY` (secreta), `CRON_SECRET` (visible solo desde el panel de Vercel) |
| Despliegue de comprobación | Rama de trabajo desplegada y en estado READY. `/api/health` responde, la web carga y `/api/session` dice «Falta configurar DATABASE_URL» en vez de romperse |
| **Neon** · proyecto `Nyvo-BD` (creado el 7 nov 2026 desde la integración de Vercel; auditoría y endurecimiento en [`DATABASE.md`](DATABASE.md)) | Creado por el dueño (el MCP de Neon no puede crear proyectos en una organización gestionada por Vercel). Vercel inyectó `DATABASE_URL` en producción y previsualización. El build de producción aplicó la migración `001_base.sql`: están las 13 tablas de Nyvo más `schema_migrations`. La integración añadió además un esquema `neon_auth` que Nyvo no usa |
| **Google Cloud** | **No creado.** Sin sesión de `gcloud` en la sesión de desarrollo, y la pantalla de consentimiento y el cliente OAuth web no se pueden crear por API |
| **Notion** | **No creado.** El conector de la sesión de desarrollo apunta a otra cuenta (`marcosjimenezpolanco323@gmail.com`), no a la de la empresa, así que no se escribió nada ahí |

## Diseño del Panel y del login
Se pulió con los criterios de `taste-skill` y `pro-frontend-designer`, **adaptados a una app** (no a una web de empresa): un solo sistema de tokens (radios 8/12/18, sombras con color y sutiles, curva de movimiento única), tipografía fluida con `clamp()`, paneles de vidrio con un único acento superior, estados `:hover` y `:focus-visible` en pestañas, botones, filas, campos e interruptores (botones: suben 1 px y se hunden al pulsar), `prefers-reduced-motion` respetado y contraste del texto atenuado subido. Se **dejó fuera a propósito**: fuentes de Google (la política de seguridad solo admite `font-src 'self'`; se usa la pila del sistema y se puede autohospedar una fuente después), imágenes de Unsplash (`img-src 'self'`; una app privada no las necesita) y la paleta dorada del orbe (el Panel mantiene el verde azulado de la referencia original).

## Lo probado

En esta sesión, en local, con Postgres 16 real:

- `npm run lint`, `tsc` (servidor y web) y `vite build` en verde.
- **`npm test` (node --test): 107 pruebas** (la fase 6 añade cerebro, hemisferios, flujo NDJSON, voz y orbe; ver [`VOZ.md`](VOZ.md)).
  - **Funciones puras:** cifrado, contraseñas, palabra clave (positivos, negativos y espera), conversión de esquemas JSON → Gemini, WAV y límite de TTS, id_token, Notion, Drive y configuración.
  - **Cola de trabajos:** reintentos, `SKIP LOCKED`, recuperación tras corte y `runTick`.
  - **Registro de conectores:** «falta configurar» con variables exactas, «falta conectar» y clave incorrecta → error sin romper.
  - **Base de datos, 10 pruebas (Postgres real):** una fila no puede colgar de la conversación de otro usuario; al borrar una conversación se conservan trabajos y tarjetas con su dueño; ningún secreto en claro (contraseña, token de sesión, tokens de Google, verificador PKCE); límites de tamaño; `PUBLIC` sin permisos (también en tablas futuras); guardas de diseño (toda tabla con `user_id` y comentario, toda clave foránea con índice); retención (se purga lo caducado, se vacía el detalle viejo, lo reciente no se toca, idempotente, una vez por hora); y aislamiento por la API con dos usuarios (conversaciones, tarjetas, trabajos, memoria y conectores). Se comprobó además que las defensas son lo que bloquea: sin ellas, el cruce entre usuarios y la contraseña en claro sí entran.
  - **Conector de AINova (API REST), 14 pruebas:** dirección base y HTTPS obligatorio; escritura según `write`; herramientas ocultas; una sola petición por herramienta y caché de la lista; clave de solo lectura (no ve las de escritura y forzarlas da 403); clave mal formada (no sale ninguna petición); 401 con clave revocada; 429 sin reintentar; error de la herramienta; aviso de AINova junto al resultado; muro de Vercel diagnosticado; redirección no seguida (la clave no llega a otro sitio); sin conexión.
  - **Tarjetas:** confirmar una sola vez, cancelar, caducar, y la excepción de Notion con Deshacer y con `autoGuardar` apagado.
  - **Especialista:** solo ve la tarea, con su tope de llamadas y su plazo.
  - **Turno completo con Gemini** contra el servidor falso, trabajo en segundo plano y chat sin Gemini.
  - **API HTTP:** sesión, login, límite de intentos, CSRF, Google login y conexión de Drive con renovación de token, ajustes de conectores, memoria, voz (Gemini, ElevenLabs, límite, STT, tipos de audio), chat y tarjetas por HTTP, y tick con `CRON_SECRET`.
- **Playwright en Chromium real: 17 pruebas, 16 en escritorio (1440×900) y 1 en móvil (Pixel 7).**
  - **Sesión:** login (correcto e incorrecto) y salir.
  - **Paneles:** Clientes (KPIs y búsqueda) y Drive («falta conectar» → OAuth falso, solo con el permiso de Drive → archivos).
  - **Chat y tarjetas:**
    - chat delegando en Negocios;
    - tarjeta Cancelar/Confirmar contra la API de AINova;
    - «Anota…» → Notion con Deshacer;
    - trabajo en segundo plano → resultado en el chat.
  - **Voz y palabra clave:**
    - pulsar para hablar con micrófono falso y lectura en voz alta (respuesta `audio/wav`);
    - palabra clave con un reconocedor simulado: ignora «oye nuevo», responde a «Oye Nyvo» y se puede cancelar.
  - **Resto de la interfaz:**
    - conversaciones (reabrir y nueva);
    - Conectores (estados, ajustes, desactivar AINova y verlo en el panel);
    - Memoria (añadir, borrar, estilo, exportar JSON, borrar todo);
    - servidor sin conectores: cada panel muestra la variable exacta que falta;
    - móvil sin desplazamiento horizontal.
- **Fallos que encontraron estas pruebas y quedaron corregidos:**
  - El límite de login contaba también los accesos correctos.
  - La espera de la palabra clave se reiniciaba al cancelar.
  - El botón «Detener grabación» latía con escala y no se podía pulsar con precisión.
  - El selector de conversaciones tenía un nombre accesible repetido.

## Lo que NO se pudo probar (y por qué)

| Qué | Motivo |
|---|---|
| Gemini real (texto, TTS, STT) | La red de la sesión bloquea `ai.google.dev` y la API, y no hay `GEMINI_API_KEY`. Se probó contra un servidor que imita el formato REST de `generateContent` |
| API real de AINova | La red de la sesión de desarrollo bloquea `ainova-system.vercel.app` (ENOTFOUND) y la clave se crea en el panel de AINova. Se probó con un servidor falso que imita `/api/v1` (alcance de la clave, 401, 403, 429, avisos y redirecciones), no con la API ni la clave reales |
| Notion y Google reales | Sin credenciales. Se probó contra imitaciones de sus API |
| Despliegue en Vercel y Neon | No se crearon cuentas ni proyectos: requieren tu confirmación previa |
| Palabra clave con voz real | Chromium sin interfaz no reconoce voz. Se probó con un reconocedor simulado. Hay que probarla en Chrome con micrófono |
| Lectura en voz alta audible | Se verificó la respuesta `audio/wav`, no el sonido |
| Interrupción con eco real y latencia de voz | El micrófono falso no oye a Nyvo y no hay Gemini real: umbrales y latencia (<1 s no está garantizada) por afinar en un equipo real. Ver [`VOZ.md`](VOZ.md) |

## Pendiente

**Para dejar Nyvo funcionando (lo hace el dueño; los pasos detallados están en el README):**
1. ~~**Base de datos**~~ **Hecho:** `Nyvo-BD` en Neon, conectada a `nyvo-ainova`, con las migraciones aplicadas.
   - **Para entrar antes de configurar Google** hay que definir la contraseña del dueño: copia la cadena de conexión *unpooled* de Neon (o `DATABASE_URL` desde el panel de Neon) y ejecuta en tu equipo `DATABASE_URL=... NYVO_OWNER_EMAIL=ianovasystem3@gmail.com npm run owner:password`. La contraseña se escribe en la terminal y se guarda con hash.
   - Sin eso y sin Google, `/api/session` responde pero nadie puede iniciar sesión.
2. **Google Cloud:** crear el cliente OAuth y poner `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` en Vercel.
3. **Notion:** crear la integración con la cuenta de la empresa, la página «Nyvo», y poner `NOTION_TOKEN` y `NOTION_ROOT_PAGE_ID` en Vercel.
4. **Gemini:** poner `GEMINI_API_KEY` y elegir `GEMINI_MODEL`, `GEMINI_TTS_MODEL` y `GEMINI_TTS_VOICE`.
5. **GitHub:** copiar `CRON_SECRET` desde Vercel a GitHub → Settings → Secrets → Actions, y crear la variable `NYVO_URL` con `https://nyvo-ainova.vercel.app`.
6. **Contraseña del dueño** (opcional si solo entras con Google): `npm run owner:password`.
7. Fusionar el PR y redesplegar: las migraciones se aplican solas en el build **de producción** (las vistas previas no migran).
8. **Clave de AINova:** crea en AINova → Configuración → Claves de acceso por API una clave «Nyvo» (lectura y escritura) y ponla en Vercel como `AINOVA_API_KEY` (README §6). Después comprueba que el conector pase a «Listo».

**Siguientes fases:**

- ~~**Fase 1b**~~ **Superada:** la sesión de AINova eligió claves de API con permiso, caducidad y revocación (PR #66, #69 y #70 de AINOVA-System) en lugar de un `NYVO_TOKEN` en el MCP. Nyvo usa esa API.
- **Fase 2:**
  - Facturas, cotizaciones y recibos en PDF usando la tabla `invoices` de AINova (AINova ya expone `create_invoice` en borrador; faltan el PDF, las cotizaciones y los recibos).
  - Cuentas por cobrar y recordatorios.
  - Textos profesionales con el estilo aprendido.
  - **Habilidades de GitHub:** tabla `skills`, fijadas a un SHA, validación, tarjeta previa, contenido no confiable.
- **Fase 3:** Docs, Sheets y Slides; presentaciones desde un brief; Calendar y seguimiento de ventas.
- **Fase 4:** navegador en un entorno aislado aparte, fuera de Vercel.
