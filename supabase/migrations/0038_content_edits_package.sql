-- Self-healing for trip pages (growth loop wave 3). The daily heal-content step now also scores every published trip
-- (travel_packages) and fills in its EMPTY SEO fields: meta title and description, share picture, keywords, FAQ, and
-- one "Related" line of links at the end of the description. Every change is logged in content_edits like the other
-- pages, so it needs the two check constraints from 0033 widened:
--   content_type gains 'package'
--   field gains 'ai_faqs', 'keywords', 'alt_text', 'og_image'
-- ('alt_text' is allowed for later: trip pages draw their picture's alt text from the trip name today and have no alt
-- column, so the heal does not write it yet.)
--
-- Safe to run twice. Old rows are untouched and still satisfy the new, wider checks. No data is changed.

do $$
declare
  c record;
begin
  -- Drop whichever check constraints 0033 created (their generated names), found by what they test.
  for c in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.content_edits'::regclass
      and con.contype = 'c'
      and (pg_get_constraintdef(con.oid) like '%content_type%' or pg_get_constraintdef(con.oid) like '%(field)%' or pg_get_constraintdef(con.oid) like '%field = ANY%')
  loop
    execute format('alter table public.content_edits drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.content_edits
  add constraint content_edits_content_type_check
  check (content_type in ('post', 'guide', 'page_copy', 'package'));

alter table public.content_edits
  add constraint content_edits_field_check
  check (field in ('body', 'title', 'meta_title', 'meta_description', 'og_title', 'og_description', 'faq', 'key_takeaways', 'links', 'ai_faqs', 'keywords', 'alt_text', 'og_image'));
