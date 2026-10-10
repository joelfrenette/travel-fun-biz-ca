-- Growth loop WP1: blog posts written for SEO + GEO + AEO. Every column is nullable, so every
-- existing post keeps working exactly as it does today (the page simply skips what is empty).
alter table public.posts
  add column if not exists content_style text,
  add column if not exists faq jsonb,
  add column if not exists key_takeaways text[],
  add column if not exists og_title text,
  add column if not exists og_description text,
  add column if not exists primary_keyword text,
  add column if not exists secondary_keywords text[];

comment on column public.posts.content_style is 'Which writing style the post used: listicle, how-to, comparison, faq-led, story-guide, myth-buster or checklist. Null for posts written before styles existed.';
comment on column public.posts.faq is 'Array of {q, a} pairs shown at the end of the post and emitted as FAQPage JSON-LD. Null or empty means no FAQ block.';
comment on column public.posts.key_takeaways is 'Three to five one-line takeaways shown in a box under the hero image. Null or empty means no box.';
comment on column public.posts.og_title is 'Social share title (under 60 characters). Null means the page falls back to meta_title.';
comment on column public.posts.og_description is 'Social share description (under 110 characters). Null means the page falls back to meta_description.';
comment on column public.posts.primary_keyword is 'The one search phrase this post is written to rank for.';
comment on column public.posts.secondary_keywords is 'Supporting search phrases (three to six), used for the Article keywords field.';
