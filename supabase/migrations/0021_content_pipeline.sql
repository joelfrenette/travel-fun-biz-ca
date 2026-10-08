-- Autopilot: one row per published post, tracking how far its repurposing (carousel, short video)
-- has gotten. The autopilot cron advances each row one bounded step per run, so a slow Shotstack
-- render or an Upload-Post hiccup never blocks anything else and a failed step on one post never
-- stops the next post. Service-role only, like every other admin table here.
create table if not exists content_pipeline (
  slug text primary key,
  carousel_stage text not null default 'pending',
  video_stage text not null default 'pending',
  render_id text,
  video_url text,
  attempts jsonb not null default '{}'::jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table content_pipeline enable row level security;

comment on column content_pipeline.carousel_stage is 'pending | generated | posted | failed | skipped';
comment on column content_pipeline.video_stage is 'pending | rendering | rendered | posted | sandbox | failed | skipped. sandbox = rendered in Shotstack''s watermarked stage environment, deliberately never posted.';
