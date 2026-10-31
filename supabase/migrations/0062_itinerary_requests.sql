-- "Send me the itinerary and dates" (trip page lead magnet, lib/itinerary-magnet.ts): a request is saved as a normal lead with
-- intent = 'itinerary'. The lead desk migration (0055) limited intent to callback, quote and info, so the check is widened here.
--
-- Apply this BEFORE switching the feature on (app_settings itinerary_magnet_mode = 'on'). Without it the lead is still saved and
-- still readable as an itinerary request (its message starts with "[Itinerary requested]"), but the intent column update is
-- refused by the old check.
--
-- No new table: the per trip request counter is the app_settings key itinerary_requests (JSON), shown on System health.
-- Safe to run twice and safe on a table with data: existing rows already satisfy the wider check.

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'leads_intent_check') then
    alter table public.leads drop constraint leads_intent_check;
  end if;
  alter table public.leads add constraint leads_intent_check check (intent is null or intent in ('callback', 'quote', 'info', 'itinerary'));
end $$;
