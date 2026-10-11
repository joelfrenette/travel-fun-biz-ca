-- Convert to Past Trip (growth loop WP14). A trip whose dates passed is NEVER unpublished: its page keeps
-- its URL, title and body and gains a recap (a short write-up, highlights, the trip's photos) plus a
-- "tell me about the next one" alert signup. These columns hold that.
--
-- recap_mode: 'auto' = the recap layout switches on by date (as today), 'recap' = force the recap layout
-- even if the dates have not passed, 'live' = force the normal bookable layout even if the dates passed.
-- recap_summary / recap_highlights: Joel's reviewed recap text (written from his own journal notes, shown
-- only after he clicks Publish recap in the admin).
-- next_trip_slug: the trip the "Join the next trip" button points to (blank = the soonest upcoming trip in
-- the same category). alert_tag: the GoHighLevel tag for "tell me about the next one" (blank = alert:<category>).
--
-- No new policy is needed: travel_packages already has its public read policy for published rows and the
-- admin writes through the service role, so the new columns follow the table's existing rules.
alter table public.travel_packages add column if not exists recap_mode text not null default 'auto';
alter table public.travel_packages add column if not exists recap_summary text;
alter table public.travel_packages add column if not exists recap_highlights text[] not null default '{}';
alter table public.travel_packages add column if not exists recap_generated_at timestamptz;
alter table public.travel_packages add column if not exists next_trip_slug text;
alter table public.travel_packages add column if not exists alert_tag text;

alter table public.travel_packages drop constraint if exists travel_packages_recap_mode_check;
alter table public.travel_packages add constraint travel_packages_recap_mode_check check (recap_mode in ('auto', 'recap', 'live'));

comment on column public.travel_packages.recap_mode is 'auto (recap layout by date), recap (force recap), live (force the bookable layout). A past trip is never unpublished.';
comment on column public.travel_packages.recap_summary is 'The published recap paragraph(s), written from the admin''s own journal notes and approved with Publish recap.';
comment on column public.travel_packages.alert_tag is 'GoHighLevel tag added to people who ask to hear about the next trip like this one. Blank means alert:<category slug>.';

-- Trip photos the admin took ("photo" sources) are stored in the same private bucket as the other sources and
-- copied into the trip gallery from the Convert to Past Trip panel. Extends the kind check from 0034.
alter table public.package_sources drop constraint if exists package_sources_kind_check;
alter table public.package_sources add constraint package_sources_kind_check check (kind in ('screenshot', 'pdf', 'url', 'text', 'photo'));
