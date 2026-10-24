-- GA4 client id on the lead: the anonymous Google Analytics visitor id (two numbers joined by a dot), saved ONLY when the
-- visitor accepted analytics on the cookie banner. It lets the server send a Measurement Protocol generate_lead that GA4
-- ties to the same visitor (lib/ga4-mp.ts), and lets the admin see whether a lead can be tied back to analytics.
--
-- PRIVACY: leads already has RLS on with no policies (service role only); this column inherits that. The admin Leads
-- page shows only whether the id is present (yes or no), never the value.
--
-- Safe to run on a table with data: the column is added only if missing and is nullable. The code works before this is
-- applied (the update fails quietly and the server-side event is still sent).

alter table public.leads add column if not exists ga_client_id text;
