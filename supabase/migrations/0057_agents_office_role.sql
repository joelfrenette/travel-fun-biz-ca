-- Office role on the agents roster: which roster person is the CEO, the CTO or the Manager of the agency.
--
-- One person = one agents row. Someone who is the CEO is still an agent and can be given leads like any agent, so this is a
-- single optional column, not a second table. Nothing here creates, renames or tags anyone: the owner adds the people and
-- sets the roles in the Agents admin screen (or with a "role" column in the spreadsheet import).
--
-- PRIVACY: the role is admin only. agents already has RLS on with no policies (migration 0054), so nothing here is readable with
-- the anon key, and public code selects an explicit column list that does not include this column.
--
-- At most one person per role: the partial unique index below. Moving a role is done in the admin screen (it clears the old
-- holder first, then sets the new one).
--
-- Safe to run on a table with data: the column is added only if missing and defaults to null (nobody holds a role).

alter table public.agents add column if not exists office_role text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agents_office_role_check') then
    alter table public.agents add constraint agents_office_role_check check (office_role is null or office_role in ('ceo', 'cto', 'mgr'));
  end if;
end $$;

create unique index if not exists agents_office_role_uidx on public.agents (office_role) where office_role is not null;
