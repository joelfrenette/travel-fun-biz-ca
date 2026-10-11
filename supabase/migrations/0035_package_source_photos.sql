-- Supplier photos for trip pages (growth loop WP12): the photos found on a link source's page.
-- Written by lib/package-extract.ts + lib/supplier-photos.ts when an admin reads a link source. Each entry is
-- {url, width, height, origin} (a public address on the supplier's own site; nothing is downloaded at this point).
-- Up to 6 are then copied into our storage and added to the trip's gallery automatically; the rest stay here for
-- the admin's "Add more" picker. The edits themselves (and their Revert) live in package_edits (migration 0034).
--
-- Nullable on purpose: screenshot, PDF and text sources never have photos, and rows from before this migration
-- have none. Admin table: the existing RLS (on, no policy) already covers the new column.
alter table public.package_sources add column if not exists photo_candidates jsonb;

comment on column public.package_sources.photo_candidates is 'Photos found on a link source page: [{url, width, height, origin}], at most 12. Public supplier addresses, never downloaded until chosen or auto-picked.';
