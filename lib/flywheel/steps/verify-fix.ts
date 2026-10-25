import { revalidatePath } from 'next/cache'
import type { SupabaseClient } from '@supabase/supabase-js'
import { revalidateBlog } from '@/lib/blog-revalidate'
import { pingIndexNow } from '@/lib/indexnow'
import { boundFixState, parseFixState, readVerifyState, remediationTargets, VERIFY_FIX_STATE_KEY, type FixState } from '@/lib/publish-verify'
import { isVetoed, logDecision, readSetting, writeSetting } from '@/lib/flywheel/ctx'
import type { FlywheelContext, FlywheelResult, FlywheelStep } from '@/lib/flywheel/types'

// WP6: Publish-verify remediation. When the post-publish check (lib/publish-verify.ts) has seen a live page fail, this step does the two safe,
// harmless things that cure a cache problem: it drops the cached copy of that page (and the sitemap) and pings IndexNow once. The next verify
// pass looks at the page again; if it still fails, the existing Needs attention item stays. One page is refreshed at most twice, and a second
// time only after a re-check happened in between.
// It never edits, unpublishes or deletes content, never touches a draft (the verify only watches pages that are live), and messages nobody.
// The refresh itself cannot be taken back (a cache refill is not a change to undo), so the Undo on the decision line means "do not auto-refresh
// this page again" (the Undo route adds it to the veto list, which this step honours).

/** At most this many pages are refreshed in one pass (the daily cap in the registry is the other limit). */
export const VERIFY_FIX_PER_PASS = 3
/** Leave the rest for the next pass when less than this is left of the pass time. */
const MIN_LEFT_MS = 4_000

export interface VerifyFixDeps {
  /** Drops the cached copy of a page and the sitemap. Returns false when it could not. */
  revalidate: (path: string) => boolean
  /** Pings IndexNow for one path. Never throws. */
  ping: (path: string) => Promise<{ ok: boolean; skipped?: string }>
}

export const realDeps: VerifyFixDeps = {
  revalidate(path) {
    try {
      if (path.startsWith('/blog/')) revalidateBlog([path.slice('/blog/'.length)])
      else {
        revalidatePath(path)
        revalidatePath('/sitemap.xml')
      }
      return true
    } catch {
      return false
    }
  },
  async ping(path) {
    const r = await pingIndexNow([path])
    return { ok: r.ok, ...(r.skipped ? { skipped: r.skipped } : {}) }
  },
}

/** The work, with its collaborators passed in so the offline check can fake them. Never throws. */
export async function runVerifyFix(ctx: FlywheelContext, deps: VerifyFixDeps = realDeps): Promise<FlywheelResult> {
  if (ctx.dryRun) return { ran: false, reason: 'dry run: nothing is refreshed' }
  if (ctx.room <= 0) return { ran: false, reason: 'the daily cap is used up' }
  const admin: SupabaseClient = ctx.admin
  const state = await readVerifyState(admin)
  if (!state) return { ran: false, reason: 'could not read the publish check state' }
  const fixes: FixState = parseFixState(await readSetting(admin, VERIFY_FIX_STATE_KEY, ''))
  const targets = remediationTargets(state, fixes, ctx.now.getTime(), Math.min(ctx.room, VERIFY_FIX_PER_PASS))
  if (targets.length === 0) return { ran: false, reason: 'no failing page is waiting for a refresh' }

  const done: string[] = []
  let errors = 0
  let pinged = 0
  for (const t of targets) {
    if (ctx.remainingMs() < MIN_LEFT_MS) break
    try {
      if (await isVetoed(admin, 'verify_fix', t.path)) continue
      if (!deps.revalidate(t.path)) {
        errors++
        continue
      }
      let pingNote = 'search engines were not pinged (IndexNow is not set up)'
      try {
        const p = await deps.ping(t.path)
        if (p.ok) {
          pinged++
          pingNote = 'IndexNow was pinged once'
        } else if (!p.skipped) pingNote = 'the IndexNow ping did not go through'
      } catch {
        pingNote = 'the IndexNow ping did not go through'
      }
      fixes[t.path] = { n: (fixes[t.path]?.n ?? 0) + 1, at: ctx.now.toISOString() }
      done.push(t.path)
      const why = (t.reasons ?? []).slice(0, 2).join('; ')
      await logDecision(admin, 'verify_fix', t.path, 'Refreshed the cached copy of a page that failed the publish check', `${why || 'the page did not pass the check'}. ${pingNote}. It is checked again on the next pass.`, { kind: 'fw:verify_fix', ref: t.path }, ctx.now)
    } catch {
      errors++
    }
  }

  if (done.length > 0) {
    const saved = await writeSetting(admin, VERIFY_FIX_STATE_KEY, JSON.stringify(boundFixState(fixes)))
    if (saved.error) errors++
  }
  if (done.length === 0) return { ran: errors > 0, reason: errors > 0 ? 'could not refresh the failing page' : 'nothing to refresh', ...(errors > 0 ? { note: `${errors} refresh${errors === 1 ? '' : 'es'} failed` } : {}), acted: 0 }
  return { ran: true, acted: done.length, note: `refreshed ${done.length} page${done.length === 1 ? '' : 's'} that failed the publish check (${done.join(', ')})${pinged ? `, pinged ${pinged}` : ''}${errors ? `, ${errors} failed` : ''}` }
}

export const verifyFixStep: FlywheelStep = {
  id: 'verify_fix',
  policy: 'verify_fix',
  label: 'Publish-verify remediation',
  order: 60,
  floorMs: 20_000,
  run: (ctx) => runVerifyFix(ctx),
  undo: async (_admin, ref) => ({
    ok: true,
    message: `The page ${ref} will not be refreshed automatically again. (The refresh itself only emptied a cache; nothing on the page changed.)`,
  }),
}
