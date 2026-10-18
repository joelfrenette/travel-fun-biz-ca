-- WP21: "Fun things to do in <place>" blocks on guide and destination pages.
-- Additive and idempotent. Nothing is dropped or rewritten; every new column is nullable.
--
-- affiliate_partners: one row per travel-activity partner (for example a tours marketplace). The
-- search_template is an https link with two optional placeholders, {query} (the place name) and
-- {partner_id} (our ID with that partner). It is read only on the server and never sent to a visitor:
-- the public page links to /go/p/<partner>/<kind>/<slug>, which fills the template and redirects.
-- Admin table: RLS on, no policy, so only the service role (getSupabaseAdmin) reads or writes it.
create table if not exists affiliate_partners (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  logo_url text,
  partner_id text,
  search_template text,
  disclosure text,
  status text not null default 'draft' check (status in ('draft', 'active', 'hidden')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint affiliate_partners_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$')
);
alter table affiliate_partners enable row level security;

-- Curated cards: an affiliate link can be pinned to one guide page and carry a photo and a short note.
alter table affiliate_links add column if not exists partner_id uuid references affiliate_partners(id) on delete set null;
alter table affiliate_links add column if not exists guide_kind text;
alter table affiliate_links add column if not exists guide_slug text;
alter table affiliate_links add column if not exists image_url text;
alter table affiliate_links add column if not exists note text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'affiliate_links_note_len') then
    alter table affiliate_links add constraint affiliate_links_note_len check (note is null or char_length(note) <= 200);
  end if;
end $$;
create index if not exists affiliate_links_guide_idx on affiliate_links (guide_kind, guide_slug);

-- Click ledger: partner search clicks are counted in the same table as card clicks.
-- link_id stays null for a partner search click; partner_id and guide_key ("<kind>/<slug>") say what it was.
alter table affiliate_clicks add column if not exists partner_id uuid references affiliate_partners(id) on delete set null;
alter table affiliate_clicks add column if not exists guide_key text;
create index if not exists affiliate_clicks_partner_idx on affiliate_clicks (partner_id);
