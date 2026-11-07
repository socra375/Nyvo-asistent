-- 002 · Endurecimiento de la base de datos contra fugas.
-- Cuatro ideas: (1) la base impide mezclar datos de distintos usuarios, (2) la base rechaza guardar un secreto en claro,
-- (3) ningún campo libre puede convertirse en un volcado de datos, (4) cada tabla declara qué guarda y cuánto tiempo.
-- Idempotente: cada restricción se borra si existe y se vuelve a crear; los índices usan IF NOT EXISTS.

-- ───────────── 1. Aislamiento entre usuarios ─────────────
-- Antes, messages/jobs/pending_actions guardaban user_id y conversation_id por separado y nada obligaba a que coincidieran:
-- un error de código podía colgar un mensaje de A de la conversación de B. Con una clave foránea compuesta, la base lo rechaza.
alter table conversations drop constraint if exists conversations_id_user_key;
alter table conversations add constraint conversations_id_user_key unique (id, user_id);

alter table messages drop constraint if exists messages_conversation_id_fkey;
alter table messages drop constraint if exists messages_conversation_user_fkey;
alter table messages add constraint messages_conversation_user_fkey
  foreign key (conversation_id, user_id) references conversations (id, user_id) on delete cascade;

-- Al borrar la conversación solo se anula conversation_id; user_id (NOT NULL en pending_actions) se conserva.
alter table pending_actions drop constraint if exists pending_actions_conversation_id_fkey;
alter table pending_actions drop constraint if exists pending_actions_conversation_user_fkey;
alter table pending_actions add constraint pending_actions_conversation_user_fkey
  foreign key (conversation_id, user_id) references conversations (id, user_id) on delete set null (conversation_id);

alter table jobs drop constraint if exists jobs_conversation_id_fkey;
alter table jobs drop constraint if exists jobs_conversation_user_fkey;
alter table jobs add constraint jobs_conversation_user_fkey
  foreign key (conversation_id, user_id) references conversations (id, user_id) on delete set null (conversation_id);
-- jobs.user_id admite NULL (trabajos del sistema): con NULL, una clave compuesta no se comprueba. Se cierra ese hueco.
alter table jobs drop constraint if exists jobs_conversation_needs_user_chk;
alter table jobs add constraint jobs_conversation_needs_user_chk check (conversation_id is null or user_id is not null);

-- ───────────── 2. Un secreto en claro no entra ─────────────
alter table users drop constraint if exists users_email_chk;
alter table users add constraint users_email_chk check (email = lower(email) and email ~ '^[^@[:space:]]+@[^@[:space:]]+$');
alter table users drop constraint if exists users_password_hash_chk;
alter table users add constraint users_password_hash_chk check (password_hash is null or password_hash like 'scrypt$%');

alter table sessions drop constraint if exists sessions_token_hash_chk;
alter table sessions add constraint sessions_token_hash_chk check (token_hash ~ '^[0-9a-f]{64}$');   -- SHA-256 en hexadecimal, nunca el token

alter table oauth_accounts drop constraint if exists oauth_accounts_tokens_enc_chk;
alter table oauth_accounts add constraint oauth_accounts_tokens_enc_chk
  check ((access_token_enc is null or access_token_enc like 'v1.%') and (refresh_token_enc is null or refresh_token_enc like 'v1.%'));
alter table oauth_states drop constraint if exists oauth_states_verifier_enc_chk;
alter table oauth_states add constraint oauth_states_verifier_enc_chk check (verifier_enc like 'v1.%');
alter table oauth_states drop constraint if exists oauth_states_state_hash_chk;
alter table oauth_states add constraint oauth_states_state_hash_chk check (state_hash ~ '^[0-9a-f]{64}$');

-- ───────────── 3. Límites de tamaño: un campo libre no es un volcado de datos ─────────────
alter table messages drop constraint if exists messages_content_len_chk;
alter table messages add constraint messages_content_len_chk check (length(content) <= 20000 and cardinality(card_ids) <= 20);
alter table pending_actions drop constraint if exists pending_actions_size_chk;
alter table pending_actions add constraint pending_actions_size_chk
  check (octet_length(args::text) <= 65536 and (result is null or octet_length(result::text) <= 16384) and (undo is null or octet_length(undo::text) <= 16384));
