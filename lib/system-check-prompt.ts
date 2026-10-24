// The "Copy for Claude" super-prompt for the system check, and the before/after comparison of an Auto-heal run. Pure: no database,
// no network, no clock (the date comes in), so scripts/check-system-check-prompt.ts tests it offline. The page copies the text
// with navigator.clipboard; Joel pastes it into Claude Code.

import type { CheckResult, CheckStage, StageId } from './system-check'

/** What one Auto-heal step did, in plain words. */
export interface HealStep {
  id: string
  label: string
  /** True when the step actually ran (false = skipped, with the reason in `note`). */
  ran: boolean
  /** How many things it changed. */
  acted: number
  note: string
}

export interface HealReport {
  at: string
  steps: HealStep[]
  /** True when automation is paused (kill switch): nothing was repaired. */
  paused: boolean
}

export interface CheckDiff {
  /** Stages that were amber or red before and are green now. */
  fixed: Array<{ id: StageId; label: string }>
  /** Stages that are still amber or red. */
  stillOpen: Array<{ id: StageId; label: string; light: 'amber' | 'red'; sentence: string }>
  /** Stages that were green before and are not now. */
  newlyWorse: Array<{ id: StageId; label: string; light: 'amber' | 'red' }>
}

/** Compares the check before an Auto-heal run with the check after it. Pure. */
export function diffChecks(before: CheckResult | null, after: CheckResult): CheckDiff {
  const was = new Map<StageId, CheckStage>((before?.stages ?? []).map((s) => [s.id, s]))
  const out: CheckDiff = { fixed: [], stillOpen: [], newlyWorse: [] }
  for (const s of after.stages) {
    const b = was.get(s.id)
    if (s.light === 'green') {
      if (b && b.light !== 'green') out.fixed.push({ id: s.id, label: s.label })
    } else {
      out.stillOpen.push({ id: s.id, label: s.label, light: s.light, sentence: s.sentence })
      if (b && b.light === 'green') out.newlyWorse.push({ id: s.id, label: s.label, light: s.light })
    }
  }
  return out
}

/** The code that looks after each stage, so Claude Code knows where to start. */
export const STAGE_FILES: Record<StageId, string[]> = {
  production: ['lib/autoblog-run.ts', 'lib/pipeline.ts', 'app/admin/blog/page.tsx'],
  quality: ['lib/blog-reheal.ts', 'lib/heal-drafts.ts', 'lib/visual-gate-stats.ts'],
  distribution: ['lib/distribution.ts', 'lib/auto-policies.ts', 'app/admin/distribution/page.tsx'],
  discovery: ['lib/funnel-watchdog.ts', 'lib/seo-engines-run.ts', 'lib/indexnow.ts'],
  clicks: ['lib/funnel-watchdog.ts', 'lib/autopilot.ts', 'lib/ctr-loop.ts'],
  conversion: ['lib/funnel-watchdog.ts', 'lib/leads.ts', 'app/admin/leads/page.tsx'],
  measurement: ['lib/funnel-watchdog.ts', 'lib/traffic-source.ts', 'app/api/admin/visit-tracking'],
  money: ['lib/issues.ts', 'lib/plain-steps.ts', 'app/admin/orders/page.tsx'],
  seo: ['lib/seo-playbook-view.ts', 'lib/site-crawl.ts', 'app/admin/seo-manager/page.tsx'],
  jobs: ['lib/cron-health.ts', 'lib/cron-heartbeat.ts', 'app/api/cron/gsc-snapshot/route.ts'],
  ai: ['lib/ai-tripwire.ts', 'app/admin/users/page.tsx'],
}

export interface PromptInput {
  /** The moment the prompt is built (a Date so the function stays pure). */
  now: Date
  check: CheckResult
  /** The last Auto-heal run in this visit, if any. */
  heal?: HealReport | null
  /** What changed across that run. */
  diff?: CheckDiff | null
  /** Public site address, for the opening line. */
  siteUrl?: string
}

const WORD = { amber: 'AMBER (worth a look)', red: 'RED (a problem)' } as const

