-- AI usage meter: one row per Anthropic call, written by lib/ai-meter.ts from callAnthropic.
-- Counts only (tokens, estimated cost); never the prompt or the reply. Additive and safe to run twice.
-- Service-role only: RLS on, no policy on purpose.
create table if not exists public.api_calls (
  id bigserial primary key,
  ts timestamptz not null default now(),
  feature text not null default 'other',
  model text not null default '',
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  est_cost_usd numeric(12, 6) not null default 0,
  ok boolean not null default true
);

create index if not exists api_calls_ts_idx on public.api_calls (ts desc);
create index if not exists api_calls_feature_ts_idx on public.api_calls (feature, ts desc);

alter table public.api_calls enable row level security;

comment on table public.api_calls is 'AI usage meter: one row per Anthropic call. Counts and an ESTIMATED cost only. Service-role only.';
comment on column public.api_calls.est_cost_usd is 'Estimate from a constant rate table in lib/ai-meter.ts. Not an invoice.';
