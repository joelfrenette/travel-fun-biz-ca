-- Ties an add-a-trip link (agent_invites) to a person on the agents roster.
--
-- Until now a trip link knew its agent only by name and email. With agent_id set, a trip that agent sends and the office
-- approves is added to that agent's promoted_package_slugs (migration 0059), so it shows on their public page. Leads from that
-- page still go through the website to the Lead desk first; nothing here assigns a lead.
--
-- Nullable and on delete set null: old links keep working exactly as before, and removing a roster agent never removes a link.
-- agent_invites already has RLS on with no policy (migration 0036). Safe to run on a table with data.

alter table public.agent_invites add column if not exists agent_id uuid references public.agents(id) on delete set null;
create index if not exists agent_invites_agent_idx on public.agent_invites (agent_id) where agent_id is not null;
