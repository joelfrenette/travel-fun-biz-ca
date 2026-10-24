-- Travel specialist (agent) profiles: public SEO pages /agents and /agents/<slug>, a back-office roster, a tokenised
-- self-service profile form, achievements and agent of the month.
--
-- PRIVACY: RLS is ON for every table here and there are NO policies on purpose. Nothing is readable with the anon key.
-- Public pages read through the server only (getSupabaseAdmin) and select an explicit PUBLIC column list
-- (lib/agents.ts AGENT_PUBLIC_COLUMNS), never "*". The PRIVATE columns (email, phone, notes, internal_tags) and
-- agent_achievements.internal_value (sales / commission figures) must never be selected by public code.
-- scripts/check-agents.ts enforces that list.
--
-- Leads keep going through the website funnel: agent pages never show a personal phone or email.

create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  display_name text not null,
  headline text,
  bio text,
  specialties text[] not null default '{}',
  -- [{ "name": "...", "issuer": "...", "year": 2021, "verified": false }]. Shown publicly ONLY when verified = true.
  certifications jsonb not null default '[]'::jsonb,
  years_experience integer check (years_experience is null or (years_experience >= 0 and years_experience <= 80)),
  languages text[] not null default '{}',
  home_city text,
  region text,
  photo_url text,
  -- Testimonial / intro videos the agent supplied (https links, YouTube or Vimeo embed only on the page).
  video_urls text[] not null default '{}',
  status text not null default 'draft' check (status in ('draft', 'ready', 'published')),
  consent_photo boolean not null default false,
  consent_bio boolean not null default false,
  featured boolean not null default false,
  sort_order integer not null default 100,
  published_at timestamptz,
  -- PRIVATE columns: never selected by public code.
  email text,
  phone text,
  -- Home / mailing address from the roster sheet. PRIVATE: never public, never in AGENT_PUBLIC_COLUMNS.
  address text,
  notes text,
  internal_tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agents_status_idx on public.agents (status, featured desc, sort_order);

create table if not exists public.agent_achievements (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  -- Plain label of the kind of milestone, e.g. high_commission, growth_target, certification, anniversary, award, other.
  kind text not null default 'other',
  title text not null,
  period text,
  -- Only rows with public = true ever appear on the site, and even then only kind/title/period, never internal_value.
  public boolean not null default false,
  -- Sales / commission figure. ADMIN ONLY. Never public, never in any public select.
  internal_value numeric,
  created_at timestamptz not null default now()
);

create index if not exists agent_achievements_agent_idx on public.agent_achievements (agent_id, created_at desc);

create table if not exists public.agent_of_month (
  id uuid primary key default gen_random_uuid(),
  month text not null unique check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  agent_id uuid not null references public.agents(id) on delete cascade,
  blurb text,
  published boolean not null default false,
  created_at timestamptz not null default now()
);

-- Self-service links: the token is NEVER stored, only its SHA-256 hash (same pattern as recap_shares).
create table if not exists public.agent_profile_links (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  agent_id uuid not null references public.agents(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  uses integer not null default 0,
  last_used_at timestamptz
);

create index if not exists agent_profile_links_agent_idx on public.agent_profile_links (agent_id, created_at desc);

-- What an agent sent through their link. Waits as pending; nothing reaches the live profile until an admin approves it.
create table if not exists public.agent_profile_submissions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  link_id uuid references public.agent_profile_links(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create index if not exists agent_profile_submissions_idx on public.agent_profile_submissions (status, created_at desc);

-- Drafts for a human to approve: welcome post, social caption, agent of the month announcement, and cached AI bio
-- polish (kind = 'bio_polish', input_hash = hash of the agent's own text, so the same text is never polished twice).
create table if not exists public.agent_content_drafts (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  kind text not null check (kind in ('welcome_post', 'social_caption', 'aotm_post', 'aotm_caption', 'bio_polish')),
  title text,
  body text not null,
  input_hash text,
  status text not null default 'draft' check (status in ('draft', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create index if not exists agent_content_drafts_idx on public.agent_content_drafts (status, created_at desc);
create unique index if not exists agent_content_drafts_polish_idx on public.agent_content_drafts (agent_id, input_hash) where kind = 'bio_polish';

comment on table public.agents is 'Travel specialist profiles. Service role only. Public code selects AGENT_PUBLIC_COLUMNS, never email / phone / notes / internal_tags.';
comment on column public.agent_achievements.internal_value is 'Sales / commission figure. Admin only. NEVER public.';

alter table public.agents enable row level security;
alter table public.agent_achievements enable row level security;
alter table public.agent_of_month enable row level security;
alter table public.agent_profile_links enable row level security;
alter table public.agent_profile_submissions enable row level security;
alter table public.agent_content_drafts enable row level security;
-- No policies on purpose.
