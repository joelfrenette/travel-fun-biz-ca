import type { SupabaseClient } from '@supabase/supabase-js'

// Factory item 6/6: A/B testing logging foundation (see migration 0017 for why this is a log, not
// a comparison feature - there's no real engagement data yet to compare variants against). Call
// this from wherever a content-generation choice is already made, to tag it against the post's
// slug. Merges into whatever's already tagged for that slug rather than overwriting, since a post
// can get a cover image, a video script, and a carousel at different times. Never throws - a
// tagging failure must never block the generation step that's actually doing the work.
export async function tagVariant(admin: SupabaseClient, slug: string, patch: Record<string, unknown>): Promise<void> {
  try {
    const { data } = await admin.from('content_variants').select('variant_tags').eq('slug', slug).maybeSingle()
    const merged = { ...(data?.variant_tags ?? {}), ...patch }
    await admin.from('content_variants').upsert({ slug, variant_tags: merged, updated_at: new Date().toISOString() })
  } catch (err) {
    console.error('[content-variants] tag failed:', err instanceof Error ? err.message : err)
  }
}
