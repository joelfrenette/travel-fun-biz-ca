-- Factory item 5/6 (content-pipeline hardening): the "accepted but not confirmed" async-post
-- state (lib/distribution.ts's needsReview branch, held with "has not confirmed it posted yet")
-- had no way to ever be resolved later - uploadPostGetStatus (lib/upload-post.ts) needs a
-- request_id or job_id to poll, and nothing persisted either one. These two columns' shape is
-- CONFIRMED by a real Upload-Post call (lib/upload-post.ts's own comments: "confirmed by live
-- calls, Nomad 2026-09-20/21") - not guessed, unlike the video_url/render_id columns this table's
-- original migration (0011) deliberately left out for exactly that reason.
--
-- Still NOT added here: any real engagement-metrics column (likes/shares/saves/reach). No
-- confirmed Upload-Post endpoint for that exists anywhere in this codebase's history - adding a
-- column for an unconfirmed shape would repeat the exact mistake 0011 avoided. If Upload-Post
-- genuinely offers engagement data, confirm the real shape with a live call first, then add it.
alter table public.post_distribution
  add column if not exists provider_request_id text,
  add column if not exists provider_job_id text;

comment on column public.post_distribution.provider_request_id is 'Upload-Post request_id for an async/scheduled send, so a later sync can resolve it via uploadPostGetStatus. Null for a send that completed synchronously or hasn''t been attempted yet.';
comment on column public.post_distribution.provider_job_id is 'Upload-Post job_id for a scheduled send - same purpose as provider_request_id, different field name for a different accepted-state shape (see lib/upload-post.ts settleUploadPostSend).';
