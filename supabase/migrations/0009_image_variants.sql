-- Image format pipeline (2026-09-26): a package's source image gets smart-cropped into every
-- shape the site and social media actually need, instead of one photo being force-fit into all of
-- them at render time (the cause of Joel's "blurry when zoomed for the banner" complaint).
-- image_url stays the horizontal (16:9) variant, now consistently generated instead of a raw copy.
alter table public.travel_packages
  add column if not exists image_url_square text,
  add column if not exists image_url_portrait text,
  add column if not exists image_url_banner text;

comment on column public.travel_packages.image_url_square is 'Image format pipeline: 1080x1080 smart-cropped variant, generated from image_url''s source photo.';
comment on column public.travel_packages.image_url_portrait is 'Image format pipeline: 1080x1350 smart-cropped variant.';
comment on column public.travel_packages.image_url_banner is 'Image format pipeline: 1600x500 smart-cropped variant, for the package landing-page hero.';