function dayOf(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/** Builds the one text Joel pastes into Claude Code. Pure. Never contains a secret: it only restates what the check page shows. */
export function buildClaudePrompt(i: PromptInput): string {
  const open = i.check.stages.filter((s) => s.light !== 'green')
  const lines: string[] = []
  lines.push(`You are working on TravelFunBiz.ca (${i.siteUrl ?? 'https://travelfunbiz.ca'}): a Next.js 14 (App Router) + Supabase lead-gen site for a travel agency, with an admin at /admin. Today is ${dayOf(i.now)}.`)
  lines.push('')
  lines.push('Read CLAUDE.md in the repo root first and follow it. The short version of the repo rules:')
  lines.push('- Admin data lives in Supabase; admin tables are RLS-on with no policies, so only the service role (getSupabaseAdmin()) reads or writes them.')
  lines.push('- Every admin API route checks isAuthorized(request) from lib/admin-auth.ts first.')
  lines.push('- Never invent data (no default prices or categories). Every credit-costing call is admin-triggered and cached.')
  lines.push('- New env vars go in .env.example in the same change. No em dashes in copy. Use plain English.')
  lines.push('')
  lines.push(`The admin System check (/admin/system-check) just ran. Overall light: ${i.check.overall.toUpperCase()}. Checked at ${i.check.at}.`)
  lines.push('')

  if (open.length === 0) {
    lines.push('Every stage is green. There is nothing to fix. Reply "Nothing to fix" and stop.')
    return lines.join('\n')
  }

  lines.push(`Issues to fix (${open.length}), worst first:`)
  const ranked = [...open].sort((a, b) => Number(b.light === 'red') - Number(a.light === 'red'))
  ranked.forEach((s, idx) => {
    lines.push('')
    lines.push(`${idx + 1}. ${s.label} - ${WORD[s.light as 'amber' | 'red']}`)
    lines.push(`   What the check says: ${s.sentence}`)
    if (s.number) lines.push(`   The number: ${s.number}`)
    if (!s.read) lines.push('   Note: a number this stage needs could not be read, so this may be a read problem rather than a real fault.')
    if (s.needs) lines.push(`   Page to look at: ${s.needs.href} (${s.needs.text})`)
    lines.push(`   Code to start from: ${STAGE_FILES[s.id].join(', ')}`)
    if (s.fixed.length) lines.push(`   The site already fixed by itself: ${s.fixed.join('; ')}`)
  })
  lines.push('')

  if (i.heal) {
    lines.push('What Auto-heal already tried (one safe, capped pass, now finished):')
    if (i.heal.paused) lines.push('- Automation is paused (kill switch), so nothing was repaired.')
    for (const st of i.heal.steps) lines.push(`- ${st.label}: ${st.ran ? (st.acted ? `changed ${st.acted}` : 'changed nothing') : 'skipped'}${st.note ? `. ${st.note}` : ''}`)
    if (i.diff) {
      lines.push(`- After the re-check: ${i.diff.fixed.length} fixed${i.diff.fixed.length ? ` (${i.diff.fixed.map((f) => f.label).join(', ')})` : ''}, ${i.diff.stillOpen.length} still open${i.diff.newlyWorse.length ? `, ${i.diff.newlyWorse.length} newly worse (${i.diff.newlyWorse.map((f) => f.label).join(', ')})` : ''}.`)
    }
    lines.push('The list above is what is STILL open after that pass. Do not redo what Auto-heal already did.')
  } else {
    lines.push('Auto-heal has not been run yet for this list.')
  }
  lines.push('')

  lines.push('Safety rules (these are firm):')
  lines.push('- Do not print, copy or commit any secret, API key, token or customer data.')
  lines.push('- Make no change to live settings, the live database or production unless I ask for that specific change. Reading is fine.')
  lines.push('- Develop on a branch. Verify before you call anything done: `pnpm exec tsc --noEmit -p tsconfig.json`, the relevant scripts/check-*.ts via `pnpm dlx tsx`, and `next build` (never while `next dev` is running).')
  lines.push('- Commit and push only when I ask. Never force-push.')
  lines.push('- If a fix needs something only I can do (an account, a key, an approval), say so plainly instead of guessing.')
  lines.push('')
  lines.push('Now fix the issues one by one, in the order above. For each one: say what the real cause is, make the smallest safe change, show how you checked it, and move on. If you cannot fix one, say why and what I need to do. At the end, report: fixed, not fixed (and why), and anything I must do myself.')
  return lines.join('\n')
}
