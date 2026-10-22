// Offline self-check for the guide social catch-up: the pure picker (pickCatchUpGuide) and the one-try runner
// (runGuideCatchUp) against a small in-memory fake of the Supabase client. No network, no database.
// Run: pnpm dlx tsx scripts/check-guide-catchup.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pickCatchUpGuide, runGuideCatchUp, GUIDE_ENROLMENTS_PER_DAY, type CatchUpGuide } from '../lib/guide-distribution'

let failed = 0
function check(label: string, ok: boolean) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
}

type Row = Record<string, unknown>
interface Db {
  tables: Record<string, Row[]>
}
function fakeAdmin(db: Db): SupabaseClient {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let mode: 'select' | 'insert' | 'delete' = 'select'
    let payload: Row | null = null
    let opts: { count?: string; head?: boolean } | undefined
    const rows = () => (db.tables[table] ??= [])
    const run = () => {
      if (mode === 'insert') {
        rows().push({ created_at: new Date().toISOString(), attempts: 0, sent_platforms: [], ...payload })
        return { data: null, error: null, count: null }
      }
      const hit = rows().filter((r) => filters.every((f) => f(r)))
      if (mode === 'delete') {
        db.tables[table] = rows().filter((r) => !hit.includes(r))
        return { data: null, error: null, count: null }
      }
      if (opts?.head) return { data: null, error: null, count: hit.length }
      return { data: hit, error: null, count: hit.length }
    }
    const q: Record<string, unknown> = {
      select: (_cols?: string, o?: { count?: string; head?: boolean }) => ((opts = o), q),
      insert: (row: Row) => ((mode = 'insert'), (payload = row), q),
      delete: () => ((mode = 'delete'), q),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), q),
      gte: (c: string, v: string) => (filters.push((r) => String(r[c]) >= v), q),
      like: (c: string, pat: string) => {
        const re = new RegExp(`^${pat.replace(/%/g, '.*')}$`)
        filters.push((r) => re.test(String(r[c] ?? '')))
        return q
      },
      not: (c: string, op: string, v: unknown) => {
        if (op === 'is' && v === null) filters.push((r) => r[c] != null)
        return q
      },
      maybeSingle: () => Promise.resolve({ ...run(), data: (run().data as Row[] | null)?.[0] ?? null }),
      then: (resolve: (v: unknown) => unknown) => resolve(run()),
    }
    return q
  }
  return { from } as unknown as SupabaseClient
}

const g = (kind: CatchUpGuide['kind'], slug: string, created_at: string, extra: Partial<CatchUpGuide> = {}): CatchUpGuide => ({
  kind,
  slug,
  name: slug,
  status: 'published',
  quality_notes: null,
  created_at,
  ...extra,
})
const setting = (key: string, value: string): Row => ({ key, value })

