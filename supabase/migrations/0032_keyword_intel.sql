-- WP9: the keyword intelligence engine (lib/keyword-intel.ts). Every column is nullable and additive, so
-- existing rows and the live autoblog keep working before and after this is applied. The engine reports
-- "run migration 0032" in Needs attention until it is applied, and spends nothing until then.

-- Research rows: the engine's verdict on each phrase, rewritten on every engine run.
alter table public.keyword_research
  add column if not exists cluster_id text,
  add column if not exists intent text,
  add column if not exists opportunity text,
  add column if not exists score integer,
  add column if not exists score_reasons text[],
  add column if not exists engine_updated_at timestamptz;

comment on column public.keyword_research.cluster_id is 'Stable id of the topic this phrase belongs to (slug of the topic''s primary phrase). Near-duplicate phrases share one id.';
comment on column public.keyword_research.intent is 'informational | commercial | transactional, worked out from the words of the phrase.';
comment on column public.keyword_research.opportunity is 'RANKING (Google position 1-10) | ALMOST (11-30) | SHOOT_FOR (usable, not targeted, scores well) | TARGETED (has a page, not ranking yet) | SKIP (not our trips, covered, or skipped).';
comment on column public.keyword_research.score is 'Blog-topic score 0-100 from lib/keyword-score.ts (winnability, demand, intent, timing) at the last engine run.';
comment on column public.keyword_research.score_reasons is 'Plain-English reasons behind the score or the SKIP verdict, shown on the Keyword Research page.';
comment on column public.keyword_research.engine_updated_at is 'When the engine last wrote the five columns above. Null means the engine has not seen this row yet.';

-- Blog topic queue: a next blog idea carries the whole keyword set the post is shooting for.
alter table public.blog_topic_queue
  add column if not exists keywords text[],
  add column if not exists cluster_id text,
  add column if not exists title_idea text,
  add column if not exists score integer;

comment on column public.blog_topic_queue.keywords is 'The keyword set for the post: the first entry is the primary keyword (same as keyword), the rest are secondary phrases from the same topic. Null on older rows, meaning just the keyword column.';
comment on column public.blog_topic_queue.cluster_id is 'The keyword_research cluster_id this idea was made from, used to stop the engine proposing the same topic twice.';
comment on column public.blog_topic_queue.title_idea is 'Working title proposed by the engine (the writer may still choose a different final title).';
comment on column public.blog_topic_queue.score is 'Topic score 0-100 when the idea was made.';

create index if not exists blog_topic_queue_cluster_idx on public.blog_topic_queue (cluster_id) where cluster_id is not null;
create index if not exists keyword_research_cluster_idx on public.keyword_research (cluster_id) where cluster_id is not null;
