-- Travel advisories (one evergreen page per country): the CURRENT official advisory per country, and a dated update log.
-- Additive and safe to run twice. NOT applied by the code that ships it: run it in the Supabase SQL editor.
-- Service-role only: RLS on, no policy on purpose (the same as every admin table). The public page reads through the
-- server (admin client) and shows published rows only, and only while app_settings.country_advisories_mode is 'on'.
--
-- What is stored: the feed's own words (level text, a short description, an update line), the official link and the
-- official dates. Nothing is estimated, summarised or combined. Every field may be null: an empty field is never filled in.
-- Source-agnostic on purpose: the columns are prefixed by source (ca_ = Government of Canada, uk_ = UK FCDO) and the log
-- carries a source_key, so another government feed can be added without a new table.

create table if not exists public.country_advisories (
  slug text primary key check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null,
  -- Canada's country code from its feed (lower case). Null when the country came only from the UK feed.
  iso text,
  -- Hand-set only: the slug of a destination guide that covers this country. Null = no link. Never guessed.
  guide_slug text,
  -- Government of Canada: the level wording exactly as the feed gives it (for example "Exercise a high degree of caution"),
  -- one short quoted sentence from its description, the official page, when Canada published it, when we last saw it.
  ca_level text,
  ca_text text,
  ca_source_url text,
  ca_source_published_at timestamptz,
  ca_checked_at timestamptz,
  -- UK FCDO: its feed gives an update line and a date, never a level. So there is no uk_level column on purpose.
  uk_text text,
  uk_source_url text,
  uk_source_published_at timestamptz,
  uk_checked_at timestamptz,
  status text not null default 'draft' check (status in ('draft', 'published')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists country_advisories_status_idx on public.country_advisories (status, updated_at desc);
create index if not exists country_advisories_iso_idx on public.country_advisories (iso) where iso is not null;

create table if not exists public.country_advisory_log (
  id uuid primary key default gen_random_uuid(),
  country_slug text not null,
  -- 'gac-advisories' (Canada) or 'uk-fcdo' (the news feed keys), so a re-read never double-logs: (source_key, guid) is unique.
  source_key text not null,
  guid text not null,
  kind text not null check (kind in ('level_change', 'text_update')),
  level_from text,
  level_to text,
  text text,
  source_url text,
  source_published_at timestamptz,
  news_item_id uuid,
  created_at timestamptz not null default now(),
  constraint country_advisory_log_source_guid_key unique (source_key, guid)
);

create index if not exists country_advisory_log_country_idx on public.country_advisory_log (country_slug, created_at desc);

alter table public.country_advisories enable row level security;
alter table public.country_advisory_log enable row level security;

comment on table public.country_advisories is 'Current official travel advisory per country (Government of Canada level and quote, UK FCDO update line). Fed by the news ingest. Service-role only.';
comment on table public.country_advisory_log is 'Append-only dated update log for country_advisories. (source_key, guid) is unique so a re-read never double-logs. Service-role only.';
comment on column public.country_advisories.guide_slug is 'Hand-set slug of a destination guide for this country. Null means no link is shown.';
comment on column public.country_advisories.uk_text is 'The UK FCDO update line as the feed gave it. The UK feed has no level, so none is stored or shown.';
