// Admin-safe, one-off: run the guide heal NOW over every guide that is not live, plus every live guide marked rejected.
//
// It reuses the production code path and nothing else: healGuideRow() in lib/heal-drafts.ts is the function the daily runner calls for
// each held guide (rebuild the facts, run the heal loop, log every change to content_edits first so Undo works, then change status).
// This script only picks the rows, hands each one a shared in-memory call budget, and prints a table. It never writes a guide row, never
// calls the AI, and never edits settings itself.
//
// It spends real AI calls (up to the budget), so it refuses to run unless you pass --yes.
//
//   pnpm dlx tsx scripts/heal-guides-now.ts --yes                  (budget 60 AI calls)
//   pnpm dlx tsx scripts/heal-guides-now.ts --yes --budget=30
//   pnpm dlx tsx scripts/heal-guides-now.ts --yes --only=resorts/atlantis-paradise-island
//   pnpm dlx tsx scripts/heal-guides-now.ts --yes --limit=3
//
// Needs SUPABASE_SERVICE_ROLE_KEY and ANTHROPIC_API_KEY in .env.local (found in the current folder or any folder above it).
// Rules that still hold (they live in the shared code): guides_publish_mode must be "publish" and automation must not be paused;
// a guide whose name was guessed from a trip title is healed at most to a draft, never published; a page rebuilt as a "safe page" is
// published with the safe-page note in quality_notes; Undo works from the Self-healing card exactly as for the daily runner.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const DEFAULT_BUDGET = 60

function usage(): never {
  console.error('Refusing to run: this script spends AI calls and may publish guides. Re-run with --yes to confirm (or --dry to only look).')
  console.error('Example: pnpm dlx tsx scripts/heal-guides-now.ts --yes --budget=60')
  console.error('Options: --yes (required to heal)  --dry (list what would be processed and each guide\'s current blockers; no AI call, no write)  --budget=N (AI calls, default 60)  --only=kind/slug  --limit=N')
  process.exit(1)
}

function argValue(name: string): string | null {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 && process.argv[at + 1] && !process.argv[at + 1].startsWith('--') ? process.argv[at + 1] : null
}

/** Reads KEY=value lines from the first .env.local found in this folder or above. Existing environment values win. */
function loadEnvLocal(): string | null {
  let dir = resolve(process.cwd())
  for (let i = 0; i < 6; i++) {
    const file = join(dir, '.env.local')
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
        if (!m || line.trim().startsWith('#')) continue
        let value = m[2]
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
        if (process.env[m[1]] === undefined) process.env[m[1]] = value
      }
      return file
    }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

const pad = (s: string, n: number) => (s.length >= n ? `${s.slice(0, n - 1)} ` : s.padEnd(n))

