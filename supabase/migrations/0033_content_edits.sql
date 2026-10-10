-- Self-healing content (growth loop WP10): the audit trail of every automatic edit, and the SEO score stored on
-- each page. Written by lib/content-repair.ts (reword or remove a held phrase, then publish if the gate is clean)
-- and lib/content-heal-run.ts (the daily score-and-fix step). Nothing here is read by visitors.
--
-- Every automatic edit is one row: what page, which field, why, the text before and after, and how it was done.
-- The admin list (/admin/content-edits) can put the `before` text back (a "revert"), which stamps reverted_at.
-- content_id is nullable on purpose: the audit row is written BEFORE a freshly composed page is saved, then
-- pointed at the saved row (path says which page it was meanwhile).
create table if not exists public.content_edits (
  id uuid primary key default gen_random_uuid(),
  content_type text not null check (content_type in ('post', 'guide', 'page_copy')),
  content_id uuid,
  -- The public path of the page, for example /blog/some-post, /hotels/some-hotel, /compare/italy-vs-greece.
  path text not null default '',
  field text not null check (field in ('body', 'title', 'meta_title', 'meta_description', 'og_title', 'og_description', 'faq', 'key_takeaways', 'links')),
  reason text not null default '',
  -- For body and links: the page text (for a guide: the opening summary followed by the sections). For faq and
  -- key_takeaways: JSON. For the others: the plain value.
  before text,
  after text,
  method text not null check (method in ('ai', 'delete', 'fixer', 'links', 'generate')),
  published_after boolean not null default false,
  -- The estimated model cost of the call that made this edit (a per-call estimate, not a bill). Zero for edits made without a model.
  cost_usd numeric(8, 4) not null default 0,
  reverted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists content_edits_created_at_idx on public.content_edits (created_at desc);
create index if not exists content_edits_content_idx on public.content_edits (content_type, content_id);

comment on table public.content_edits is 'Audit trail of automatic content edits (reworded or removed phrases, generated meta text, added links). Service role only.';

-- Admin table: RLS on and no policy, so only the service role (admin API routes and the pipeline) can read or write it.
alter table public.content_edits enable row level security;

-- The SEO score (0 to 100) of each published page, computed daily by the heal-content step (no AI), with the
-- plain-English reasons it lost points. Nothing secret: the public blog query selects every column of posts, so
-- a visitor's query carries these too; the pages never render them.
alter table public.posts add column if not exists seo_score integer;
alter table public.posts add column if not exists seo_reasons text[];
alter table public.posts add column if not exists seo_scored_at timestamptz;

alter table public.guides add column if not exists seo_score integer;
alter table public.guides add column if not exists seo_reasons text[];
alter table public.guides add column if not exists seo_scored_at timestamptz;

alter table public.page_copy add column if not exists seo_score integer;
alter table public.page_copy add column if not exists seo_reasons text[];
alter table public.page_copy add column if not exists seo_scored_at timestamptz;
