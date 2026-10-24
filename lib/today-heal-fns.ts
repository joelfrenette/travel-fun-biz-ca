import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { policyGate } from '@/lib/auto-decisions'
import { runRetryFailedPosts } from '@/lib/auto-policies'
import { resolveIssue } from '@/lib/issues'
import { editsLoggable } from '@/lib/content-edits'
import { getGuideCaps, getGuidePublishMode, isGuessedPropertyNote } from '@/lib/guide-run'
import { checkCadence, guideLimits } from '@/lib/publish-cadence'
import { openBudget } from '@/lib/heal-loop'
import { healGuideRow } from '@/lib/heal-drafts'
import { pingIndexNow } from '@/lib/indexnow'
import { loadView } from '@/lib/seo-playbook-view'
import { TODAY_HEAL_KEY } from '@/lib/today-card-actions'
import { runCardHeal, type HealStore, type Healer, type HealOutcome } from '@/lib/today-heal'

// The real repairs behind a Today card's Auto-heal button. Each one calls an EXISTING function that already checks the kill
// switch, its own on/off switch and its own daily cap, applies its own quality gates, and logs what it did so Undo works.
// No new autonomy: a press here is a person asking for one card's turn of what the site does by itself every day.

const NOT_THIS = 'not this card'

/** The existing retry policy (lib/auto-policies.ts), limited to ONE card: every other row is passed over without being touched. */
function retryHealer(admin: SupabaseClient, which: 'post' | 'render'): Healer {
  return async (key, { now }) => {
    const gate = await policyGate(admin, 'retry_failed_posts', now)
    if (!gate.allowed) return { state: 'skipped', message: `Skipped: ${gate.reason}.` }
    let queued = false
    const r = await runRetryFailedPosts(admin, now, {
      retryPost: async (slug) => {
        if (which !== 'post' || slug !== key) return NOT_THIS
        const err = await resolveIssue(admin, 'retry-post', slug)
        if (!err) queued = true
        return err
      },
      retryStep: async (part, slug) => {
        if (which !== 'render' || `${part}:${slug}` !== key) return NOT_THIS
        const err = await resolveIssue(admin, part === 'video' ? 'retry-video' : 'retry-carousel', slug)
        if (!err) queued = true
        return err
      },
    })
    if (queued) return { state: 'fixed', message: which === 'post' ? 'Queued the post to try again. It goes out on the next posting pass.' : 'Queued the carousel or video to be made again.' }
    return {
      state: 'unchanged',
      message: `Tried and changed nothing. The retry rules wait between tries and only retry posts when posting is on Auto${r.note ? ` (${r.note})` : ''}. Use Try again to force it.`,
    }
  }
}

/** The held-guide heal (lib/heal-drafts.ts) for ONE guide: same publish-mode, kill switch, heal call budget, publishing-slot and once-a-day rules as the daily run. */
function guideHealer(admin: SupabaseClient): Healer {
  return async (key, { now }) => {
    if ((await getGuidePublishMode(admin)) !== 'publish') return { state: 'skipped', message: 'Skipped: guides are not in publish mode, so held guides are not re-checked.' }
    if (!(await editsLoggable(admin))) return { state: 'skipped', message: 'Skipped: the edit log is not ready (apply migration 0033), so Undo would not work.' }
    const { data, error } = await admin.from('guides').select('*').eq('id', key).maybeSingle()
    if (error) return { state: 'failed', message: `Could not read the guide (${error.message}).` }
    const row = data as Record<string, unknown> | null
    if (!row) return { state: 'unchanged', message: 'That guide is gone.' }
    if (row.status !== 'draft' || row.source !== 'ai') return { state: 'unchanged', message: 'That guide is no longer a held AI draft, so there is nothing to repair.' }
    const budget = await openBudget(admin, now)
    if (!budget.readable || budget.remaining() <= 0) return { state: 'skipped', message: `Skipped: ${budget.reason ?? "today's heal call budget is used up"}.` }
    if (!isGuessedPropertyNote(typeof row.quality_notes === 'string' ? row.quality_notes : '')) {
      const slot = await checkCadence(admin, 'guide', guideLimits(await getGuideCaps(admin)), now)
      if (!slot.allowed) return { state: 'skipped', message: `Skipped: no publishing slot is free (${slot.note}).` }
    }
    const r = await healGuideRow(admin, row, { now, budget })
    if (r.action === 'published' && !r.ladder.includes('safe-page')) await pingIndexNow([r.path, '/sitemap.xml']).catch(() => undefined)
    switch (r.action) {
      case 'published':
        return { state: 'fixed', message: 'Repaired, passed the quality checks and published.' }
      case 'healed_draft':
      case 'healed_live':
        return { state: 'fixed', message: 'Repaired and saved. It passed the checks but stays a draft for your yes.' }
      case 'skipped':
        return { state: 'skipped', message: `Skipped: ${r.note || 'already tried today'}.` }
      case 'failed':
        return { state: 'failed', message: `The repair failed: ${r.note || 'unknown error'}.` }
      default:
        return { state: 'unchanged', message: `Tried and changed nothing: ${r.note || 'the quality checks still fail'}.` }
    }
  }
}

/** Re-runs the SEO audit and looks at this one item. Read only. */
function seoHealer(admin: SupabaseClient): Healer {
  return async (key) => {
    const view = await loadView(admin)
    const item = view.items.find((i) => i.id === key)
    if (!item) return { state: 'unchanged', message: 'That audit item is no longer on the list.' }
    if (item.status === 'pass') return { state: 'fixed', message: 'Re-checked: this item passes now. The card goes away on the next refresh.' }
    return { state: 'unchanged', message: `Re-checked: still ${item.status === 'fail' ? 'failing' : item.status}. ${item.fixHint || 'Open the fix to change it.'}`.trim() }
  }
}

export function realHealers(admin: SupabaseClient): Record<string, Healer> {
  return {
    'retry-failed-post': retryHealer(admin, 'post'),
    'retry-failed-render': retryHealer(admin, 'render'),
    'heal-guide-draft': guideHealer(admin),
    'recheck-seo-item': seoHealer(admin),
  }
}

/** Production wiring for POST /api/admin/today/heal. */
export async function healTodayCard(admin: SupabaseClient, id: unknown): Promise<HealOutcome> {
  const store: HealStore = {
    read: () => getSetting(admin, TODAY_HEAL_KEY),
    write: async (value) => {
      await setSetting(admin, TODAY_HEAL_KEY, value)
    },
  }
  return runCardHeal(id, { now: new Date(), store, isPaused: () => isAutomationPaused(admin), healers: realHealers(admin) })
}
