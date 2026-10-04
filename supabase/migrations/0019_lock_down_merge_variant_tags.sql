-- Security fix (self-caught via Supabase advisors, same session that shipped migration 0018):
-- Postgres grants EXECUTE on a new function to PUBLIC by default, so merge_variant_tags was
-- callable by the anon and authenticated roles directly via /rest/v1/rpc/merge_variant_tags -
-- anyone on the internet could write arbitrary content_variants rows for any slug, with no
-- isAuthorized() check at all. Unlike rate_limit_hit (migration 0002), which is DELIBERATELY
-- public because public lead-gen forms call it without a service-role key, this function is only
-- ever meant to be called from admin routes via getSupabaseAdmin() - same "service-role only" rule
-- as every other admin table in this project (app_settings, post_distribution, content_variants
-- itself). Revoking public execute; service_role keeps access regardless of table/function grants.
revoke execute on function public.merge_variant_tags(text, jsonb) from public;
revoke execute on function public.merge_variant_tags(text, jsonb) from anon;
revoke execute on function public.merge_variant_tags(text, jsonb) from authenticated;
