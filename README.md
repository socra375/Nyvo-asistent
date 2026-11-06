# Nyvo · segundo director de AINova System

Asistente de IA que se ocupa **solo de «Mis negocios»** de AINova System: clientes, cobros, documentos, reportes y archivos.
Interfaz tipo HUD (centro de mando) con el núcleo de voz de Nyvo y paneles de **Clientes** (AINova), **Archivos principales** (Google Drive), **Notion**, **Trabajos** y el **chat con tarjetas**.

- Toda acción que cambia datos externos (responder a un cliente, marcar un cobro…) pide **confirmación en una tarjeta**.
  Única excepción aprobada: guardar notas y reportes en el espacio «Nyvo» de Notion se hace solo y deja una tarjeta **Deshacer** (se puede apagar en Conectores).
- **Ninguna clave llega al navegador**: todo pasa por `/api` (una sola función serverless en Vercel).
- Decisiones, lo probado y lo pendiente: [`docs/Nyvo.md`](docs/Nyvo.md). Conectores y variables: [`docs/CONNECTORS.md`](docs/CONNECTORS.md).

## Stack

React + Vite (web) · Node 20+ en TypeScript · una función serverless de Vercel (`api/index.ts`, corte a 60 s) · Postgres en Neon · Gemini (texto, voz y transcripción) · cliente MCP para AINova · pruebas con `node --test` y Playwright (Chromium).

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

Las pruebas de Playwright levantan servidores **falsos** de AINova MCP, Notion, Google (OAuth y Drive) y Gemini (`tests/fakes/upstream.ts`): ejercitan el código real sin red ni claves.
El usuario de `TEST_DATABASE_URL` debe poder crear bases de datos (crea `nyvo_e2e` y `nyvo_e2e_bare`).

## Puesta en producción (cada paso lo confirma el dueño; nada se crea solo)

### 1. Repositorio
`socra375/nyvo-asistent`. La CI (`.github/workflows/ci.yml`) corre lint, pruebas, build, auditoría y Playwright en cada PR.

### 2. Neon (base de datos propia de Nyvo)
1. Crea un proyecto **nuevo** «nyvo» en Neon (no reutilices el de AINova: Nyvo nunca toca la base de AINova).
2. Copia la cadena de conexión *pooled* en `DATABASE_URL`.
3. Las migraciones se aplican solas en cada despliegue (`npm run vercel-build`). Para aplicarlas a mano: `npm run migrate`.

### 3. Vercel
1. Importa el repositorio como proyecto nuevo («nyvo»). Vercel detecta `vercel.json`: compila la web en `dist/` y despliega `api/index.ts` (60 s).
2. En **Settings → Environment Variables** añade las variables de [`.env.example`](.env.example).
3. Tras el primer despliegue, pon la URL final en `APP_URL` (p. ej. `https://nyvo-ainova.vercel.app`) y redespliega.
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

### 6. AINova System (clientes y cobros)
1. `AINOVA_MCP_URL=https://ainova-system.vercel.app/mcp`.
2. `AINOVA_MCP_TOKEN`: hoy AINova solo acepta `EDDIE_TOKEN`. El plan es darle a Nyvo **su propio** `NYVO_TOKEN` (revocable por separado y visible en la auditoría): es la **fase 1b** en el repositorio AINOVA-System (ver `docs/Nyvo.md`). Hasta entonces el conector queda en «error» o «falta configurar»; no reutilices el token de Eddie salvo decisión explícita.

### 7. Gemini y voz
1. Crea una clave en Google AI Studio → `GEMINI_API_KEY`.
2. Elige `GEMINI_MODEL`, `GEMINI_TTS_MODEL` y `GEMINI_TTS_VOICE` **según la documentación oficial vigente** (no se fijan por defecto: ver `docs/Nyvo.md`).
3. Alternativa de voz: `VOICE_PROVIDER=elevenlabs` + `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID`.

### 8. Trabajos en segundo plano
1. Genera `CRON_SECRET` y ponlo en Vercel **y** en GitHub (Settings → Secrets → Actions).
2. En GitHub → Settings → Variables → Actions crea `NYVO_URL` con la URL de Nyvo.
3. `.github/workflows/jobs-tick.yml` procesará la cola cada 10 minutos.

## Estructura

```
api/index.ts              única función serverless (enrutador /api/*)
server/                   http, auth (sesiones, Google OAuth+PKCE), db (migraciones), agents (principal + especialistas),
                          actions (tarjetas), jobs (cola), memory, voice (TTS/STT), crypto (AES-GCM, scrypt)
connectors/<id>/          ainova (MCP), notion, google-drive, memoria, gemini, voz + registry.ts
web/src/                  HUD en React (núcleo, paneles, chat con tarjetas, conectores, memoria, voz)
tests/unit, tests/e2e     node --test y Playwright; tests/fakes/upstream.ts imita los servicios externos
```
