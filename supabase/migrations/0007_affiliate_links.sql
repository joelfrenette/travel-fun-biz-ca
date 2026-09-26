-- Factory Phase 6: affiliate layer, outbound side. /go/<slug> short links and the click ledger.
-- affiliate_links has no admin screen to create rows yet (the "Affiliate Code Manager" nav item
-- is still Coming Soon) - an empty table means every /go/<slug> falls through to the home page,
-- so this ships with no live behavior change.
create table if not exists affiliate_links (
  id uuid primary key default gen_random_uuid(),
  slug text unique,
  status text not null default 'draft' check (status in ('draft', 'active', 'hidden')),
  url text not null,
  merchant text,
  title text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint affiliate_links_slug_format check (slug is null or slug ~ '^[a-z0-9][a-z0-9-]{1,40}$')
);

-- Sales/commissions are NOT here - those only ever exist in each merchant's own affiliate
-- dashboard. This is click traffic only, logged server-side by the /go redirect.
create table if not exists affiliate_clicks (
  id uuid primary key default gen_random_uuid(),
  link_id uuid references affiliate_links(id) on delete cascade,
  merchant text,
  page text,
  channel text,
  channel_source text,
  referrer_host text,
  created_at timestamptz not null default now()
);
create index if not exists affiliate_clicks_link_idx on affiliate_clicks (link_id);
create index if not exists affiliate_clicks_created_idx on affiliate_clicks (created_at);

alter table affiliate_links enable row level security;
alter table affiliate_clicks enable row level security;

-- affiliate_links needs one real public policy: the /go redirect reads an ACTIVE card with the
-- anon client (a public redirect has no reason to hold the service-role key for a read) - same
-- "anon reads published rows only" pattern travel_packages already uses.
drop policy if exists "public read active affiliate_links" on affiliate_links;
create policy "public read active affiliate_links" on affiliate_links
  for select using (status = 'active');
-- No other policies: every write, and every read of a draft/hidden link, is service-role only.
