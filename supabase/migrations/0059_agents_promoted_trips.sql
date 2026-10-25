-- Trips an agent is hosting or promoting, plus a short testimonial statement they supply.
--
-- promoted_package_slugs: slugs of travel_packages the agent picked in their profile link. The agent only PROPOSES; the office
-- approves the submission, and only then are the slugs copied here. The public agent page shows a slug only if that package
-- is published right now, so a stale or unpublished slug never renders.
--
-- testimonial_text: the agent's own short statement. Admin-only for now (not in the public column list); it is material the
-- office can reuse after reading it, not something that appears on the site by itself.
--
-- agents already has RLS on with no policies (migration 0054). Safe to run on a table with data: columns are added only if
-- missing, and everyone starts with no promoted trips and no testimonial.

alter table public.agents add column if not exists promoted_package_slugs text[] not null default '{}';
alter table public.agents add column if not exists testimonial_text text;