async function main() {
  const dry = process.argv.includes('--dry')
  // --dry never spends or writes anything, so it needs no --yes; everything else does.
  if (!dry && !process.argv.includes('--yes')) usage()
  const budgetArg = argValue('budget')
  const budget = budgetArg === null ? DEFAULT_BUDGET : Number(budgetArg)
  if (!Number.isInteger(budget) || budget < 2 || budget > 400) {
    console.error(`--budget must be a whole number from 2 to 400 (got "${budgetArg}")`)
    process.exit(1)
  }
  const only = argValue('only')
  const limitArg = argValue('limit')
  const limit = limitArg === null ? Infinity : Number(limitArg)
  if (!(limit > 0)) {
    console.error('--limit must be a positive whole number')
    process.exit(1)
  }

  const envFile = loadEnvLocal()
  console.log(envFile ? `Using ${envFile}` : 'No .env.local found; using the environment as it is.')
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_SERVICE_ROLE_KEY is not set. Add it to .env.local and run again.')
    process.exit(1)
  }
  if (!dry && !process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set, so the heal cannot ask the AI. Add it to .env.local and run again.')
    process.exit(1)
  }

  // Imported only now, after the environment is loaded (the Supabase clients read it when their module loads).
  const { getSupabaseAdmin } = await import('../lib/supabase-admin')
  const { healGuideRow, describeGuideRow, isNowCandidate } = await import('../lib/heal-drafts')
  const { MODE_HOLD_NOTE } = await import('../lib/guide-list')
  const { memoryBudget } = await import('../lib/heal-loop')
  const { getGuidePublishMode } = await import('../lib/guide-run')
  const { isAutomationPaused } = await import('../lib/automation-kill-switch')
  const { pingIndexNow } = await import('../lib/indexnow')

  const admin = getSupabaseAdmin()
  const modeOk = (await getGuidePublishMode(admin)) === 'publish'
  const paused = await isAutomationPaused(admin)
  if (dry) {
    console.log(`DRY RUN: no AI call, no write. guides_publish_mode is ${modeOk ? 'publish' : 'NOT publish (a real run would stop)'}; automation is ${paused ? 'PAUSED (a real run would stop)' : 'running'}.`)
  } else {
    if (!modeOk) {
      console.error('guides_publish_mode is not "publish", so the heal would not publish anything (the same rule as the daily runner). Stopping.')
      process.exit(1)
    }
    if (paused) {
      console.error('Automation is paused (the kill switch). Stopping.')
      process.exit(1)
    }
  }

  const { data, error } = await admin.from('guides').select('*').order('created_at', { ascending: true }).limit(2000)
  if (error) {
    console.error(`Could not read the guides: ${error.message}`)
    process.exit(1)
  }
  type Row = Record<string, unknown>
  const all = (data ?? []) as Row[]
  const wanted = all.filter((r) => r.status !== 'published' || r.review_state === 'rejected')
  // Only pages the AI wrote (a page a person wrote is never rewritten), and not a draft a person unpublished or rejected: the shared
  // rule isNowCandidate() in lib/heal-drafts.ts is the one place that decides.
  const aiRows = wanted.filter((r) => isNowCandidate(r, [MODE_HOLD_NOTE]))
  const skippedHuman = wanted.length - aiRows.length
  const picked = (only ? aiRows.filter((r) => `${String(r.kind)}/${String(r.slug)}` === only) : aiRows).slice(0, Number.isFinite(limit) ? limit : undefined)
  console.log(`Guides read: ${all.length}. To heal: ${picked.length}${skippedHuman ? ` (${skippedHuman} left alone: written by a person, unpublished or rejected by a person, or no problem to fix)` : ''}. AI call budget: ${budget}.`)
  if (picked.length === 0) return

  if (dry) {
    for (const row of picked) {
      const d = await describeGuideRow(admin, row)
      const where = `${String(row.kind)}/${String(row.slug)}`
      const state = `${String(row.status)}${row.review_state === 'rejected' ? ', rejected' : ''}`
      const fate = d.guessed ? 'text only, never published (name guessed from a trip title)' : 'could be published if it heals'
      console.log(`  ${pad(where, 48)} ${pad(state, 20)} ${fate}`)
      if (d.error) console.log(`      could not read its blockers: ${d.error}`)
      else if (d.blockers.length === 0) console.log('      no blockers now (the reviewer would still read it before it goes live)')
      else for (const b of d.blockers.slice(0, 8)) console.log(`      blocker: ${b}`)
    }
    console.log(`\nDry run done: ${picked.length} guide(s) would be processed with a budget of ${budget} AI calls. Nothing was changed.`)
    return
  }

  const shared = memoryBudget(budget)
  const rows: { path: string; action: string; status: string; ladder: string; rounds: number; calls: number; note: string }[] = []
  for (const row of picked) {
    const where = `${String(row.kind)}/${String(row.slug)}`
    if (shared.remaining() < 2) {
      rows.push({ path: where, action: 'not tried', status: '-', ladder: '-', rounds: 0, calls: 0, note: 'the call budget is used up' })
      continue
    }
    // healGuideRow never throws, but one guide must never stop the rest, so any surprise is caught here too.
    try {
      const r = await healGuideRow(admin, row, { budget: shared, skipClaim: true })
      // A safe page is kept out of search until it is enriched, so it is not announced either.
      if (r.action === 'published' && !r.ladder.includes('safe-page')) await pingIndexNow([r.path, '/sitemap.xml']).catch(() => undefined)
      rows.push({ path: r.path, action: r.action, status: r.status, ladder: r.ladder.join('>') || '-', rounds: r.rounds, calls: r.calls, note: [r.note, ...r.problems].filter(Boolean).join('; ') })
      console.log(`  ${pad(r.path, 48)} ${pad(r.action, 13)} calls so far: ${shared.used}/${budget}`)
    } catch (e) {
      const why = e instanceof Error ? e.message : 'unknown error'
      rows.push({ path: where, action: 'failed', status: '-', ladder: '-', rounds: 0, calls: 0, note: why })
      console.log(`  ${pad(where, 48)} ${pad('failed', 13)} ${why}`)
    }
  }

  console.log('\nOutcome per guide')
  console.log(`${pad('guide', 48)}${pad('result', 14)}${pad('heal status', 18)}${pad('ladder', 28)}${pad('rounds', 7)}${pad('calls', 6)}note`)
  for (const r of rows) console.log(`${pad(r.path, 48)}${pad(r.action, 14)}${pad(r.status, 18)}${pad(r.ladder, 28)}${pad(String(r.rounds), 7)}${pad(String(r.calls), 6)}${r.note.slice(0, 160)}`)
  const count = (a: string) => rows.filter((r) => r.action === a).length
  console.log(`\nPublished: ${count('published')}. Healed live: ${count('healed_live')}. Healed, kept as draft: ${count('healed_draft')}. Rejected: ${count('rejected')}. Waiting: ${count('deferred') + count('not tried')}. Failed: ${count('failed')}.`)
  console.log(`AI calls used: ${shared.used} of ${budget}. Any change can be undone from the Self-healing card (Undo).`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
