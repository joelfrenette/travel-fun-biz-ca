-- Growth loop WP16: scope labels and a review state for guide pages. Additive and idempotent; row level security
-- is unchanged (the public can read published rows only, everything else is service role).
--
-- scope: how wide the page is (a country, region, city, port of call, supplier, one property, a cruise line, one
-- ship or a ship class). The page keeps its kind (destinations, hotels, resorts ...); scope is a second label.
-- Null means "not set": the site then infers one from the name where that is safe (lib/guide-scope.ts).
-- parent_slug already exists (migration 0028) and now chains: a port under a city, a city under a country, a ship
-- under a cruise line.
--
-- review_state: 'rejected' marks a draft that a person looked at in the review queue and turned down, so it stops
-- showing as waiting. Null means not reviewed yet. A rejected draft is never published by the bulk buttons.
alter table public.guides add column if not exists scope text;
alter table public.guides add column if not exists review_state text;

alter table public.guides drop constraint if exists guides_scope_check;
alter table public.guides
  add constraint guides_scope_check
  check (scope is null or scope in ('country', 'region', 'city', 'port', 'supplier', 'property', 'line', 'ship', 'class'));

alter table public.guides drop constraint if exists guides_review_state_check;
alter table public.guides
  add constraint guides_review_state_check
  check (review_state is null or review_state in ('rejected'));

create index if not exists guides_parent_slug_idx on public.guides (parent_slug);

comment on column public.guides.scope is 'How wide the page is: country, region, city, port, supplier, property, line, ship or class. Null = not set.';
comment on column public.guides.review_state is 'rejected = a person turned this draft down in the review queue. Null = not reviewed.';
