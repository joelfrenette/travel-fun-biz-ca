-- Factory Phase 12: dormant social-distribution ledger + mode gate. Skipped ahead of in Phase 6
-- (see that PR's note) because the actual posting side needs a real provider decision Joel hasn't
-- made yet (GHL Social Planner vs Ayrshare vs Upload-Post, plus whether Shotstack video is wanted
-- at all). This is only the part that's genuinely code-only without that decision: a ledger of
-- which published posts are enrolled to go out, and an off/prepare/auto mode gate + a manual
-- accounts allow-list, both stored in app_settings (Phase 1) alongside autoblog_mode.
--
-- Deliberately NOT ported here (would be guessing at a provider's own data shape): render_id,
-- video_url, reel_post_id, social_post_ids, social_sent, social_copy. Those get added in the
-- phase that actually wires in a chosen provider, not invented now.
create table if not exists public.post_distribution (
  content_type text not null default 'post' check (content_type in ('post')),
  slug text not null,
  title text not null,
  stage text not null default 'queued' check (stage in ('queued', 'held', 'done', 'failed')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (content_type, slug)
);

alter table public.post_distribution enable row level security;

comment on table public.post_distribution is 'Factory Phase 12: dormant distribution ledger. A row here means a published post is ENROLLED to go out once a real posting provider is wired in - nothing here actually posts anything yet. Service-role only.';
comment on column public.post_distribution.stage is 'queued: enrolled, waiting on a provider to exist. held: admin paused it. done/failed: reachable only once a real provider is wired in.';
