-- Descriptive text for the destination a package is in (roadmap use case f267e278), split out
-- from the image-auto-generation work: the destination page currently shows only trip cards,
-- with no body copy about the place itself. One row per destination (keyed the same way
-- lib/destinations.ts groups packages: generateSlug(destination)), not per package, since the
-- blurb describes the place, not any one trip to it.
create table if not exists public.destination_blurbs (
  slug text primary key,
  destination text not null,
  blurb text not null,
  source text not null default 'ai' check (source in ('ai', 'manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.destination_blurbs is 'One short editorial blurb per destination slug, shown on /destinations/[slug]. source=ai means AI-written (general, non-numeric travel-guide style); manual means an admin edited or wrote it directly.';

alter table public.destination_blurbs enable row level security;

-- Public (anon) read: the blurb is shown on a public page.
drop policy if exists "destination_blurbs_public_read" on public.destination_blurbs;
create policy "destination_blurbs_public_read" on public.destination_blurbs for select using (true);

-- No public write policy: only the service role (admin API routes) may insert/update/delete,
-- same pattern as travel_packages after 20260924213103_drop_public_write_policy_on_travel_packages.
