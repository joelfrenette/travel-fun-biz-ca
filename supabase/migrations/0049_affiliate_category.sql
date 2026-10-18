-- "Plan the extras for your trip" block on trip pages: each affiliate link can say what kind of thing it is.
-- Additive and idempotent. The column is nullable; existing rows stay null (not shown in the block).
-- Admin table: RLS stays as it is (service role only).
alter table affiliate_links add column if not exists category text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'affiliate_links_category_check') then
    alter table affiliate_links add constraint affiliate_links_category_check
      check (category is null or category in ('tours', 'transport', 'stays', 'luggage', 'connectivity', 'insurance', 'other'));
  end if;
end $$;
create index if not exists affiliate_links_category_idx on affiliate_links (category);
