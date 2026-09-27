-- Past-Trip Recaps (e6): dated traveler updates on a trip ("where we went, what happened") that
-- read like a journal, instead of only the single full_description block. Same pattern as
-- ai_faqs: a jsonb array on the package row rather than a new table, since entries only ever
-- belong to one package and the admin edits them as a unit alongside everything else on that
-- package's form.
alter table public.travel_packages
  add column if not exists journal_entries jsonb not null default '[]'::jsonb;

comment on column public.travel_packages.journal_entries is
  'Array of {date: "YYYY-MM-DD", title: string, body: string}, admin-entered, sorted by date on display. Empty array means no journal for this trip.';
