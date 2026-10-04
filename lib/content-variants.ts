import type { SupabaseClient } from '@supabase/supabase-js'

// Factory item 6/6: A/B testing logging foundation (see migration 0017 for why this is a log, not
// a comparison feature - there's no real engagement data yet to compare variants against). Call
// this from wherever a content-generation choice is already made, to tag it against the post's
// slug. Merges into whatever's already tagged for that slug rather than overwriting, since a post
// can get a cover image, a video script, and a carousel at different times - the merge happens
// atomically inside the database (migration 0018's merge_variant_tags RPC) rather than as a
// select-then-upsert here, so two tags written close together for the same slug can't race and
// silently drop one of them. Never throws - a tagging failure must never block the generation step
// that's actually doing the work.
export async function tagVariant(admin: SupabaseClient, slug: string, patch: Record<string, unknown>): Promise<void> {
  try {
    const { error } = await admin.rpc('merge_variant_tags', { p_slug: slug, p_patch: patch })
    if (error) throw new Error(error.message)
  } catch (err) {
    console.error('[content-variants] tag failed:', err instanceof Error ? err.message : err)
  }
}
