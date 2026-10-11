-- 0040: "call or text for pricing" state for a trip (additive, WP13 UAT fix).
-- A trip whose source says to call, text or contact for pricing is marked price_on_request instead of getting an
-- invented number or a blank price. The public card and trip page then show "Call or text <our number> for pricing"
-- (number from lib/site.ts). Written but NOT applied: apply it before merging the code that writes this column.
-- Default false and nullable-safe: every existing row keeps showing its price exactly as before.

alter table public.travel_packages
  add column if not exists price_on_request boolean not null default false;

comment on column public.travel_packages.price_on_request is
  'True when the price is given on request (call or text). Only set from a source that says so; never inferred.';
