-- Image format pipeline, part 2 (2026-09-26): tracks WHERE a package's image actually came from,
-- so the admin (and, later, any public-facing disclosure) can tell a real photo apart from an
-- AI-generated illustration used to fill a genuine no-photo gap. Never inferred/backfilled for
-- existing rows — null just means "generated before this column existed," not "definitely a real
-- upload."
alter table public.travel_packages
  add column if not exists image_source text
    check (image_source is null or image_source in ('upload', 'pexels', 'ai_generated'));

comment on column public.travel_packages.image_source is 'Provenance of image_url and its variants: upload (a real photo, from the admin or the travelfunbiz.com sync), pexels (real licensed stock photo), ai_generated (illustration, not a real photo), or null (unknown/predates this column).';
