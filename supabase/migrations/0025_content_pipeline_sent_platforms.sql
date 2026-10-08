alter table content_pipeline add column if not exists carousel_sent text[] not null default '{}', add column if not exists video_sent text[] not null default '{}';
