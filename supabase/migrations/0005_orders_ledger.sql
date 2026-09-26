-- Factory Phase 4: leads/CRM, inbound side. Every GHL webhook call is logged (whether accepted
-- or refused), and a real purchase becomes a row in orders, deduped on the CRM's own transaction
-- id so a re-delivered webhook updates the same row instead of double-counting revenue.
create table if not exists webhook_events (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'ghl',
  status integer not null,
  email text,
  payload jsonb,
  created_at timestamptz not null default now()
);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'ghl',
  provider_order_id text not null,
  webhook_event_id uuid references webhook_events(id),
  email text,
  ghl_contact_id text,
  status text not null default 'paid' check (status in ('paid', 'refunded')),
  is_test boolean not null default false,
  amount_cents integer not null default 0,
  subtotal_cents integer,
  discount_cents integer,
  tax_cents integer,
  currency text not null default 'USD',
  coupon_code text,
  gateway text,
  payment_source text,
  package_slug text,
  items jsonb not null default '[]'::jsonb,
  channel text,
  channel_source text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  attribution_basis text not null default 'none',
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider, provider_order_id)
);

create index if not exists orders_email_idx on orders (email);
create index if not exists orders_created_at_idx on orders (created_at);

alter table webhook_events enable row level security;
alter table orders enable row level security;
-- No policies: service-role only, same pattern as every other table in this project.
