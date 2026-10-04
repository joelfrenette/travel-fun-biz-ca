-- Closes the one real gap in roadmap_usecases_bd08f3d4 ("backlog + sprint board, Gantt, cost
-- estimate per use case") - the board (admin/tracker's "board" view) and Gantt (its "roadmap"
-- view, epic-level week bars) already existed before this; only a per-use-case cost estimate was
-- missing. size_estimate is a rough t-shirt size, not a token-usage lookup - there's no real
-- historical per-use-case token ledger to derive one from (RTK's own savings data is tracked per
-- command type, not per roadmap item). The $ estimate itself is computed in the UI from this
-- column via a stated day-range x day-rate formula, not stored, so the rate can change without a
-- migration.
alter table roadmap_usecases add column size_estimate text check (size_estimate in ('S', 'M', 'L'));

comment on column roadmap_usecases.size_estimate is 'Rough t-shirt size (S=half day, M=1-2 days, L=3-5 days) for the Project Tracker''s cost-estimate column. Admin-set, not auto-computed from history.';
