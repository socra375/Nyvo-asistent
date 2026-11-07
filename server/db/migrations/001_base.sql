-- Fase 1: base de Nyvo. Todas las tablas de datos llevan user_id.

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text,
  password_hash text,
  created_at timestamptz not null default now()
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index sessions_user_idx on sessions(user_id);

-- Tokens OAuth cifrados con AES-256-GCM (NYVO_ENC_KEY). Permisos concedidos por partes.
create table oauth_accounts (
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,
  account_email text,
  scopes text[] not null default '{}',
  access_token_enc text,
  refresh_token_enc text,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

create table oauth_states (
  state_hash text primary key,
  user_id uuid references users(id) on delete cascade,
  purpose text not null,
  connector_id text,
  verifier_enc text not null,
  expires_at timestamptz not null
);

create table connector_settings (
  user_id uuid not null references users(id) on delete cascade,
  connector_id text not null,
  enabled boolean not null default true,
  settings jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (user_id, connector_id)
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  title text not null default 'Conversación',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index conversations_user_idx on conversations(user_id, updated_at desc);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  card_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
create index messages_conv_idx on messages(conversation_id, created_at);

-- Tarjetas: acciones que cambian datos externos (confirmar) o que se hicieron solas y se pueden deshacer.
create table pending_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  kind text not null check (kind in ('confirm', 'undo')),
  connector_id text not null,
  tool text not null,
  args jsonb not null default '{}',
  summary text not null,
  status text not null check (status in ('pending', 'running', 'done', 'cancelled', 'expired', 'failed', 'undone')),
  result jsonb,
  error text,
  undo jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index pending_actions_user_idx on pending_actions(user_id, created_at desc);

-- Trabajos en segundo plano: nada se pierde si Vercel corta la petición a los 60 s.
create table jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  kind text not null,
  title text not null default '',
  payload jsonb not null default '{}',
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  attempts int not null default 0,
  max_attempts int not null default 3,
  run_after timestamptz not null default now(),
  locked_until timestamptz,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_ready_idx on jobs(status, run_after);
create index jobs_user_idx on jobs(user_id, created_at desc);

create table memory_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  content text not null check (length(content) between 1 and 2000),
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index memory_notes_user_idx on memory_notes(user_id, created_at desc);

create table writing_style (
  user_id uuid primary key references users(id) on delete cascade,
  description text not null default '',
  samples text[] not null default '{}',
  updated_at timestamptz not null default now()
);

create table audit_log (
  id bigserial primary key,
  user_id uuid references users(id) on delete set null,
  action text not null,
  detail jsonb not null default '{}',
  ok boolean not null default true,
  created_at timestamptz not null default now()
);

create table rate_limits (
  key text primary key,
  count int not null,
  window_start timestamptz not null
);
