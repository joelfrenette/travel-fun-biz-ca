-- Factory Phase 1 (foundation): operational switches the admin owns, not secrets.
-- Ported from Nomad Escape Plan's app_settings (modules/marketing/app-settings.ts). Changing a
-- setting must never require a redeploy, which is why it lives here instead of a Vercel env var.
-- API keys and tokens stay in env, where they belong. Admin-only by RLS, same pattern as every
-- other table in this project: the service role reads and writes it, nothing else has a policy.
create table public.app_settings (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;

comment on table public.app_settings is 'Factory parity program: operational switches (autoblog mode, distribution mode, cron heartbeats, and so on), not secrets. Service-role only.';
