-- Backlog grooming (2026-09-28): Joel's priority scale is P0 (immediate) through P3 (keep
-- pushing out / maybe never). The original check constraint only allowed P1-P3; add P0 as the
-- new top tier without renumbering anything that already has a priority.
alter table public.roadmap_usecases drop constraint if exists roadmap_usecases_priority_check;
alter table public.roadmap_usecases add constraint roadmap_usecases_priority_check
  check (priority = any (array['P0', 'P1', 'P2', 'P3']));
