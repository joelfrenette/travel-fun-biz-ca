-- Guide photo loop: the daily heal (and scripts/heal-guide-photos.ts) can replace a guide's hero photo when it is missing, tiny, a wrong
-- subject or the same picture as another page. The change is logged in content_edits like every other automatic edit (fields
-- 'hero_image_url' and 'hero_alt', before and after) so the Content edits page can Undo it.
-- This only widens the field check from 0043. Until it is applied the photo loop changes nothing (it cannot log), and says so.
-- Safe to run twice. No data is changed.

do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.content_edits'::regclass
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%''meta_title''%'
  loop
    execute format('alter table public.content_edits drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.content_edits
  add constraint content_edits_field_check
  check (field in ('body', 'title', 'meta_title', 'meta_description', 'og_title', 'og_description', 'faq', 'key_takeaways', 'links', 'ai_faqs', 'keywords', 'alt_text', 'og_image', 'status', 'hero_image_url', 'hero_alt'));
