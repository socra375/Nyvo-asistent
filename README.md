# Nyvo · segundo director de AINova System

Asistente de IA que se ocupa **solo de «Mis negocios»** de AINova System: clientes, cobros, documentos, reportes y archivos.
La pantalla principal es **solo el orbe** (un grafo de red en 3D con cuatro clústeres: Rose, Johan, Mia y Nyvo) con conversación por voz que se puede interrumpir ([`docs/VOZ.md`](docs/VOZ.md)); el **Panel** (centro de mando) tiene los paneles de **Clientes** (AINova), **Archivos principales** (Google Drive), **Notion**, **Trabajos** y el **chat con tarjetas**.

- Toda acción que cambia datos externos (responder a un cliente, marcar un cobro…) pide **confirmación en una tarjeta**.
  Única excepción aprobada: guardar notas y reportes en el espacio «Nyvo» de Notion se hace solo y deja una tarjeta **Deshacer** (se puede apagar en Conectores).
- **Ninguna clave llega al navegador**: todo pasa por `/api` (una sola función serverless en Vercel).
- Decisiones, lo probado y lo pendiente: [`docs/Nyvo.md`](docs/Nyvo.md). Protección de datos (qué se guarda, cuánto tiempo y qué impide la base): [`docs/DATABASE.md`](docs/DATABASE.md). Conectores y variables: [`docs/CONNECTORS.md`](docs/CONNECTORS.md).

## Stack

React + Vite (web) · Node 20+ en TypeScript · una función serverless de Vercel (`api/index.ts`, corte a 60 s) · Postgres en Neon · Gemini (texto, voz y transcripción) · API REST con clave para AINova · pruebas con `node --test` y Playwright (Chromium).

## Desarrollo local

Requisitos: Node 22 y un Postgres 16 local (o una rama de Neon).

```bash
npm install
```

```bash
cp .env.example .env
```

Rellena al menos `DATABASE_URL`, `NYVO_OWNER_EMAIL` y `NYVO_ENC_KEY`. Luego:

```bash
node --env-file=.env --import tsx server/db/migrate.ts
```

```bash
node --env-file=.env --import tsx server/cli/set-password.ts
```

```bash
node --env-file=.env --import tsx server/dev.ts
```

```bash
npm run dev:web
```

La API corre en `http://localhost:3001` y la web en `http://localhost:5173` (con proxy a `/api`).
Sin Gemini, Notion, Google o AINova configurados, cada panel muestra «falta configurar» con la variable exacta que falta.

### Pruebas

```bash
TEST_DATABASE_URL=postgres://usuario:clave@localhost:5432/nyvo_test npm test
```

```bash
npm run lint
```

```bash
npm run build
```

```bash
TEST_DATABASE_URL=postgres://usuario:clave@localhost:5432/nyvo_test npx playwright test --trace off
```

Las pruebas de Playwright levantan servidores **falsos** de la API de AINova, Notion, Google (OAuth y Drive) y Gemini (`tests/fakes/upstream.ts`): ejercitan el código real sin red ni claves.
El usuario de `TEST_DATABASE_URL` debe poder crear bases de datos (crea `nyvo_e2e` y `nyvo_e2e_bare`).

## Puesta en producción (cada paso lo confirma el dueño; nada se crea solo)

### 1. Repositorio
`socra375/nyvo-asistent`. La CI (`.github/workflows/ci.yml`) corre lint, pruebas, build, auditoría y Playwright en cada PR.

### 2. Neon (base de datos propia de Nyvo)
1. En Vercel → **Storage** → Neon (la integración ya está instalada en el equipo, plan gratuito) → **Create database** «nyvo» y conéctala al proyecto `nyvo-ainova`. Vercel inyecta `DATABASE_URL` en las variables.
   Si no usas la integración de Vercel: crea un proyecto **nuevo** en Neon y copia la cadena de conexión *pooled* en `DATABASE_URL`. No reutilices la base de AINova: Nyvo nunca la toca.
3. Las migraciones se aplican solas en cada despliegue **de producción** (`npm run vercel-build`). Las vistas previas de los PR **no migran**: comparten la base de producción, y una migración sin revisar la tocaría antes de fusionar. Para aplicarlas a mano: `npm run migrate`.

### 3. Vercel
**Ya creado:** proyecto `nyvo-ainova` en el equipo Architec WebS, con la URL `https://nyvo-ainova.vercel.app`, Node 22.x, y las variables `NYVO_OWNER_EMAIL`, `AINOVA_API_URL`, `APP_URL`, `NYVO_ENC_KEY` y `CRON_SECRET`. Faltan `AINOVA_API_KEY` y las demás de [`.env.example`](.env.example) a medida que haces los pasos siguientes.

Si lo montas desde cero:
1. Importa el repositorio como proyecto nuevo. Vercel detecta `vercel.json`: compila la web en `dist/` y despliega `api/index.ts` (60 s).
2. En **Settings → Deployment Protection** deja «Vercel Authentication» solo para *Preview*; si protege producción, bloquea el retorno de Google y el disparador de GitHub Actions.
3. En **Settings → Environment Variables** añade las variables de [`.env.example`](.env.example) y pon la URL final en `APP_URL`.
4. Define la contraseña del dueño (opcional si solo entras con Google), desde tu equipo con la `DATABASE_URL` de Neon:
   `DATABASE_URL=... NYVO_OWNER_EMAIL=... npm run owner:password`

