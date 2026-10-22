-- Lead-source measurement: where a lead came from, beyond the UTM tags already stored.
-- Additive and idempotent: three nullable columns, nothing dropped or rewritten, existing rows stay NULL.
-- IMPORTANT: the app only writes these when the visitor accepted analytics on the cookie banner (the browser sends
-- the extra fields only then; see lib/attribution.ts getAttribution). Declined or no choice = these stay NULL.
-- referrer holds the referring HOST only (never a full URL), landing_path the first page path (no query string).
-- The app tolerates these columns not existing yet (lib/lead-touch.ts retries the insert without them), so deploy order is safe.
alter table leads add column if not exists referrer text;
alter table leads add column if not exists landing_path text;
alter table leads add column if not exists utm_term text;
