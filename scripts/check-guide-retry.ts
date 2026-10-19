// Offline self-check for retrying rejected guide drafts (bounded): the pure decision isRetryableRejected and the
// real listGuideCandidates against a small in-memory fake of the Supabase client. No network, no database.
// Run: pnpm dlx tsx scripts/check-guide-retry.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { HEAL_REJECTED_NOTE_PREFIX, isHealRejectedNote, isRetryableRejected, listGuideCandidates, rejectionCountFor } from '../lib/guides'
import { healNoteOf } from '../lib/heal-targets'
import type { HealOutcome } from '../lib/heal-loop'

let failed = 0
function check(label: string, ok: boolean) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
}

const DAY = 86_400_000
const now = Date.parse('2026-10-19T12:00:00Z')
const ago = (days: number) => new Date(now - days * DAY).toISOString()

// ---- the pure decision
const HEAL = healNoteOf({ status: 'rejected_by_heal', reasons: ['a claim has no source'], note: 'x', rounds: 3 } as unknown as HealOutcome)
check('the heal marker matches what the heal writes', isHealRejectedNote(HEAL) && HEAL.startsWith(HEAL_REJECTED_NOTE_PREFIX))
const rej = (extra: Record<string, unknown>) => ({ status: 'draft', review_state: 'rejected', quality_notes: HEAL, updated_at: ago(3), ...extra })
check('heal-rejected, 3 days old, 1 rejection: retry', isRetryableRejected(rej({}), now, 1))
check('heal-rejected with a guessed-name note appended still retries', isRetryableRejected(rej({ quality_notes: `${HEAL}; held for review: x` }), now, 1))
check('rejected, 1 day old: not yet', !isRetryableRejected(rej({ updated_at: ago(1) }), now, 1))
check('rejected, 3 days old, 2 rejections: stop', !isRetryableRejected(rej({}), now, 2))
check('rejected, 3 days old, 5 rejections: stop', !isRetryableRejected(rej({}), now, 5))
check('person-rejected (gate note, no heal marker) never retries', !isRetryableRejected(rej({ quality_notes: 'held for review: the quality gate found 2 problems' }), now, 1))
check('person-rejected (empty note) never retries', !isRetryableRejected(rej({ quality_notes: null }), now, 1))
check('person-rejected (note missing) never retries', !isRetryableRejected({ status: 'draft', review_state: 'rejected', updated_at: ago(30) }, now, 0))
check('heal words in the middle of a note are not the marker', !isRetryableRejected(rej({ quality_notes: `a person said: ${HEAL}` }), now, 1))
check('published row never retries', !isRetryableRejected({ status: 'published', review_state: null, updated_at: ago(30) }, now, 0))
check('published row even if flagged rejected never retries', !isRetryableRejected(rej({ status: 'published', updated_at: ago(30) }), now, 0))
check('non-rejected draft does not retry', !isRetryableRejected({ status: 'draft', review_state: null, quality_notes: HEAL, updated_at: ago(30) }, now, 0))
check('missing date does not retry', !isRetryableRejected(rej({ updated_at: null }), now, 1))
check('bad date does not retry', !isRetryableRejected(rej({ updated_at: 'nope' }), now, 1))
check('accepts a Date for now', isRetryableRejected(rej({}), new Date(now), 1))
check('rejection count is recorded failures plus the current one', rejectionCountFor(undefined) === 1 && rejectionCountFor(1) === 2)

// ---- listGuideCandidates against a fake client
type Row = Record<string, unknown>
function fakeAdmin(opts: { guides: Row[]; failures?: Record<string, { n: number }>; failOn?: string }): SupabaseClient {
  const from = (table: string) => {
    const state = { cols: '', key: '' }
    const result = () => {
      if (table === 'travel_packages') return { data: [{ name: 'Test Place', destination: 'Aruba', category: 'Beach' }], error: null }
      if (table === 'guides') {
        if (opts.failOn && state.cols.includes(opts.failOn)) return { data: null, error: { message: `column guides.${opts.failOn} does not exist` } }
        return { data: opts.guides, error: null }
      }
      return { data: null, error: null }
    }
    const q: Record<string, unknown> = {
      select: (c: string) => { state.cols = c; return q },
      eq: (_c: string, v: string) => { state.key = v; return q },
      maybeSingle: async () => {
        if (table === 'app_settings' && state.key === 'guides_compose_failures' && opts.failures) return { data: { value: JSON.stringify(opts.failures) }, error: null }
        return { data: null, error: null }
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej),
    }
    return q
  }
  return { from } as unknown as SupabaseClient
}

async function offered(guides: Row[], failures?: Record<string, { n: number }>, failOn?: string) {
  const c = await listGuideCandidates(fakeAdmin({ guides, failures, failOn }))
  return c.some((x) => x.kind === 'destinations' && x.slug === 'aruba')
}

async function main() {
  const base = { kind: 'destinations', slug: 'aruba' }
  check('candidates: no row, offered', await offered([]))
  check('candidates: heal-rejected 3 days ago, no failures, offered again', await offered([{ ...base, status: 'draft', review_state: 'rejected', quality_notes: HEAL, updated_at: ago(3) }]))
  check('candidates: person-rejected 3 days ago, never offered', !(await offered([{ ...base, status: 'draft', review_state: 'rejected', quality_notes: 'held for review: the quality gate found 1 problem', updated_at: ago(3) }])))
  check('candidates: person-rejected with no note, never offered', !(await offered([{ ...base, status: 'draft', review_state: 'rejected', quality_notes: null, updated_at: ago(30) }])))
  check('candidates: heal-rejected 1 day ago, not offered', !(await offered([{ ...base, status: 'draft', review_state: 'rejected', quality_notes: HEAL, updated_at: ago(1) }])))
  check('candidates: heal-rejected, one earlier retry recorded, not offered', !(await offered([{ ...base, status: 'draft', review_state: 'rejected', quality_notes: HEAL, updated_at: ago(3) }], { 'destinations:aruba': { n: 1 } })))
  check('candidates: published never offered', !(await offered([{ ...base, status: 'published', review_state: null, updated_at: ago(30) }])))
  check('candidates: non-rejected draft not offered', !(await offered([{ ...base, status: 'draft', review_state: null, updated_at: ago(30) }])))
  check('candidates: before migration 0041 (no review_state column) the row still blocks', !(await offered([{ ...base, status: 'draft', updated_at: ago(30) }], undefined, 'review_state')))

  if (failed) {
    console.log(`\n${failed} check(s) failed`)
    process.exit(1)
  }
  console.log('\nall checks passed')
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
