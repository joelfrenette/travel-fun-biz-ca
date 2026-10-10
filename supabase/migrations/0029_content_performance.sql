-- Growth loop WP3: one row per site page per day with what that page earned, so the writer can lean
-- toward the styles that really work (see lib/content-performance.ts). Written once a day by the
-- pipeline's housekeeping step. Service-role only: RLS on, no policy on purpose.
create table if not exists content_performance (
  id bigserial primary key,
  day date not null,
  path text not null,
  -- Google Search Console, trailing 28 days as of `day` (a rolling total, not that day's own delta,
  -- so never sum several days). Null when Search Console is not connected.
  clicks integer,
  impressions integer,
  position numeric,
  -- Visits to the page from site_visits over the same 28 days. Null when visits are not recorded.
  visits integer,
  -- Social: platform sends and failed stages for the post with this slug (blog paths only).
  social_sends integer,
  social_failures integer,
  -- Real (non-test) leads credited to this path over the last 90 days.
  leads integer,
  unique (day, path)
);

create index if not exists content_performance_path_idx on content_performance (path, day desc);

alter table content_performance enable row level security;

comment on table content_performance is 'Growth loop WP3: daily per-page performance snapshot. Service-role only.';
comment on column content_performance.clicks is 'Search Console clicks, trailing 28 days as of day. Do not sum across days.';
comment on column content_performance.visits is 'site_visits rows landing on this path in the last 28 days; null when none are recorded at all.';
comment on column content_performance.social_sends is 'Platforms the post, carousel and video went to (post_distribution.sent_platforms plus content_pipeline carousel_sent and video_sent).';
comment on column content_performance.social_failures is 'Failed stages for the post (post_distribution, carousel, video).';
comment on column content_performance.leads is 'Non-test leads in the last 90 days whose page_path is this path or whose utm_campaign is this blog slug.';
