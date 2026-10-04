-- Factory item 6/6: A/B testing logging foundation. Real comparison (which variant gets more
-- engagement) needs real engagement data, which this project doesn't have yet - distribution_mode
-- is off and nothing has posted. Building a full comparison UI against zero real data would mean
-- fabricating sample results, which this project's own no-fabrication discipline rules out.
-- Instead: a small, independent table that tags per-post content-generation choices as they
-- happen (cover image source, video hook formula, whether a carousel was generated), so that once
-- the already-built engagement sync (lib/distribution.ts syncPendingDistribution) has real posting
-- history to compare against, the data to do a real comparison already exists.
create table if not exists content_variants (
  slug text primary key,
  variant_tags jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table content_variants enable row level security;
-- Service-role only, same as app_settings/post_distribution - no public policy on purpose.
