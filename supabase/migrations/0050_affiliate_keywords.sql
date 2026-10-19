-- WP22: "Link a word or phrase". A rule says: when the site writes this phrase, show it as a link to this affiliate link.
-- Additive and idempotent. Nothing is dropped or rewritten, and no page content is ever changed: the pages link the phrase
-- at display time, so editing a link or turning it OFF changes every page on its next render.
-- Admin table: RLS on, no policy, so only the service role (getSupabaseAdmin) reads or writes it.
create table if not exists affiliate_keywords (
  id uuid primary key default gen_random_uuid(),
  phrase text not null,
  link_id uuid not null references affiliate_links(id) on delete cascade,
  scope text not null default 'all' check (scope in ('all', 'guides', 'blog', 'destinations')),
  max_per_page smallint not null default 1 check (max_per_page between 1 and 3),
  status text not null default 'on' check (status in ('on', 'off')),
  created_at timestamptz not null default now(),
  constraint affiliate_keywords_phrase_len check (char_length(phrase) between 2 and 80)
);
alter table affiliate_keywords enable row level security;
create unique index if not exists affiliate_keywords_phrase_link_idx on affiliate_keywords (lower(phrase), link_id);
create index if not exists affiliate_keywords_link_idx on affiliate_keywords (link_id);
create index if not exists affiliate_keywords_status_idx on affiliate_keywords (status);
