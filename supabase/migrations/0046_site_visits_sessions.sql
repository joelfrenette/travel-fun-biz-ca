-- Visit tracking (autoblogging row 11): turns site_visits into ONE ROW PER VISIT (session), written by the consent-gated
-- POST /api/track/visit. The writer is SWITCHED OFF by default (app_settings key visit_tracking), so applying this file
-- changes nothing for visitors. Additive and safe to run twice. No IP address and no full browser string is ever stored.
--
-- The existing columns (channel, source, medium, campaign, content, landing_path, referrer_host) keep meaning "how this
-- visit began". The new columns add the random ids, first/last touch, pages and time on site.
alter table public.site_visits add column if not exists visitor_id text;
alter table public.site_visits add column if not exists session_id text;
alter table public.site_visits add column if not exists first_touch_channel text;
alter table public.site_visits add column if not exists first_touch_source text;
alter table public.site_visits add column if not exists last_touch_channel text;
alter table public.site_visits add column if not exists last_touch_source text;
alter table public.site_visits add column if not exists page_views integer not null default 1;
alter table public.site_visits add column if not exists last_path text;
alter table public.site_visits add column if not exists duration_s integer not null default 0;
alter table public.site_visits add column if not exists browser text;
alter table public.site_visits add column if not exists updated_at timestamptz;

-- One row per session, even if two requests race.
create unique index if not exists site_visits_session_uidx on public.site_visits (session_id) where session_id is not null;
-- Find a returning visitor's last visit quickly (first and last touch are carried forward from it).
create index if not exists site_visits_visitor_idx on public.site_visits (visitor_id, created_at desc) where visitor_id is not null;
-- The daily purge deletes rows older than 13 months in small batches.
create index if not exists site_visits_created_idx on public.site_visits (created_at);

comment on table public.site_visits is 'One row per visit, written only when app_settings visit_tracking is on and the visitor accepted analytics. Holds the page path, the referrer host, campaign tags, a random id and time on site. No IP address, no user agent. Rows older than 13 months are deleted by the daily housekeeping.';
