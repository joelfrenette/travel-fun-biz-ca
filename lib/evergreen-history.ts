import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { CAPTION_LOG_KEY, parseCaptionLog } from '@/lib/caption-plan'
import { guideFromPath } from '@/lib/guide-post-source'
import { isNewsSlug } from '@/lib/news-post'
import { EVERGREEN_STATE_KEY, earlierHooksFor, getEvergreenEnabled, parseEvergreenState, stylesUsedBefore, withShared } from '@/lib/evergreen-reshare'

// The I/O the posting pass (lib/distribution.ts) needs for an evergreen re-share row: what hooks and styles this page already used, a last look
// at whether it may still be shared, and writing down the hook lines a re-share used. Kept apart from lib/evergreen-reshare-run.ts (which reads
// lib/distribution.ts) so the posting pass can import it without a circle. Nothing here sends anything.

export interface EvergreenHistory {
  /** Normalised first lines of every caption already used for this page. */
  earlierHooks: string[]
  /** Hook styles already used for this page. */
  usedStyles: Set<string>
}

/** What this page already said. A caption log that cannot be read is an empty history (the caller still compares against the no-AI hook). Never throws. */
export async function loadEvergreenHistory(admin: SupabaseClient, baseSlug: string): Promise<EvergreenHistory> {
  try {
    const [logRaw, stateRaw, variants] = await Promise.all([
      getSetting(admin, CAPTION_LOG_KEY),
      getSetting(admin, EVERGREEN_STATE_KEY),
      admin.from('content_variants').select('variant_tags').eq('slug', baseSlug).maybeSingle(),
    ])
    const log = parseCaptionLog(logRaw)
    const entry = parseEvergreenState(stateRaw).shared.find((e) => e.slug === baseSlug)
    const tags = (variants.data as { variant_tags?: Record<string, unknown> | null } | null)?.variant_tags ?? null
    return { earlierHooks: earlierHooksFor(baseSlug, log, entry), usedStyles: stylesUsedBefore(baseSlug, log, tags) }
  } catch {
    return { earlierHooks: [], usedStyles: new Set() }
  }
}

/** Writes down the first lines a re-share used (newest first, bounded) in the state. Best effort: a failed write is only a missing line. */
export async function recordEvergreenHooks(admin: SupabaseClient, baseSlug: string, captions: readonly string[], now: Date = new Date()): Promise<void> {
  try {
    const lines = captions.map((c) => (c ?? '').split('\n').find((l) => l.trim())?.trim() ?? '').filter(Boolean).map((l) => l.slice(0, 160))
    if (!lines.length) return
    const state = parseEvergreenState(await getSetting(admin, EVERGREEN_STATE_KEY))
    await setSetting(admin, EVERGREEN_STATE_KEY, JSON.stringify(withShared(state, baseSlug, now, lines)))
  } catch {
    // the post already went out; only the remembered hook line is missing (the caption log still has it)
  }
}

/** A last look just before an evergreen row is sent: why it must NOT go out now, or null when it may. Throws on a read error (the row is then retried
 * like any other failure). The deeper checks (age, quality bar, cooldown) were made when the row was enrolled. */
export async function evergreenSendBlocker(admin: SupabaseClient, baseSlug: string, path: string | null): Promise<string | null> {
  if (!(await getEvergreenEnabled(admin))) return 'the evergreen re-share switch is off'
  if (path) {
    const ref = guideFromPath(path)
    if (!ref) return 'not a guide address'
    const { data, error } = await admin.from('guides').select('status, quality_notes').eq('kind', ref.kind).eq('slug', ref.slug).maybeSingle()
    if (error) throw new Error(`guides: ${error.message}`)
    const g = data as { status: string; quality_notes: string | null } | null
    if (!g || g.status !== 'published') return 'the guide is no longer published'
    if (g.quality_notes && g.quality_notes.trim()) return 'the guide is now a safe page or held by the quality gate'
    return null
  }
  if (isNewsSlug(baseSlug)) return 'travel news is not posted to social'
  const { data, error } = await admin.from('posts').select('status, tags').eq('slug', baseSlug).maybeSingle()
  if (error) throw new Error(`posts: ${error.message}`)
  const p = data as { status: string; tags: unknown } | null
  if (!p || p.status !== 'published') return 'the post is no longer published'
  if (Array.isArray(p.tags) && p.tags.some((t) => typeof t === 'string' && t.toLowerCase() === 'travel-news')) return 'travel news is not posted to social'
  return null
}

