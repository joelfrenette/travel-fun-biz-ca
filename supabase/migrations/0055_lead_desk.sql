-- Lead desk: hot leads (a callback request from a trip page, or any form that includes a phone number) are announced
-- to the office, and the OFFICE (Joel, Shelby, Leslie) decides which agent works each one. Nothing here assigns an agent
-- by itself; assigned_agent_id is only ever written when a person presses Assign on the Today card.
--
-- PRIVACY: leads already has RLS on with no policies (service role only). The new columns inherit that: nothing here is
-- readable with the anon key. assigned_agent_id points at the private agents roster (0054), so it is never selected by public code.
--
-- Safe to run on a table with data: every column is added only if missing and has a default, so existing leads become
-- hot = false, status = 'new' and do not show up on the desk.

alter table public.leads add column if not exists hot boolean not null default false;
alter table public.leads add column if not exists intent text;
alter table public.leads add column if not exists assigned_agent_id uuid references public.agents(id) on delete set null;
alter table public.leads add column if not exists assigned_at timestamptz;
alter table public.leads add column if not exists assigned_by text;
alter table public.leads add column if not exists first_contact_at timestamptz;
alter table public.leads add column if not exists status text not null default 'new';
alter table public.leads add column if not exists desk_note text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_status_check') then
    alter table public.leads add constraint leads_status_check check (status in ('new', 'assigned', 'contacted', 'booked', 'lost'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leads_intent_check') then
    alter table public.leads add constraint leads_intent_check check (intent is null or intent in ('callback', 'quote', 'info'));
  end if;
end $$;

-- The Today card, the System check and the 15 minute reminder all ask "which hot leads still have no agent, oldest first".
create index if not exists leads_hot_waiting_idx on public.leads (created_at) where hot and assigned_agent_id is null and status = 'new';
