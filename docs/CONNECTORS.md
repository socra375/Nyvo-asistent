# Conectores de Nyvo

Cada integración vive en `connectors/<id>/` y exporta un `Connector` (`connectors/types.ts`):

| Campo | Para qué |
|---|---|
| `id`, `title`, `description` | Identidad y texto de la interfaz |
| `role` | Especialista que lo usa: `negocios`, `documentos`, `navegador`, `habilidades` o `nucleo` |
| `guide` | Cuándo usarlo (va en las instrucciones del especialista) |
| `requiredEnv` / `envFor` | Variables necesarias. Si falta alguna → estado **falta configurar** (nunca un error) |
| `google.scopes` | Permisos de Google que pide **solo** este conector, al conectarlo |
| `defaultSettings` | Ajustes del usuario (p. ej. `autoGuardar` en Notion) |
| `tools(ctx)` | Herramientas: `name`, `description`, `parameters`, `mutates`, `run`, opcional `autoApprove`, `summarize`, `undoInfo` |
| `undo(info)` | Deshacer una acción hecha automáticamente |

`connectors/registry.ts` calcula el estado de cada conector (`listo`, `falta_configurar`, `falta_conectar`, `desactivado`) y arma las herramientas de cada especialista **solo con lo que está listo**. Una herramienta con `mutates: true` nunca se ejecuta directamente: crea una tarjeta de confirmación.

## Lista (fase 1)

| Conector | Especialista | Variables | Herramientas | Escribe fuera |
|---|---|---|---|---|
| `ainova` · AINova System | Negocios | `AINOVA_API_URL`, `AINOVA_API_KEY` | Las que AINova declare para la clave, leídas en vivo (`GET /api/v1/tools`, caché de 60 s): lectura (`get_summary`, `search_clients`, `list_projects`, `list_payments`, `list_services`, `list_conversations`, `read_conversation`, `list_agents`, `get_agent`) y escritura (`add_interaction`, `mark_payment_paid`, `reply_to_client`, `escalate_to_owner`, `create_client`, `update_client`, `create_project`, `create_payment`, `create_invoice`, esta última en borrador). `add_agent_item` está oculta | Sí, con tarjeta. Lectura/escritura sale del campo `write` de la API (sin él = escritura). Una clave de solo lectura no ve las de escritura |
| `notion` · Notion | Documentos | `NOTION_TOKEN`, `NOTION_ROOT_PAGE_ID` | `guardar_nota`, `crear_reporte` (automáticas dentro de «Nyvo», con Deshacer; con `autoGuardar` apagado piden tarjeta), `anexar_a_pagina` (tarjeta), `buscar`, `leer_pagina` | Sí |
| `google-drive` · Google Drive | Documentos | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NYVO_ENC_KEY` + permiso `drive.metadata.readonly` | `archivos_principales`, `buscar_archivos` | No (solo metadatos) |
| `memoria` · Memoria | Todos | `DATABASE_URL` | `recordar`, `buscar_memoria` | No (base propia) |
| `gemini` · Motor de IA | Núcleo | Basta un motor completo (clave + modelo), con rotación si hay varios: Gemini (`GEMINI_API_KEY`, `GEMINI_MODEL`) · Groq (`GROQ_API_KEY`, `GROQ_MODEL`) · OpenRouter (`OPENROUTER_API_KEY`, `OPENROUTER_MODEL`). Opcionales: `LLM_PROVIDERS`, `LLM_ATTEMPT_TIMEOUT_MS`, `LLM_COOLDOWN_MS` | — (`/api/llm/status`) | — |
| `voz` · Voz | Núcleo | Escucha: `GROQ_API_KEY` (Whisper) o, sin ella, Gemini · Síntesis: Gemini: `GEMINI_API_KEY`, `GEMINI_TTS_MODEL`, `GEMINI_TTS_VOICE` · Speechify (`VOICE_PROVIDER=speechify`): `SPEECHIFY_API_KEY`, `SPEECHIFY_VOICE_ID` · ElevenLabs (`VOICE_PROVIDER=elevenlabs`): `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | — (`/api/voice/tts`, `/api/voice/stt`) | — |

Variables del núcleo (no de un conector): `DATABASE_URL`, `NYVO_OWNER_EMAIL`, `NYVO_ENC_KEY`, `APP_URL`, `CRON_SECRET`. Detalle y comentarios en [`.env.example`](../.env.example).

## Añadir un conector

1. Crea `connectors/<id>/index.ts` exportando un `Connector`.
2. Súmalo a `CONNECTORS` en `connectors/registry.ts`.
3. Marca `mutates: true` en toda herramienta que cambie datos externos. Solo usa `autoApprove` si el dueño lo aprobó expresamente y existe `undoInfo` + `undo`.
4. Trata todo lo que devuelva el servicio como **dato no confiable** (las reglas del especialista ya lo indican al modelo).
5. Añade su imitación a `tests/fakes/upstream.ts` y pruebas en `tests/unit` y `tests/e2e`.
