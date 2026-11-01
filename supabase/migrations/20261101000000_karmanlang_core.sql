-- See README. Applied to project nouuodihcgddrdyfkoca as migration "karmanlang_core".
create extension if not exists citext;
create table public.owners (user_id uuid primary key references auth.users(id) on delete cascade, email citext not null unique, created_at timestamptz not null default now());
create table public.deploy_tokens (id uuid primary key default gen_random_uuid(), owner_id uuid not null references public.owners(user_id) on delete cascade, name text not null, token_hash text not null unique, last_used_at timestamptz, revoked_at timestamptz, created_at timestamptz not null default now());
create table public.agents (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references public.owners(user_id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'), name text not null, description text, instructions text not null, greeting text,
  provider text not null default 'anthropic' check (provider in ('anthropic')), model text not null default 'claude-sonnet-5-5',
  payer_mode text not null default 'deployer' check (payer_mode in ('deployer','byok')), key_secret_id uuid,
  daily_replies_per_user integer not null default 100 check (daily_replies_per_user between 1 and 10000),
  monthly_token_budget bigint check (monthly_token_budget is null or monthly_token_budget > 0),
  access_mode text not null default 'invite_only' check (access_mode in ('invite_only','domain')), allowed_domain citext, notice text,
  status text not null default 'active' check (status in ('active','paused')), version integer not null default 1,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index agents_owner_idx on public.agents(owner_id);
create table public.members (id uuid primary key default gen_random_uuid(), agent_id uuid not null references public.agents(id) on delete cascade, email citext not null,
  role text not null default 'user' check (role in ('user','admin')), status text not null default 'invited' check (status in ('invited','active','revoked')),
  user_id uuid references auth.users(id) on delete set null, daily_limit_override integer, invited_at timestamptz not null default now(), first_login_at timestamptz, unique (agent_id, email));
create index members_email_idx on public.members(email);
create table public.sessions (id uuid primary key default gen_random_uuid(), agent_id uuid not null references public.agents(id) on delete cascade, user_id uuid not null references auth.users(id) on delete cascade, agent_version integer not null, created_at timestamptz not null default now());
create index sessions_agent_user_idx on public.sessions(agent_id, user_id, created_at desc);
create table public.messages (id bigint generated always as identity primary key, session_id uuid not null references public.sessions(id) on delete cascade, agent_id uuid not null references public.agents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade, idx integer not null, role text not null check (role in ('user','assistant')), content text not null,
  input_tokens integer, output_tokens integer, latency_ms integer, created_at timestamptz not null default now(), unique (session_id, idx));
create index messages_agent_time_idx on public.messages(agent_id, created_at);
create index messages_user_time_idx on public.messages(user_id, agent_id, created_at);
create table public.model_prices (model text primary key, input_usd_per_mtok numeric not null, output_usd_per_mtok numeric not null, updated_at timestamptz not null default now());
create table public.audit (id bigint generated always as identity primary key, owner_id uuid references public.owners(user_id) on delete cascade, agent_id uuid references public.agents(id) on delete set null, actor text not null, action text not null, detail jsonb, created_at timestamptz not null default now());
create index audit_owner_idx on public.audit(owner_id, created_at desc);
create table public.settings (key text primary key, value text not null, updated_at timestamptz not null default now());
do $$ declare t text; begin
  foreach t in array array['owners','deploy_tokens','agents','members','sessions','messages','model_prices','audit','settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop; end $$;
insert into public.settings(key, value) values ('app_url','https://seantucker-spais.github.io/KarmanLang/'),('owner_emails','seantucker@spais.io'),('from_name','KarmanLang');

-- Vault helpers for bring-your-own-key agents (service role only).
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create or replace function private.set_agent_key(p_agent uuid, p_key text) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_old uuid; v_new uuid; begin
  select key_secret_id into v_old from public.agents where id = p_agent;
  if v_old is not null then perform vault.update_secret(v_old, p_key); v_new := v_old;
  else v_new := vault.create_secret(p_key, 'agent_key_' || p_agent::text, 'KarmanLang BYOK key'); update public.agents set key_secret_id = v_new where id = p_agent; end if;
  return v_new; end $$;
create or replace function private.get_agent_key(p_agent uuid) returns text language sql security definer set search_path = '' as $$
  select s.decrypted_secret from vault.decrypted_secrets s join public.agents a on a.key_secret_id = s.id where a.id = p_agent; $$;
create or replace function private.clear_agent_key(p_agent uuid) returns void language plpgsql security definer set search_path = '' as $$
declare v uuid; begin select key_secret_id into v from public.agents where id = p_agent;
  if v is not null then delete from vault.secrets where id = v; update public.agents set key_secret_id = null where id = p_agent; end if; end $$;
create or replace function public.kl_set_agent_key(p_agent uuid, p_key text) returns uuid language sql security definer set search_path = '' as $$ select private.set_agent_key(p_agent, p_key) $$;
create or replace function public.kl_get_agent_key(p_agent uuid) returns text language sql security definer set search_path = '' as $$ select private.get_agent_key(p_agent) $$;
create or replace function public.kl_clear_agent_key(p_agent uuid) returns void language sql security definer set search_path = '' as $$ select private.clear_agent_key(p_agent) $$;
revoke all on function private.set_agent_key(uuid, text), private.get_agent_key(uuid), private.clear_agent_key(uuid),
  public.kl_set_agent_key(uuid, text), public.kl_get_agent_key(uuid), public.kl_clear_agent_key(uuid) from public, anon, authenticated;
grant usage on schema private to service_role;
grant execute on function private.set_agent_key(uuid, text), private.get_agent_key(uuid), private.clear_agent_key(uuid),
  public.kl_set_agent_key(uuid, text), public.kl_get_agent_key(uuid), public.kl_clear_agent_key(uuid) to service_role;