### 4. Google Cloud (login y Drive)
1. Crea un proyecto en Google Cloud con la cuenta de la empresa y activa **Google Drive API**.
2. **Pantalla de consentimiento**: tipo *Externo*. Añade los permisos `openid`, `email`, `profile` y `drive.metadata.readonly`.
3. **Publica la app en producción** (sin verificar). En modo *Prueba* Google caduca los permisos a los 7 días y habría que reconectar cada semana. Al conectar, Google mostrará «app no verificada»: se acepta una vez.
4. **Credenciales → ID de cliente OAuth → Aplicación web**. URL de retorno autorizada: `https://<tu-subdominio>.vercel.app/api/oauth/google/callback`.
5. Copia `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` en Vercel. Solo los correos de `NYVO_OWNER_EMAIL` pueden entrar.
6. En Nyvo → Conectores (o en el panel de Drive) pulsa **Conectar con Google**: se pide solo el permiso de Drive (los permisos se piden por partes).

### 5. Notion (archivo de Nyvo)
1. Crea una integración **interna** en https://www.notion.so/my-integrations con la cuenta de la empresa y copia el token en `NOTION_TOKEN`.
2. Crea una página «Nyvo», compártela con la integración (… → Conexiones) y pon su enlace o id en `NOTION_ROOT_PAGE_ID`.
3. Nyvo crea dentro las subpáginas «Notas» y «Reportes».

### 6. AINova System (clientes, cobros y facturas)
Nyvo se conecta a la **API REST con clave** de AINova (`/api/v1`), no a su MCP: una sola llamada HTTP por herramienta, con una clave propia que tiene permiso, caducidad y revocación.
1. `AINOVA_API_URL=https://ainova-system.vercel.app` (ya está en Vercel).
2. En el panel de AINova → **Configuración → Claves de acceso por API**, crea una clave llamada «Nyvo» con permiso **Lectura y escritura** y una caducidad (p. ej. 90 días). El panel la prueba por ti y la muestra **una sola vez**.
3. En Vercel (proyecto `nyvo-ainova`) → Environment Variables, crea `AINOVA_API_KEY` con esa clave, tipo *Sensitive*, para Production, y redespliega. No la pegues en el chat ni en el repositorio.
4. En Nyvo → Conectores, AINova debe pasar a «Listo».

Con esa clave Nyvo puede leer clientes, proyectos, cobros, servicios y conversaciones; responder y escalar mensajes; crear y corregir clientes; crear proyectos y cobros pendientes; y preparar facturas, que quedan en **borrador** hasta que las apruebes en Mensajes. Nada borra datos ni cambia importes, y cada escritura pasa antes por una tarjeta de confirmación en Nyvo. AINova limita las llamadas (120 por minuto y 20 escrituras por minuto por clave): si rechaza, Nyvo avisa en vez de insistir.

Si AINova responde 401 con una página de Vercel en lugar de JSON, «Vercel Authentication» está bloqueando las llamadas de servidor: desactívala para producción en el proyecto de AINova. Esta prueba debe devolver 401 con «Clave inválida, caducada o revocada»:

```bash
curl -i https://ainova-system.vercel.app/api/v1/tools
```

### 7. Gemini y voz
1. Crea una clave en Google AI Studio → `GEMINI_API_KEY`.
2. Elige `GEMINI_MODEL`, `GEMINI_TTS_MODEL` y `GEMINI_TTS_VOICE` **según la documentación oficial vigente** (no se fijan por defecto: ver `docs/Nyvo.md`).
3. Alternativa de voz: `VOICE_PROVIDER=elevenlabs` + `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID`.

### 8. Trabajos en segundo plano
1. `CRON_SECRET` ya está en Vercel (Settings → Environment Variables → CRON_SECRET → mostrar). Copia **el mismo valor** a GitHub (Settings → Secrets and variables → Actions → New repository secret).
2. En GitHub → Settings → Variables → Actions crea `NYVO_URL` con la URL de Nyvo.
3. `.github/workflows/jobs-tick.yml` procesará la cola cada 10 minutos.

## Estructura

```
api/index.ts              única función serverless (enrutador /api/*)
server/                   http, auth (sesiones, Google OAuth+PKCE), db (migraciones), agents (principal + especialistas),
                          actions (tarjetas), jobs (cola), memory, voice (TTS/STT), crypto (AES-GCM, scrypt)
connectors/<id>/          ainova (API REST), notion, google-drive, memoria, gemini, voz + registry.ts
web/src/                  React: orb/ (orbe: grafo de red), voice/ (VAD, cola de voz, conversación), paneles, chat con tarjetas, conectores, memoria
brain/                    nyvo_core_system.md: el cerebro de Nyvo (se incrusta al compilar con npm run build:brain)
tests/unit, tests/e2e     node --test y Playwright; tests/fakes/upstream.ts imita los servicios externos
design/                   logo original (logo-source.png) y make-icons.py, que genera los iconos de web/public/
```

### Logo e iconos (PWA)
El logo original está en `design/logo-source.png` (387×397 px, opaco). `python3 design/make-icons.py` (requiere Pillow) genera en `web/public/` el favicon, los iconos 192/512 (normales y «maskable» para Android), el `apple-touch-icon` y los logos de la interfaz. `web/public/manifest.webmanifest` los declara para poder instalar Nyvo como aplicación. Para iconos más nítidos, sustituye el original por una versión de 1024 px o más y vuelve a ejecutar el script.
