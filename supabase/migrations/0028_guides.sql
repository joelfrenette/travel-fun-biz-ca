-- Guide pages (growth loop WP4): genuine, SEO/GEO/AEO-ready guides for destinations, hotels, resorts,
-- cruise lines, ships, river cruises and yachts. One row per guide. Written by the content pipeline or
-- from the admin, published only when the mechanical quality gate in lib/guide-composer.ts passes (or
-- when an admin publishes it by hand). Destination guides are shown on the existing
-- /destinations/<slug> page; the other kinds get /<kind>/<slug> (hotels, resorts, cruise-lines, ships,
-- river-cruises, yachts).
create table if not exists public.guides (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('destinations', 'hotels', 'resorts', 'cruise-lines', 'ships', 'river-cruises', 'yachts')),
  slug text not null,
  name text not null,
  -- A resort's destination slug, a ship's cruise line slug. Plain text, not a foreign key: the parent
  -- may be a destination that only exists as a travel_packages value.
  parent_slug text,
  summary text not null default '',
  body text not null default '',
  sections jsonb not null default '[]'::jsonb,
  faq jsonb not null default '[]'::jsonb,
  key_takeaways text[] not null default '{}',
  hero_image_url text,
  hero_alt text,
  meta_title text,
  meta_description text,
  og_title text,
  og_description text,
  primary_keyword text,
  secondary_keywords text[] not null default '{}',
  -- Real published travel_packages ids this guide links to. Never invented.
  related_package_ids uuid[] not null default '{}',
  status text not null default 'draft' check (status in ('draft', 'published')),
  source text not null default 'ai' check (source in ('ai', 'manual')),
  quality_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kind, slug)
);

create index if not exists guides_status_kind_idx on public.guides (status, kind);
create index if not exists guides_created_at_idx on public.guides (created_at);

comment on table public.guides is 'Guide pages for destinations, hotels, resorts, cruise lines, ships, river cruises and yachts. status=published rows are public; everything else is service-role only.';
comment on column public.guides.quality_notes is 'Why the quality gate held a guide back as a draft (blank when it passed).';

alter table public.guides enable row level security;

-- Public (anon) read of published guides only. No public write policy: only the service role
-- (admin API routes and the content pipeline) may insert, update or delete.
drop policy if exists "guides_public_read_published" on public.guides;
create policy "guides_public_read_published" on public.guides for select using (status = 'published');
