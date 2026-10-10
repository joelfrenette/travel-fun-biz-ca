// Offline self-check for guide social posting (WP7): the slug/path helpers, the one-per-UTC-day enrolment cap
// (against a small in-memory fake of the Supabase client, no network, no database), the send-time guide loader,
// and the link-graph pickers. The posting loop itself (runDistributionLocked) is NOT run here: it needs the live
// provider, so its guide branch is covered by reading the diff, not by this script.
// Run: pnpm dlx tsx scripts/check-guide-distribution.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { guideDistributionSlug, guideDistributionPath, guideFromPath, loadGuidePostSource } from '../lib/guide-post-source'
import { enrollGuideIfDue, guideEnrolmentsSince, guideSocialNetworks, utcDayStart, GUIDE_ENROLMENTS_PER_DAY } from '../lib/guide-distribution'
import { pickRelatedGuides, pickGuidesForPost, oneLineSummary, type GuideLink } from '../lib/guides'

let failed = 0
function check(label: string, ok: boolean) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
}

// ---- a tiny fake of the parts of the Supabase client these functions use ----
type Row = Record<string, unknown>
interface Db {
  tables: Record<string, Row[]>
  /** When true, any filter on post_distribution.path fails like a missing column (migration 0030 not applied). */
  noPathColumn?: boolean
  /** When true, every post_distribution read fails. */
  readsFail?: boolean
}
function fakeAdmin(db: Db): SupabaseClient {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let mode: 'select' | 'insert' | 'delete' = 'select'
    let payload: Row | null = null
    let opts: { count?: string; head?: boolean } | undefined
    let pathFilter = false
    const rows = () => (db.tables[table] ??= [])
    const run = () => {
      if (table === 'post_distribution' && (db.readsFail || (db.noPathColumn && pathFilter))) return { data: null, error: { message: 'column path does not exist' }, count: null }
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
        if (c === 'path') pathFilter = true
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
const setting = (key: string, value: string): Row => ({ key, value })
const guide = (kind: 'hotels' | 'resorts' | 'destinations', slug: string, status = 'published') => ({ kind, slug, name: slug.replace(/-/g, ' '), status })

async function main() {
  // ---- slug and path helpers ----
  check('slug is guide-<kind>-<slug>', guideDistributionSlug('resorts', 'some-resort') === 'guide-resorts-some-resort')
  check('path is the public address (destinations keep their prefix)', guideDistributionPath('destinations', 'cancun') === '/destinations/cancun')
  check('path for a resort', guideDistributionPath('resorts', 'some-resort') === '/resorts/some-resort')
  check('path for a river cruise', guideDistributionPath('river-cruises', 'rhine') === '/river-cruises/rhine')
  check('guideFromPath reads a resort', JSON.stringify(guideFromPath('/resorts/some-resort')) === JSON.stringify({ kind: 'resorts', slug: 'some-resort' }))
  check('guideFromPath reads a destination', guideFromPath('/destinations/cancun')?.kind === 'destinations')
  check('guideFromPath rejects a blog path', guideFromPath('/blog/some-post') === null)
  check('guideFromPath rejects an empty slug', guideFromPath('/resorts/') === null)
  check('guideFromPath rejects a nested path', guideFromPath('/resorts/a/b') === null)
  check('guideFromPath rejects a full URL', guideFromPath('https://evil.example/resorts/x') === null)
  check('utcDayStart is midnight UTC', utcDayStart(new Date('2026-10-11T23:59:59Z')) === '2026-10-11T00:00:00.000Z')
  check('cap is exactly one a day', GUIDE_ENROLMENTS_PER_DAY === 1)

  // ---- enrolment ----
  const base = (): Db => ({ tables: { app_settings: [setting('distribution_mode', 'auto')], post_distribution: [] } })

  let db = base()
  check('auto mode enrols a published guide', (await enrollGuideIfDue(fakeAdmin(db), guide('resorts', 'one'))) === 'enrolled')
  const row = db.tables.post_distribution[0]
  check('the row is queued with the guide slug, path and name', row.stage === 'queued' && row.slug === 'guide-resorts-one' && row.path === '/resorts/one' && row.title === 'one' && row.content_type === 'post')
  check('a second guide the same day is NOT enrolled', (await enrollGuideIfDue(fakeAdmin(db), guide('hotels', 'two'))) === 'skipped' && db.tables.post_distribution.length === 1)
  check('the same guide is never enrolled twice', (await enrollGuideIfDue(fakeAdmin(db), guide('resorts', 'one'))) === 'skipped' && db.tables.post_distribution.length === 1)

  db = base()
  db.tables.post_distribution.push({ slug: 'guide-hotels-old', path: '/hotels/old', created_at: new Date(Date.now() - 86_400_000 * 1.5).toISOString() })
  check('a guide enrolled before today does not use today', (await enrollGuideIfDue(fakeAdmin(db), guide('resorts', 'fresh'))) === 'enrolled')

  db = base()
  db.tables.post_distribution.push({ slug: 'guide-to-santorini', path: null, created_at: new Date().toISOString() })
  check('a blog post whose slug starts "guide-" is not counted', (await enrollGuideIfDue(fakeAdmin(db), guide('resorts', 'x'))) === 'enrolled')

  db = base()
  db.tables.app_settings = [setting('distribution_mode', 'prepare')]
  await enrollGuideIfDue(fakeAdmin(db), guide('resorts', 'held-one'))
  check('prepare mode enrols into held', db.tables.post_distribution[0]?.stage === 'held')

  db = base()
  db.tables.app_settings = [setting('distribution_mode', 'off')]
  check('off mode enrols nothing', (await enrollGuideIfDue(fakeAdmin(db), guide('resorts', 'a'))) === 'skipped' && db.tables.post_distribution.length === 0)
  db = base()
  db.tables.app_settings = []
  check('unset mode (defaults off) enrols nothing', (await enrollGuideIfDue(fakeAdmin(db), guide('resorts', 'a'))) === 'skipped' && db.tables.post_distribution.length === 0)
  db = base()
  db.tables.app_settings.push(setting('automation_paused', 'true'))
  check('paused automation enrols nothing', (await enrollGuideIfDue(fakeAdmin(db), guide('resorts', 'a'))) === 'skipped' && db.tables.post_distribution.length === 0)
  db = base()
  check('a draft guide is never enrolled', (await enrollGuideIfDue(fakeAdmin(db), guide('resorts', 'a', 'draft'))) === 'skipped' && db.tables.post_distribution.length === 0)

  db = base()
  db.noPathColumn = true
  check('count fails closed before migration 0030 (null)', (await guideEnrolmentsSince(fakeAdmin(db), utcDayStart())) === null)
  check('no enrolment when the count cannot be read', (await enrollGuideIfDue(fakeAdmin(db), guide('resorts', 'a'))) === 'skipped' && db.tables.post_distribution.length === 0)
  db = base()
  db.readsFail = true
  check('no enrolment when the ledger cannot be read', (await enrollGuideIfDue(fakeAdmin(db), guide('resorts', 'a'))) === 'skipped')

  db = base()
  db.tables.post_distribution.push({ slug: 'guide-resorts-sent', path: '/resorts/sent', sent_platforms: ['facebook', 'bluesky'], created_at: new Date().toISOString() }, { slug: 'guide-hotels-queued', path: '/hotels/queued', sent_platforms: [], created_at: new Date().toISOString() })
  const nets = await guideSocialNetworks(fakeAdmin(db))
  check('admin "posted to" lists the networks reached', nets['guide-resorts-sent']?.join(',') === 'facebook,bluesky')
  check('admin shows nothing for a guide not yet posted', nets['guide-hotels-queued'] === undefined)

  // ---- the send-time loader ----
  const guides: Row[] = [
    { kind: 'resorts', slug: 'live', name: 'Live Resort', summary: 'A resort.', hero_image_url: 'https://img/x.jpg', og_title: 'Is Live Resort right for you?', meta_description: 'Meta text.', faq: [{ q: 'Q one?', a: 'A one.' }], key_takeaways: ['Take one'], status: 'published' },
    { kind: 'resorts', slug: 'draft', name: 'Draft Resort', summary: 'x', hero_image_url: null, og_title: null, meta_description: null, faq: [], key_takeaways: [], status: 'draft' },
    { kind: 'hotels', slug: 'plain', name: 'Plain Hotel', summary: 'Summary only.', hero_image_url: null, og_title: null, meta_description: null, faq: null, key_takeaways: null, status: 'published' },
  ]
  const gdb: Db = { tables: { guides } }
  const live = await loadGuidePostSource(fakeAdmin(gdb), '/resorts/live')
  check('loader returns title (og_title), hero, description and grounding for a published guide', live?.title === 'Is Live Resort right for you?' && live.cover_image_url === 'https://img/x.jpg' && live.meta_description === 'Meta text.' && /Take one/.test(live.grounding ?? '') && /Q one/.test(live.grounding ?? ''))
  check('loader returns null for a draft (nothing is sent)', (await loadGuidePostSource(fakeAdmin(gdb), '/resorts/draft')) === null)
  check('loader returns null for a deleted guide', (await loadGuidePostSource(fakeAdmin(gdb), '/resorts/gone')) === null)
  check('loader returns null for a non-guide path', (await loadGuidePostSource(fakeAdmin(gdb), '/blog/some-post')) === null)
  const plain = await loadGuidePostSource(fakeAdmin(gdb), '/hotels/plain')
  check('loader falls back to name and summary, no hero, no grounding', plain?.title === 'Plain Hotel' && plain.meta_description === 'Summary only.' && plain.cover_image_url === null && plain.grounding === undefined)

  // ---- link graph pickers ----
  const g = (id: string, kind: GuideLink['kind'], slug: string, parent: string | null = null, pkgs: string[] = []): GuideLink => ({ id, kind, slug, name: slug.replace(/-/g, ' '), parent_slug: parent, summary: 'Sentence one. Sentence two.', related_package_ids: pkgs })
  const all = [
    g('1', 'resorts', 'r-alpha', 'cancun'),
    g('2', 'resorts', 'r-b', 'cancun'),
    g('3', 'resorts', 'r-c', 'jamaica'),
    g('4', 'destinations', 'cancun'),
    g('5', 'hotels', 'h-a', 'jamaica', ['p1']),
    g('6', 'ships', 's-a', null, ['p1']),
    g('7', 'yachts', 'y-a'),
  ]
  const related = pickRelatedGuides(all[0], all, 6)
  check('related: never includes itself', !related.some((x) => x.id === '1'))
  check('related: same parent first, then the parent destination', related[0].id === '2' && related[1].id === '4')
  check('related: then the same kind', related[2].id === '3')
  check('related: respects the limit', pickRelatedGuides(all[0], all, 2).length === 2)
  check('related: a guide sharing a package comes after parent and kind', pickRelatedGuides(all[5], all, 6).map((x) => x.id).join(',') === '5')
  check('related: destination lists the properties under it first', pickRelatedGuides(all[3], all, 6).slice(0, 2).map((x) => x.id).sort().join(',') === '1,2')
  check('related: no duplicates', new Set(pickRelatedGuides(all[4], all, 6).map((x) => x.id)).size === pickRelatedGuides(all[4], all, 6).length)
  check('related: empty when nothing matches', pickRelatedGuides(all[6], [all[6]], 6).length === 0)

  const forPost = (title: string, tags: string[], destinationSlug: string | null) => pickGuidesForPost({ title, tags, destinationSlug }, all, 3).map((x) => x.id)
  check('post: destination from its package matches the destination guide and its properties', forPost('Any title', [], 'cancun').join(',') === '4,1,2')
  check('post: limit of 3', forPost('Any title', [], 'cancun').length <= 3)
  check('post: a guide name in the title matches', forPost('A week at R Alpha', [], null).join(',') === '1')
  check('post: a guide name in a tag matches', forPost('Some title', ['Cancun'], null).join(',') === '4')
  check('post: no match shows nothing (never guesses)', forPost('Packing tips for a long flight', ['tips'], null).length === 0)
  check('post: a partial word is not a match ("cancunish")', forPost('A cancunish idea', [], null).length === 0)
  check('post: an unknown destination shows nothing', forPost('Any title', [], 'nowhere').length === 0)
  check('oneLineSummary keeps the first sentence', oneLineSummary('Sentence one. Sentence two.') === 'Sentence one.')

  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
