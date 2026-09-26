-- Factory Phase 3: tracking foundation (schema only). Shape matches lib/traffic-source.ts's
-- SourceTouch. Nothing writes to this table yet - the route that would (a consent-gated
-- /api/track/visit) is deliberately not built here, since it needs a compliant cookie-consent
-- notice in front of it first (Decision 8, still outstanding: Joel supplies the CASL/PIPEDA/
-- Law25 wording). This table existing early just means the funnel dashboard (a later phase) has
-- somewhere real to read from once that wiring lands - it collects nothing on its own.
create table if not exists site_visits (
  id uuid primary key default gen_random_uuid(),
  channel text not null,
  source text not null default '',
  medium text not null default '',
  campaign text not null default '',
  content text not null default '',
  landing_path text not null default '',
  referrer_host text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists site_visits_channel_idx on site_visits (channel, created_at);

alter table site_visits enable row level security;
-- No policies: service-role only, same pattern as every other table in this project.
