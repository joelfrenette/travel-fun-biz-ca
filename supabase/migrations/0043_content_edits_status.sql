-- Growth loop WP18-C: the daily heal re-checks blog drafts the quality gate held back and publishes the ones that
-- now pass. Publishing is logged in content_edits like every other automatic edit (field 'status', before 'draft',
-- after 'published') so the Content edits page can Undo it (Undo puts the post back to a draft).
-- This only widens the field check from 0033 / 0038. Until it is applied the heal repairs the text but does NOT
-- publish (it cannot log the publish), and says so in its note.
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
  check (field in ('body', 'title', 'meta_title', 'meta_description', 'og_title', 'og_description', 'faq', 'key_takeaways', 'links', 'ai_faqs', 'keywords', 'alt_text', 'og_image', 'status'));
