-- Factory Phase 10: leads/CRM glue. Every contact-form submission gets a local backup row,
-- whether or not GoHighLevel accepted it - today, a GHL failure just logs to the console and
-- the visitor's lead is gone for good. This is the safety net.
create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  phone text,
  package text,
  travel_date text,
  travelers text,
  message text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  page_path text,
  forwarded_to_ghl boolean not null default false,
  ghl_error text,
  created_at timestamptz not null default now()
);
create index if not exists leads_created_at_idx on leads (created_at);
create index if not exists leads_forwarded_idx on leads (forwarded_to_ghl);

alter table leads enable row level security;
-- No policies: service-role only, same pattern as every other admin table in this project.
