-- Factory Phase 2: blog/autoblog. AI-suggested topic ideas, admin-approved before the composer
-- ever touches them (queue only; no-approval-gates in the content pipeline still applies to
-- publishing itself, per PARITY-SPEC owner rules - this queue is the topic backlog, not a gate).
create table if not exists blog_topic_queue (
  id uuid primary key default gen_random_uuid(),
  angle text not null,
  keyword text not null,
  why text not null default '',
  source text not null default '',
  status text not null default 'suggested' check (status in ('suggested', 'approved', 'used', 'rejected')),
  scheduled_for date,
  used_slug text,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- Same keyword can't sit in the live queue twice; a used/rejected keyword can be re-suggested later.
create unique index if not exists blog_topic_queue_keyword_live_idx
  on blog_topic_queue (lower(keyword))
  where status in ('suggested', 'approved');

create index if not exists blog_topic_queue_due_idx
  on blog_topic_queue (status, scheduled_for, created_at);

alter table blog_topic_queue enable row level security;
-- No policies: service-role only, same pattern as every other admin table in this project.