alter table jobs drop constraint if exists jobs_size_chk;
alter table jobs add constraint jobs_size_chk check (octet_length(payload::text) <= 65536 and (result is null or octet_length(result::text) <= 16384));
alter table audit_log drop constraint if exists audit_log_size_chk;
alter table audit_log add constraint audit_log_size_chk check (octet_length(detail::text) <= 4096);
alter table connector_settings drop constraint if exists connector_settings_size_chk;
alter table connector_settings add constraint connector_settings_size_chk check (octet_length(settings::text) <= 4096);
alter table memory_notes drop constraint if exists memory_notes_tags_chk;
alter table memory_notes add constraint memory_notes_tags_chk check (cardinality(tags) <= 8);
alter table writing_style drop constraint if exists writing_style_size_chk;
alter table writing_style add constraint writing_style_size_chk check (length(description) <= 2000 and cardinality(samples) <= 5);
alter table rate_limits drop constraint if exists rate_limits_key_len_chk;
alter table rate_limits add constraint rate_limits_key_len_chk check (length(key) <= 200);

-- ───────────── 4. Índices que faltaban (claves foráneas y purga por fecha) ─────────────
create index if not exists messages_user_idx on messages (user_id);
create index if not exists jobs_conversation_idx on jobs (conversation_id) where conversation_id is not null;
create index if not exists pending_actions_conversation_idx on pending_actions (conversation_id) where conversation_id is not null;
create index if not exists audit_log_user_idx on audit_log (user_id, created_at desc);
create index if not exists audit_log_created_idx on audit_log (created_at);
create index if not exists oauth_states_user_idx on oauth_states (user_id) where user_id is not null;
create index if not exists oauth_states_expires_idx on oauth_states (expires_at);
create index if not exists sessions_expires_idx on sessions (expires_at);
create index if not exists rate_limits_window_idx on rate_limits (window_start);
create index if not exists pending_actions_closed_idx on pending_actions (created_at) where status <> 'pending';
create index if not exists jobs_closed_idx on jobs (updated_at) where status in ('done', 'failed', 'cancelled');

-- ───────────── 5. Permisos: nada para PUBLIC, ni ahora ni en tablas futuras ─────────────
revoke all on all tables in schema public from public;
revoke all on all sequences in schema public from public;
alter default privileges in schema public revoke all on tables from public;
alter default privileges in schema public revoke all on sequences from public;

-- ───────────── 6. Mapa de datos dentro de la propia base (consúltalo con \d+ o obj_description) ─────────────
comment on table users is 'Sensibilidad: media (correo). Contraseña solo como hash scrypt. Retención: hasta que el dueño la borre.';
comment on table sessions is 'Sensibilidad: alta. Solo el SHA-256 del token. Retención: se purga al caducar.';
comment on table oauth_accounts is 'Sensibilidad: crítica. Tokens de Google cifrados con AES-256-GCM (prefijo v1.). Retención: hasta desconectar.';
comment on table oauth_states is 'Sensibilidad: alta. Verificador PKCE cifrado, un solo uso. Retención: se purga al caducar (10 min).';
comment on table connector_settings is 'Sensibilidad: baja. Solo ajustes, nunca claves. Retención: hasta que el dueño la borre.';
comment on table conversations is 'Sensibilidad: media. Retención: hasta que el dueño la borre (borra también sus mensajes).';
comment on table messages is 'Sensibilidad: alta (puede citar datos de clientes). Retención: hasta que el dueño borre la conversación.';
comment on table pending_actions is 'Sensibilidad: alta (args puede contener datos de clientes). Detalle (args/result/undo) se vacía a los 30 días y la fila se borra a los 180.';
comment on table jobs is 'Sensibilidad: media. Payload/result se vacían a los 14 días y la fila se borra a los 90 (el texto va en messages, no aquí).';
comment on table memory_notes is 'Sensibilidad: media. Retención: hasta que el dueño las borre o las exporte.';
comment on table writing_style is 'Sensibilidad: baja. Retención: hasta que el dueño la borre.';
comment on table audit_log is 'Sensibilidad: media (IP). Sin textos largos ni secretos. La IP se borra a los 90 días y la fila a los 365.';
comment on table rate_limits is 'Sensibilidad: baja (claves con IP). Retención: 1 día.';
