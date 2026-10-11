-- Agent submission links (growth loop WP13). Joel creates a link for an outside agent; the agent opens
-- /submit-trip/<token> (no login), drops a screenshot, a PDF, a link or text, and a DRAFT trip page is created and
-- filled in with the same grounded extraction the admin uses. Joel approves or rejects it in the editor.
--
-- Admin only: RLS on, no policy. The public routes validate the token first and then use the service role
-- (getSupabaseAdmin()); nothing here is readable with the anon key.
--
-- The token IS the capability (32 random url-safe characters), so it is stored as is: Joel needs to copy the link
-- again later. It is never logged and never shown to anyone but the admin.
create table if not exists public.agent_invites (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  agent_name text not null,
  agent_email text,
  note text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  -- Drafts started with this link so far, and the most it may ever take (the total cap; 5 new drafts and 10 sources a
  -- day are enforced in code).
  uses integer not null default 0,
  max_uses integer not null default 20
);

create index if not exists agent_invites_created_idx on public.agent_invites (created_at desc);

create table if not exists public.package_submissions (
  id uuid primary key default gen_random_uuid(),
  invite_id uuid references public.agent_invites(id) on delete set null,
  -- The draft trip page. Null for a moment while the draft is being created, and after that draft is deleted.
  package_id uuid references public.travel_packages(id) on delete set null,
  -- "submitted_by": the agent. The draft's own supplier column also carries the agent's name.
  agent_name text not null,
  agent_email text,
  -- What the agent typed for Joel. Free text, shown only in the admin and back to that agent.
  message text,
  trip_name text,
  destination text,
  dates_note text,
  -- Field names the site filled in on the draft (kept for the admin's list).
  filled_fields text[] not null default '{}',
  -- Where the draft is in the agent's flow:
  --   in_progress  the agent is still adding and editing (the agent can change it)
  --   submitted    sent to Joel; locked for the agent ("Joel is reviewing")
  --   rejected     Joel sent it back with review_note; the agent can change it and send again
  --   approved     Joel published it; locked
  submission_state text not null default 'in_progress' check (submission_state in ('in_progress', 'submitted', 'rejected', 'approved')),
  -- Joel's note to the agent when he sends a draft back. The agent can read it on their page.
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  decided_at timestamptz
);

-- Screenshots dropped together are ONE source (one model call): storage_path is the first picture, extra_paths the rest
-- in order. Empty for every older source.
alter table public.package_sources add column if not exists extra_paths text[] not null default '{}';

create index if not exists package_submissions_invite_idx on public.package_submissions (invite_id, created_at desc);
create index if not exists package_submissions_package_idx on public.package_submissions (package_id);
create index if not exists package_submissions_state_idx on public.package_submissions (submission_state, created_at desc);

comment on table public.agent_invites is 'Links Joel sends to outside agents so they can submit a trip as a draft. Service role only.';
comment on table public.package_submissions is 'One row per trip an agent submitted through an invite; the draft stays unpublished until approved. Service role only.';

alter table public.agent_invites enable row level security;
alter table public.package_submissions enable row level security;
-- No policies on purpose: only the service role (admin API routes and the validated public submit route) may touch these tables.