async function main() {
  check('daily cap is 1', GUIDE_ENROLMENTS_PER_DAY === 1)

  // ---- the pure picker ----
  const none = new Set<string>()
  check('no guides returns null', pickCatchUpGuide([], none) === null)

  const oldDest = g('destinations', 'cancun', '2026-01-01T00:00:00Z')
  const newDest = g('destinations', 'maui', '2026-03-01T00:00:00Z')
  const oldHotel = g('hotels', 'a-hotel', '2025-06-01T00:00:00Z')
  const oldShip = g('ships', 'a-ship', '2025-05-01T00:00:00Z')
  const oldLine = g('cruise-lines', 'a-line', '2025-04-01T00:00:00Z')

  check('a guide with a ledger row is never picked', pickCatchUpGuide([oldDest], new Set(['guide-destinations-cancun'])) === null)
  check('ledger row skips only that guide', pickCatchUpGuide([oldDest, newDest], new Set(['guide-destinations-cancun']))?.slug === 'maui')
  check('ledger accepts a plain array too', pickCatchUpGuide([oldDest, newDest], ['guide-destinations-cancun'])?.slug === 'maui')
  check('destinations are picked before older hotels, ships and cruise lines', pickCatchUpGuide([oldHotel, oldShip, oldLine, newDest], none)?.slug === 'maui')
  check('among destinations the oldest wins', pickCatchUpGuide([newDest, oldDest], none)?.slug === 'cancun')
  check('among non-destinations the oldest wins', pickCatchUpGuide([oldHotel, oldLine, oldShip], none)?.slug === 'a-line')
  check('a non-destination is picked when no destination qualifies', pickCatchUpGuide([oldHotel, oldShip], none)?.slug === 'a-ship')
  check('a draft is skipped', pickCatchUpGuide([g('destinations', 'draft-one', '2020-01-01T00:00:00Z', { status: 'draft' }), newDest], none)?.slug === 'maui')
  check('non-empty quality_notes is skipped', pickCatchUpGuide([g('destinations', 'held-one', '2020-01-01T00:00:00Z', { quality_notes: 'gate: thin' }), newDest], none)?.slug === 'maui')
  check('whitespace-only quality_notes does not block', pickCatchUpGuide([g('destinations', 'blank-notes', '2020-01-01T00:00:00Z', { quality_notes: '   ' })], none)?.slug === 'blank-notes')
  check('only drafts or held means null', pickCatchUpGuide([g('hotels', 'x', '2020-01-01T00:00:00Z', { status: 'draft' }), g('hotels', 'y', '2020-01-01T00:00:00Z', { quality_notes: 'n' })], none) === null)
  check('cap already used returns null', pickCatchUpGuide([oldDest], none, GUIDE_ENROLMENTS_PER_DAY) === null)
  check('unreadable daily count returns null (fail closed)', pickCatchUpGuide([oldDest], none, null) === null)
  check('missing created_at sorts last', pickCatchUpGuide([g('hotels', 'no-date', '', { created_at: null }), oldHotel], none)?.slug === 'a-hotel')
  const input = [newDest, oldDest]
  pickCatchUpGuide(input, none)
  check('picker does not reorder its input', input[0] === newDest)

  // ---- the runner, against the fake ----
  const base = (mode = 'auto'): Db => ({
    tables: {
      app_settings: [setting('distribution_mode', mode), setting('guide_catchup_posts', 'true')],
      post_distribution: [],
      guides: [
        { kind: 'hotels', slug: 'a-hotel', name: 'A Hotel', status: 'published', quality_notes: null, created_at: '2025-06-01T00:00:00Z' },
        { kind: 'destinations', slug: 'maui', name: 'Maui', status: 'published', quality_notes: null, created_at: '2026-03-01T00:00:00Z' },
        { kind: 'destinations', slug: 'cancun', name: 'Cancun', status: 'published', quality_notes: null, created_at: '2026-01-01T00:00:00Z' },
        { kind: 'destinations', slug: 'draft-d', name: 'Draft', status: 'draft', quality_notes: null, created_at: '2020-01-01T00:00:00Z' },
      ],
    },
  })

  let db = base()
  let note = await runGuideCatchUp(fakeAdmin(db))
  check('runner enrols the oldest destination', db.tables.post_distribution.length === 1 && db.tables.post_distribution[0].slug === 'guide-destinations-cancun')
  check('destination row is queued in auto mode', db.tables.post_distribution[0]?.stage === 'queued' && db.tables.post_distribution[0]?.path === '/destinations/cancun')
  check('runner returns a note', note.includes('guide-destinations-cancun'))

  note = await runGuideCatchUp(fakeAdmin(db))
  check('second call the same day does nothing (cap used)', db.tables.post_distribution.length === 1 && note === '')

  db = base()
  db.tables.guides = [{ kind: 'hotels', slug: 'a-hotel', name: 'A Hotel', status: 'published', quality_notes: null, created_at: '2025-06-01T00:00:00Z' }]
  await runGuideCatchUp(fakeAdmin(db))
  check('a named business is enrolled as held, never queued', db.tables.post_distribution[0]?.stage === 'held')

  db = base('prepare')
  await runGuideCatchUp(fakeAdmin(db))
  check('prepare mode enrols held', db.tables.post_distribution[0]?.stage === 'held')

  db = base('off')
  await runGuideCatchUp(fakeAdmin(db))
  check('distribution off enrols nothing', db.tables.post_distribution.length === 0)

  db = base()
  db.tables.app_settings.push(setting('automation_paused', 'true'))
  await runGuideCatchUp(fakeAdmin(db))
  check('kill switch enrols nothing', db.tables.post_distribution.length === 0)

  db = base()
  db.tables.post_distribution.push({ slug: 'guide-hotels-other', path: '/hotels/other', content_type: 'post', stage: 'done', created_at: new Date().toISOString() })
  await runGuideCatchUp(fakeAdmin(db))
  check('a guide enrolled earlier today uses the cap, so no catch-up', db.tables.post_distribution.length === 1)

  db = base()
  db.tables.post_distribution.push({ slug: 'guide-destinations-cancun', path: '/destinations/cancun', content_type: 'post', stage: 'done', created_at: '2026-01-02T00:00:00.000Z' })
  await runGuideCatchUp(fakeAdmin(db))
  check('an already-posted guide is skipped, next oldest is enrolled', db.tables.post_distribution.some((r) => r.slug === 'guide-destinations-maui') && !db.tables.post_distribution.some((r) => r.slug === 'guide-hotels-a-hotel'))

  db = base()
  db.tables.guides = []
  note = await runGuideCatchUp(fakeAdmin(db))
  check('no candidates enrols nothing', db.tables.post_distribution.length === 0 && note === '')

  const boom = { from: () => { throw new Error('db down') } } as unknown as SupabaseClient
  db = base()
  db.tables.app_settings = db.tables.app_settings.filter((r) => r.key !== 'guide_catchup_posts')
  note = await runGuideCatchUp(fakeAdmin(db))
  check('catch-up is off unless guide_catchup_posts is true', db.tables.post_distribution.length === 0 && note === '')
  check('runner never throws',(await runGuideCatchUp(boom)) === '')

  // ---- source wiring: called from the existing posting pass, via enrollGuideIfDue, no cron added ----
  const root = join(__dirname, '..')
  const src = readFileSync(join(root, 'lib/guide-distribution.ts'), 'utf8')
  const dist = readFileSync(join(root, 'lib/distribution.ts'), 'utf8')
  const vercel = readFileSync(join(root, 'vercel.json'), 'utf8')
  check('catch-up calls enrollGuideIfDue', /runGuideCatchUp[\s\S]*await enrollGuideIfDue\(admin, pick\)/.test(src))
  check('catch-up is called inside runDistribution', /runDistribution[\s\S]*runGuideCatchUp\(admin\)/.test(dist))
  check('vercel.json has no catch-up cron', !/catch-?up/i.test(vercel))

  console.log(failed === 0 ? '\nall guide catch-up checks passed' : `\n${failed} check(s) FAILED`)
  process.exit(failed === 0 ? 0 : 1)
}
main()
