-- Travel news auto-poster (growth loop WP20): the feed items the site has read, and what became of each one.
-- Additive and safe to run twice. NOT applied by the code that ships it: run it in the Supabase SQL editor.
-- Service-role only: RLS on, no policy on purpose (the same as every admin table). The public site never reads this table.
--
-- What is stored: the feed item's own title, link, date and a SHORT description (summary_raw, 600 characters at most).
-- Nothing else from the article is ever fetched or stored. summary_raw is a working note for the writer step and is
-- never shown to a visitor; the public page shows only our own short brief.
create table if not exists public.news_items (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  guid text not null,
  url text not null,
  title text not null,
  summary_raw text not null default '' check (char_length(summary_raw) <= 600),
  published_at timestamptz,
  fetched_at timestamptz not null default now(),
  category text not null default 'industry',
  tier smallint not null check (tier in (1, 2)),
  status text not null default 'new' check (status in ('new', 'queued', 'published', 'rejected', 'expired')),
  reject_reason text,
  post_slug text,
  -- when the writer step last decided this item (queued, published or rejected); used for the daily caps
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint news_items_source_guid_key unique (source_key, guid)
);

create index if not exists news_items_status_idx on public.news_items (status, created_at desc);
create index if not exists news_items_decided_idx on public.news_items (decided_at desc) where decided_at is not null;
create index if not exists news_items_post_slug_idx on public.news_items (post_slug) where post_slug is not null;

alter table public.news_items enable row level security;

comment on table public.news_items is 'Travel news feed items read from the allowlisted RSS/Atom feeds (lib/news-sources.ts) and their outcome. Title, link, date and a short description only. Service-role only.';
comment on column public.news_items.summary_raw is 'The feed''s own short description, 600 characters at most. A working note for the writer step. Never displayed publicly.';
comment on column public.news_items.status is 'new: read, not yet written about. queued: a brief passed the checks and is saved as a draft post. published: the post is live. rejected: not travel-affecting, or no brief passed the checks (reject_reason says why). expired: older than 7 days before anything was written.';
