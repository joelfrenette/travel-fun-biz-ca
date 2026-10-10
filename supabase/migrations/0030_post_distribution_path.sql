-- Growth loop WP7: a distribution row can refer to a page that is not a blog post (a published guide).
-- post_distribution already has a NOT NULL title column (migration 0011), so a guide row stores its name there;
-- the only new column is path. It is nullable with no default, so every existing row keeps working unchanged
-- (path is null for a blog post). The primary key stays (content_type, slug); a guide row keeps content_type
-- 'post' and uses slug 'guide-<kind>-<slug>', so every existing query, retry and ledger count treats it like a post.
alter table public.post_distribution add column if not exists path text;

comment on column public.post_distribution.path is 'When set, the row refers to a page that is not a blog post (a guide), for example /resorts/some-resort; title holds the guide name. slug stays the primary key and for guides is guide-<kind>-<slug>. Null for blog posts.';
