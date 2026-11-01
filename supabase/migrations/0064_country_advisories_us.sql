-- Travel advisories: the US Department of State as a third source (us_ columns), next to Canada (ca_) and the UK (uk_).
-- Additive and safe to run twice. NOT applied by the code that ships it: run it in the Supabase SQL editor, and run it BEFORE the
-- deploy that reads these columns (the code falls back to the old columns while they are missing, but US data cannot be stored).
--
-- What is stored: the State Department's own level wording as its feed titles it (for example "Level 3: Reconsider Travel"), the
-- lead-in sentence of its advisory word for word, the official travel.state.gov link, the official date and when we last saw it.
-- Nothing is estimated, converted to a score or combined with the other sources. Every column may be null.
-- The log table needs no change: country_advisory_log.source_key already carries the source ('us-state-dept').

alter table public.country_advisories add column if not exists us_level text;
alter table public.country_advisories add column if not exists us_text text;
alter table public.country_advisories add column if not exists us_source_url text;
alter table public.country_advisories add column if not exists us_source_published_at timestamptz;
alter table public.country_advisories add column if not exists us_checked_at timestamptz;

comment on column public.country_advisories.us_level is 'US Department of State level wording exactly as its feed titles it (for example "Level 3: Reconsider Travel"). Never converted or scored.';
comment on column public.country_advisories.us_text is 'The lead-in sentence of the State Department advisory, word for word. Null when it was missing or too long to quote whole.';
comment on column public.country_advisories.us_source_url is 'Official travel.state.gov advisory page. Only travel.state.gov links are stored.';
