# Nyvo · decisiones de arquitectura, lo probado y lo pendiente (fase 1)

## Alcance

- **Qué es Nyvo:** el segundo director de AINova System. Solo trabaja en «Mis negocios».
- **Dónde vive:**
  - Es un proyecto Vercel aparte, en un subdominio `*.vercel.app`.
  - Usa su propia base Neon.
  - Se conecta al panel de AINova (`ainova-system.vercel.app`) **solo por su conector MCP**.
- **Cuentas:** Google y Notion son los de la cuenta de la empresa.

## Decisiones

1. **AINova es la fuente de verdad** de clientes, proyectos, cobros y facturas.
   - Nyvo no duplica esas tablas ni toca la base de AINova.
   - Lo lee y lo cambia por `/mcp`.
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
7. **Seguridad:**
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

## Lo probado

En esta sesión, en local, con Postgres 16 real:

- `npm run lint`, `tsc` (servidor y web) y `vite build` en verde.
- **`npm test` (node --test): 46 pruebas.**
  - **Funciones puras:** cifrado, contraseñas, palabra clave (positivos, negativos y espera), conversión de esquemas MCP → Gemini, WAV y límite de TTS, id_token, Notion, Drive y configuración.
  - **Cola de trabajos:** reintentos, `SKIP LOCKED`, recuperación tras corte y `runTick`.
  - **Registro de conectores:** «falta configurar» con variables exactas, «falta conectar» y token incorrecto → error sin romper.
  - **Tarjetas:** confirmar una sola vez, cancelar, caducar, y la excepción de Notion con Deshacer y con `autoGuardar` apagado.
  - **Especialista:** solo ve la tarea, con su tope de llamadas y su plazo.
  - **Turno completo con Gemini** contra el servidor falso, trabajo en segundo plano y chat sin Gemini.
  - **API HTTP:** sesión, login, límite de intentos, CSRF, Google login y conexión de Drive con renovación de token, ajustes de conectores, memoria, voz (Gemini, ElevenLabs, límite, STT, tipos de audio), chat y tarjetas por HTTP, y tick con `CRON_SECRET`.
- **Playwright en Chromium real: 16 pruebas, 15 en escritorio (1440×900) y 1 en móvil (Pixel 7).**
  - **Sesión:** login (correcto e incorrecto) y salir.
  - **Paneles:** Clientes (KPIs y búsqueda) y Drive («falta conectar» → OAuth falso, solo con el permiso de Drive → archivos).
  - **Chat y tarjetas:**
    - chat delegando en Negocios;
    - tarjeta Cancelar/Confirmar contra el MCP;
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
| MCP real de AINova | La red bloquea `ainova-system.vercel.app` (ENOTFOUND) y Nyvo aún no tiene token propio. Se probó con un servidor MCP real del SDK (mismas herramientas y anotaciones que AINova) |
| Notion y Google reales | Sin credenciales. Se probó contra imitaciones de sus API |
| Despliegue en Vercel y Neon | No se crearon cuentas ni proyectos: requieren tu confirmación previa |
| Palabra clave con voz real | Chromium sin interfaz no reconoce voz. Se probó con un reconocedor simulado. Hay que probarla en Chrome con micrófono |
| Lectura en voz alta audible | Se verificó la respuesta `audio/wav`, no el sonido |

## Pendiente

- **Fase 1b (repositorio AINOVA-System):** aceptar `NYVO_TOKEN` además de `EDDIE_TOKEN` en `src/adapters/mcp/handler.ts`, registrar quién llamó en `audit_log`, añadir un botón «Abrir Nyvo» en el panel y actualizar `docs/MAP.md`. Requiere acceso de escritura a ese repositorio.
- **Fase 2:**
  - Facturas, cotizaciones y recibos en PDF usando la tabla `invoices` de AINova (nuevas herramientas MCP).
  - Cuentas por cobrar y recordatorios.
  - Textos profesionales con el estilo aprendido.
  - **Habilidades de GitHub:** tabla `skills`, fijadas a un SHA, validación, tarjeta previa, contenido no confiable.
- **Fase 3:** Docs, Sheets y Slides; presentaciones desde un brief; Calendar y seguimiento de ventas.
- **Fase 4:** navegador en un entorno aislado aparte, fuera de Vercel.
