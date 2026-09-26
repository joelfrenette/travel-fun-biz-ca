-- Factory Phase 5: SEO/indexing. Daily cron /api/cron/gsc-snapshot copies Search Console's
-- 28-day average positions into these two tables so a future dashboard phase can chart pages and
-- keywords moving up or down. Dormant until Search Console is configured AND CRON_SECRET is set.
create table if not exists gsc_ranking_days (
  day date primary key,
  top10 integer not null default 0,
  top50 integer not null default 0,
  top100 integer not null default 0,
  queries integer not null default 0,
  clicks integer not null default 0,
  impressions integer not null default 0,
  created_at timestamptz not null default now()
);

-- One row per day and tracked page / keyword: its average position that day.
create table if not exists gsc_rankings (
  day date not null,
  kind text not null check (kind in ('query', 'page')),
  key text not null,
  position numeric not null,
  clicks integer not null default 0,
  impressions integer not null default 0,
  primary key (day, kind, key)
);
create index if not exists gsc_rankings_kind_key_day on gsc_rankings (kind, key, day);

alter table gsc_ranking_days enable row level security;
alter table gsc_rankings enable row level security;
-- No policies: service-role only, same pattern as every other table in this project.
