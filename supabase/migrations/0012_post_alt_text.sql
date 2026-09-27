-- Autoblog & Social Pipeline (e8/f8-1): autoblog never attached a cover image at all, and posts
-- had nowhere to store real alt text for one (the public pages fell back to the post title, which
-- describes the post, not the photo). This column holds a description of the actual image.
alter table public.posts
  add column if not exists alt_text text;

comment on column public.posts.alt_text is 'Accessibility/SEO description of cover_image_url. Null means describe-by-title (the old behavior), not "no image".';
