import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { revalidatePath } from 'next/cache'
import { getSystemCheck, loadFixes, readStoredCheck, tickFix } from '@/lib/system-check-run'
import { runAutoHeal } from '@/lib/system-check-heal'
import { diffChecks } from '@/lib/system-check-prompt'
import { summarizeCheck } from '@/lib/system-check'
import { summarizeFixes } from '@/lib/system-check-fixes'

export const dynamic = 'force-dynamic'
// 300 seconds: Auto-heal's bounded AI step (lib/system-check-ai.ts) can make model calls, and a call only starts with 50 seconds left.
export const maxDuration = 300

async function answer(force: boolean) {
  const admin = getSupabaseAdmin()
  const got = await getSystemCheck(admin, { force })
  const fixes = await loadFixes(admin, got.result)
  return {
    ...got.result,
    summary: summarizeCheck(got.result),
    fixes,
    fixSummary: summarizeFixes(fixes),
    cached: got.cached,
    ...(got.saveWarning ? { warning: `The answer could not be saved (${got.saveWarning}).` } : {}),
  }
}

// GET   the automated system check: every stage in funnel order, each green, amber or red with one plain sentence, what the site
//       fixed by itself and what needs a person, plus `fixes`: the "Fix these today" list built from the amber and red stages, most
//       impactful first, each with today's tick. An answer younger than 5 minutes is reused; ?force=1 reads everything again.
// POST  {op: 'run'}                          "Run check now": reads everything again and saves the answer, then returns it like GET.
//       {op: 'heal'}                          "Auto-heal": runs the existing safe, capped repairs once (lib/system-check-heal.ts; kill switch and
//                                             caps respected, each repair logged with Undo), then ONE bounded AI step (lib/system-check-ai.ts: at most
//                                             3 listed pages, heal-loop daily call cap, spend limit, once per item per day), then returns a fresh
//                                             check plus `heal`.
//       {op: 'done'|'later'|'reopen', stage}  tick one fix for today (kept in the daily follow-ups store).
// Everything but op 'heal' is read only (apart from saving its own answer and the ticks in app_settings): no AI call, nothing posted.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    return NextResponse.json(await answer(new URL(request.url).searchParams.get('force') === '1'))
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = (await request.json().catch(() => null)) as { op?: unknown; stage?: unknown } | null
    if (body?.op === 'run') return NextResponse.json(await answer(true))
    if (body?.op === 'heal') {
      // Auto-heal: one safe, capped pass through the repairs the site already makes daily, then a fresh check and what changed.
      const admin = getSupabaseAdmin()
      const before = await readStoredCheck(admin)
      // The AI step reads a fresh check AFTER the plain repairs, so it only considers what is still amber or red.
      const run = await runAutoHeal(admin, {
        listed: async () => (await getSystemCheck(admin, { force: true })).result.stages.map((s) => ({ id: s.id, light: s.light })),
      })
      for (const p of run.changedPaths) {
        try {
          revalidatePath(p)
        } catch {
          // a cache miss must not fail the heal
        }
      }
      const after = await answer(true)
      return NextResponse.json({
        ...after,
        heal: { report: run.report, cooledDown: run.cooledDown, cooldownSeconds: run.cooldownSeconds, diff: diffChecks(before, after) },
      })
    }
    if (body?.op === 'done' || body?.op === 'later' || body?.op === 'reopen') {
      const r = await tickFix(getSupabaseAdmin(), body.stage, body.op)
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
      return NextResponse.json({ ok: true, fixes: r.fixes, fixSummary: summarizeFixes(r.fixes) })
    }
    return NextResponse.json({ error: 'op must be run, done, later or reopen.' }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
