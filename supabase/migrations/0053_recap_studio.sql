-- Recap Studio (growth loop). A travel agent, or a traveller, opens a one-trip link with no login and sends photos,
-- notes or a short quote about a trip that already happened. Everything lands in a PENDING queue: nothing is shown on
-- the site until Joel approves it in the Recap Studio.
--
-- Admin only: RLS on, no policy. The public routes validate the token first and then use the service role.
--
-- The token itself is NEVER stored. Only its SHA-256 hash is (so a database leak cannot be turned into working
-- links). The admin sees the link once, when it is made; "make a new link" replaces it.
create table if not exists public.recap_shares (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  package_id uuid not null references public.travel_packages(id) on delete cascade,
  -- agent: photos, five answers and quotes. testimonial: one short quote from a traveller.
  kind text not null default 'agent' check (kind in ('agent', 'testimonial')),
  -- First name of the person the link was made for (shown to them, and next to what they send).
  agent_name text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  uses integer not null default 0,
  last_used_at timestamptz
);

create index if not exists recap_shares_package_idx on public.recap_shares (package_id, created_at desc);

create table if not exists public.recap_submissions (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references public.travel_packages(id) on delete cascade,
  share_id uuid references public.recap_shares(id) on delete set null,
  -- answers: the five questions. quote: a traveller quote with consent. photo: one stored picture.
  kind text not null check (kind in ('answers', 'quote', 'photo')),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  submitted_by text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create index if not exists recap_submissions_package_idx on public.recap_submissions (package_id, status, created_at desc);
create index if not exists recap_submissions_pending_idx on public.recap_submissions (status, created_at desc);

comment on table public.recap_shares is 'One-trip links for an agent or a traveller to send a recap. Token stored hashed. Service role only.';
comment on table public.recap_submissions is 'What came in through a recap link. Pending until Joel approves it. Service role only.';

alter table public.recap_shares enable row level security;
alter table public.recap_submissions enable row level security;
-- No policies on purpose.
