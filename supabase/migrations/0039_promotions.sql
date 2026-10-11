-- Promote this package (growth loop WP15). One click on a live trip builds a plan of marketing actions around it
-- (tracked search phrases, blog ideas, guide pages, one social post) and queues each into machinery that already
-- exists. A promotion is one row here; the plan column holds the actions it queued and their ids, so the admin
-- panel can show progress. At most one promotion per package per 30 days is enforced in code (lib/promotion.ts).
create table if not exists public.package_promotions (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references public.travel_packages (id) on delete cascade,
  started_at timestamptz not null default now(),
  -- The actions and their ids: { keywords: [...], ideas: [{ id, keyword, title }], guides: [{ kind, slug, name }],
  -- social: { slug, path, state, note }, notes: [...] }.
  plan jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'paused', 'done')),
  created_at timestamptz not null default now()
);

create index if not exists package_promotions_package_idx on public.package_promotions (package_id, started_at desc);

comment on table public.package_promotions is 'One row per "Promote this package" click: the plan of marketing actions queued around a trip. Service role only.';

-- Admin table: RLS on and no policy, so only the service role (admin API routes) can read or write it.
alter table public.package_promotions enable row level security;

-- A blog idea made for one package remembers which package it is about (its slug), so the writer grounds the post
-- in that trip. Nullable and additive: ideas made by the keyword engine or by hand keep working unchanged.
alter table public.blog_topic_queue add column if not exists package_slug text;

comment on column public.blog_topic_queue.package_slug is 'The travel_packages slug this idea was made for by Promote this package. Null for every other idea.';
