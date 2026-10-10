-- Trip detail intake (growth loop WP11): an admin drops a screenshot, a PDF, a link or pasted text on a
-- package, the site extracts the details, and (only when a field is empty and the value is really in the
-- source) fills the trip page. One row per source. Admin only: RLS on, no policy, service role reads and
-- writes it through getSupabaseAdmin().
--
-- package_edits is the audit trail of every automatic or clicked change made from this source: an array of
-- {field, before, after, method, at, reverted}. "Revert" puts `before` back. (If a shared content_edits table
-- exists later, this column can be copied into it; it is kept here so deleting a source and reverting its
-- edits is one place.)
create table if not exists public.package_sources (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references public.travel_packages(id) on delete cascade,
  kind text not null check (kind in ('screenshot', 'pdf', 'url', 'text')),
  -- Path inside the PRIVATE storage bucket package-sources (never a public URL).
  storage_path text,
  -- Kept for the table shape in the brief; stays null because the bucket is private.
  public_url text,
  source_url text,
  file_name text,
  mime_type text,
  file_bytes integer,
  -- What the model could read (a verbatim transcript for a screenshot or PDF, the page text for a link,
  -- the pasted text for text). The only text any value is grounded against.
  extracted_text text,
  -- The grounded draft: {fields, evidence, missing, dropped, model} plus the saved copy proposals.
  extracted_fields jsonb,
  applied_fields text[] not null default '{}',
  package_edits jsonb not null default '[]'::jsonb,
  status text not null default 'uploaded' check (status in ('uploaded', 'extracted', 'applied', 'failed')),
  error text,
  model text,
  input_tokens integer,
  output_tokens integer,
  model_calls integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists package_sources_package_idx on public.package_sources (package_id, created_at desc);

comment on table public.package_sources is 'Screenshots, PDFs, links and pasted text an admin added to a trip, with what was extracted and every change applied from it. Service role only.';
comment on column public.package_sources.package_edits is 'Audit trail of changes applied from this source: [{field, before, after, method, at, reverted}].';

alter table public.package_sources enable row level security;
-- No policies on purpose: only the service role (admin API routes) may read or write this table.

-- Private bucket for the uploaded files. No storage policies: only the service role touches it, and the
-- admin preview uses a 60 second signed URL.
insert into storage.buckets (id, name, public) values ('package-sources', 'package-sources', false) on conflict do nothing;
