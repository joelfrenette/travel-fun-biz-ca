-- Real copy for the programmatic Compare (/compare/<a>-vs-<b>) and Best time (/best-time-to-visit/<slug>)
-- pages (growth loop wave 2, WP8). One row per page path. Written by the content pipeline (step "copy") or
-- the admin, grounded only in the real packages the page lists, published only when the mechanical quality
-- gate in lib/page-copy-composer.ts passes (or when an admin publishes it by hand). A page with no published
-- row renders exactly as it did before.
create table if not exists public.page_copy (
  id uuid primary key default gen_random_uuid(),
  -- The public path, for example /compare/italy-vs-tahiti or /best-time-to-visit/santorini.
  path text not null unique,
  page_type text not null check (page_type in ('compare', 'best-time')),
  -- Markdown, 150 to 300 words, direct answer first, no headings.
  intro text not null default '',
  faq jsonb not null default '[]'::jsonb,
  key_takeaways text[] not null default '{}',
  -- Slugs of the /packages/<slug> trips the intro links to. At render time, if any is no longer among the
  -- page's current trips, the page shows no copy at all (see lib/page-copy-render.ts).
  linked_slugs text[] not null default '{}',
  meta_title text,
  meta_description text,
  og_title text,
  og_description text,
  primary_keyword text,
  status text not null default 'draft' check (status in ('draft', 'published')),
  source text not null default 'ai' check (source in ('ai', 'manual')),
  quality_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists page_copy_status_idx on public.page_copy (status, page_type);
create index if not exists page_copy_created_at_idx on public.page_copy (created_at);

comment on table public.page_copy is 'Copy for compare and best-time pages. status=published rows are public; everything else is service-role only.';
comment on column public.page_copy.quality_notes is 'Why the quality gate held a page back as a draft (blank when it passed).';

alter table public.page_copy enable row level security;

-- Public (anon) read of published copy only. No public write policy: only the service role
-- (admin API routes and the content pipeline) may insert, update or delete.
drop policy if exists "page_copy_public_read_published" on public.page_copy;
create policy "page_copy_public_read_published" on public.page_copy for select using (status = 'published');
