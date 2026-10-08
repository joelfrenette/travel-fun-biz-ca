alter table post_distribution add column if not exists sent_platforms text[] not null default '{}';
