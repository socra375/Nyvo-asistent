# Prompt para la sesión de AINova (fase 1b): token propio para Nyvo

> Copia desde la línea «Contexto» hasta el final y pégalo en una sesión nueva con acceso de escritura al repositorio `socra375/AINOVA-System`.

---

## Contexto

Estás en el repositorio `socra375/AINOVA-System` (la app está en la carpeta `ianova/`): el sitio y panel de AINova System, desplegado en Vercel como `ainova-system.vercel.app`. Es un monolito TypeScript sin framework (Node ≥ 20, handler `http` propio, Postgres en Neon con `pg`, pruebas con Vitest contra un Postgres real, comentarios y textos de interfaz en español). Antes de tocar nada lee `README.md`, `docs/ARCHITECTURE.md`, `docs/MAP.md`, `docs/SECURITY.md` y `docs/RUNBOOK.md`.

Existe un conector MCP en `/mcp` (Streamable HTTP, sin estado) que hoy usa un asistente externo llamado **Eddie** con el token `EDDIE_TOKEN` (≥ 32 caracteres):

- `ianova/api/mcp.ts` reexporta `ianova/src/adapters/mcp/handler.ts`.
- `handler.ts` compara el Bearer con `EDDIE_TOKEN` usando `passwordMatches(bearer, token, cfg.sessionSecret)`, limita solo los intentos **fallidos** por IP (`allowAttempt` con `EDDIE_FAIL_POLICY`), y crea `buildServer(getPool(cfg))`.
- `ianova/src/adapters/mcp/server.ts` registra las herramientas con un envoltorio `tool()` que audita cada llamada (`eddie.writeAudit(db, { tool, args: redact(args), ok })`) y marca la anotación MCP `readOnlyHint` según el conjunto `WRITE_TOOLS`.
- Herramientas actuales: `get_summary`, `search_clients`, `list_projects`, `list_payments`, `list_services`, `list_conversations`, `read_conversation`, `list_agents`, `get_agent` (lectura) y `add_interaction`, `mark_payment_paid`, `reply_to_client`, `add_agent_item`, `escalate_to_owner` (escritura, sin borrados).

Se está construyendo un segundo asistente, **Nyvo** (repositorio `socra375/nyvo-asistent`, proyecto Vercel aparte), que necesita leer y escribir en AINova **solo a través de este conector MCP**. Nyvo es un cliente MCP: lista las herramientas con `tools/list` y trata como escritura (pide confirmación al usuario en una tarjeta) cualquiera que no tenga `readOnlyHint: true`.

## Objetivo

Dar a Nyvo **su propio token**, separado del de Eddie, para poder revocar uno sin cortar al otro y saber en la auditoría quién hizo cada cosa.

## Qué hacer

1. **Dos tokens, dos identidades.**
   - Acepta `EDDIE_TOKEN` (cliente `eddie`) y `NYVO_TOKEN` (cliente `nyvo`), cada uno de al menos 32 caracteres.
   - Si ninguno está configurado, responde 503 como hoy. Si solo uno lo está, el otro cliente recibe 401.
   - Si ambos valores son iguales, rechaza con 503 y un mensaje claro: sería imposible distinguir quién llama.
   - Compara en tiempo constante y sin cortocircuitos que filtren cuál coincidió (reutiliza `passwordMatches`).
   - Mantén el límite de intentos fallidos por IP, compartido entre ambos.
2. **Auditoría con identidad.**
   - Pasa el cliente identificado a `buildServer(db, client)` y regístralo en cada escritura de `audit_log`.
   - Mira cómo está definido `audit_log` y `eddie.writeAudit`. Si no hay un campo adecuado, añade una **migración nueva** con el siguiente número tras `018` (nunca edites una migración ya aplicada) que agregue `actor text not null default 'eddie'`, de modo que las filas antiguas queden como `eddie`.
   - Nunca registres tokens ni textos largos, como ya hace `redact`.
3. **Defensa en profundidad.** Para el cliente `nyvo` no registres `add_agent_item` (es de agentes de AINova; Nyvo ya la oculta en su lado, pero el servidor no debe confiar en eso). Eddie sigue igual.
4. **No cambies el contrato que Nyvo usa.** Mantén los nombres de herramientas, sus parámetros, la anotación `readOnlyHint` (verdadera en las de lectura y ausente o falsa en las de escritura) y que los resultados sigan siendo un único bloque de texto JSON.
5. **Enlace «Abrir Nyvo» (opcional, pequeño).**
   - Añade en el panel un enlace a la URL de Nyvo, leída de una variable `NYVO_URL` (si no existe, no se muestra).
   - Es un simple enlace `<a target="_blank" rel="noopener noreferrer">`: **no** debe cambiar la CSP ni `vercel.json`.
   - Si implica tocar la CSP o mucha interfaz, déjalo fuera y avísalo.
6. **Documentación.** Actualiza `docs/MAP.md`, `docs/SECURITY.md`, el README (variables) y cualquier `.env.example`: `NYVO_TOKEN`, cómo rotarlo y qué diferencia hay con `EDDIE_TOKEN`.
7. **Pruebas** (Vitest, con el Postgres de pruebas), mínimo:
   - cada token entra como su cliente;
   - un token incorrecto da 401 y cuenta para el límite;
   - un token correcto nunca se bloquea;
   - `audit_log` guarda `eddie` o `nyvo` según quién llamó;
   - `add_agent_item` no aparece en `tools/list` para `nyvo` y sí para `eddie`;
   - tokens iguales dan 503;
   - la migración conserva las filas antiguas como `eddie`.

## Reglas

- Español en comentarios y mensajes, como el resto del repositorio. Sigue las capas existentes (`adapters → services → repo → db`, con `domain` puro) y SQL siempre parametrizado. El test `tests/architecture.test.ts` debe seguir en verde.
- No cambies la autenticación de las rutas `/api/*` del administrador (cookie de sesión) ni el comportamiento actual de Eddie.
- Ningún token en el código, en commits, en registros ni en el navegador. **No pegues el valor de ningún token en el chat.**
- Antes de abrir el PR deben pasar `npm run check`, `npm run check:web` (si tocaste la web) y `npm test`. Un solo PR, en borrador, con descripción de qué cambia y cómo se probó.
- Si algo del código real contradice este documento (nombres de archivos, columnas, funciones), manda el código: adáptate y dilo en el PR.

## Después de fusionar (lo hace el dueño, no tú)

1. Generar un valor aleatorio largo para `NYVO_TOKEN` (por ejemplo `openssl rand -base64 48`) y guardarlo en las variables de Vercel del proyecto **ainova-system**, y redesplegar.
2. Guardar **ese mismo valor** como `AINOVA_MCP_TOKEN` en las variables de Vercel del proyecto **nyvo-ainova**.
3. En Nyvo, el panel «Clientes» y el conector AINova deben pasar a «Listo».

## Fuera de alcance (conversarlo antes, no hacerlo ahora)

Herramientas MCP nuevas para facturas, cotizaciones y recibos (fase 2 de Nyvo): hoy la tabla `invoices` existe pero el conector no la expone.
