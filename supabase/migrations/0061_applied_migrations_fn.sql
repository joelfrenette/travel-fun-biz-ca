-- The System check compares the repo's migration files with what the database has applied. The
-- supabase_migrations schema is not exposed to the API, so that read always failed ("could not be read").
-- This function hands the same two columns to the service role only (never anon or signed-in users).
create or replace function public.applied_migrations()
returns table (version text, name text)
language sql
security definer
set search_path = ''
as $$
  select m.version::text, coalesce(m.name, '')::text
  from supabase_migrations.schema_migrations m
$$;

revoke all on function public.applied_migrations() from public, anon, authenticated;
grant execute on function public.applied_migrations() to service_role;
