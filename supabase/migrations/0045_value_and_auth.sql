-- Admin sign-in log, plus the Website Value page's three tables. Additive and safe to run twice.
-- All service-role only: RLS on, no policy on purpose.

-- Admin sign-ins. A salted hash of the IP and a short browser label; never the raw IP, an email or a password.
create table if not exists public.auth_events (
  id bigserial primary key,
  ts timestamptz not null default now(),
  kind text not null check (kind in ('login_ok', 'login_fail', 'logout')),
  ip_hash text not null default '',
  ua_short text not null default ''
);
create index if not exists auth_events_ts_idx on public.auth_events (ts desc);
alter table public.auth_events enable row level security;

-- Things only the owner knows (domain registration date, email list size, owner hours, risks, the
-- valuation multiple and sliders). One row per key, each with an "as of" date so staleness shows.
create table if not exists public.value_inputs (
  key text primary key,
  value text,
  as_of date,
  note text,
  updated_at timestamptz not null default now()
);
alter table public.value_inputs enable row level security;

-- Computed metrics, one row per metric per period (YYYY-MM).
create table if not exists public.value_metrics (
  metric_key text not null,
  period text not null,
  value numeric,
  source text,
  computed_at timestamptz not null default now(),
  primary key (metric_key, period)
);
alter table public.value_metrics enable row level security;

-- A frozen copy of the page once a month, so history cannot be rewritten. Aggregates only.
create table if not exists public.value_snapshots (
  period text primary key,
  metrics jsonb not null default '{}'::jsonb,
  estimate jsonb,
  created_at timestamptz not null default now()
);
alter table public.value_snapshots enable row level security;

comment on table public.value_snapshots is 'Monthly frozen copy of the Website Value page (lib/value-snapshot.ts). Aggregates only, no lead rows or emails.';
