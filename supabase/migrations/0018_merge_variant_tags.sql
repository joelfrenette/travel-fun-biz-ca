-- content_variants.variant_tags was being merged client-side (select, merge in JS, upsert) in
-- lib/content-variants.ts, which races: two tags written close together for the same slug (e.g.
-- a cover image and a video script generated back to back) can lose one write if the slower
-- upsert's local merge was built from stale data. An atomic jsonb merge inside the database closes
-- that window entirely - same security-definer pattern as rate_limit_hit() (migration 0002).
create function public.merge_variant_tags(p_slug text, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.content_variants (slug, variant_tags, updated_at)
  values (p_slug, p_patch, now())
  on conflict (slug) do update
    set variant_tags = public.content_variants.variant_tags || p_patch,
        updated_at = now();
end;
$$;

comment on function public.merge_variant_tags is 'Factory item 6/6: atomically merges p_patch into content_variants.variant_tags for p_slug, creating the row if needed. See lib/content-variants.ts tagVariant().';
