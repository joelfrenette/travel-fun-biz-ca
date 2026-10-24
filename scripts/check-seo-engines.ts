// Offline self-check for the SEO engines: query mining (lib/gsc-mining.ts), cannibalisation (lib/cannibalization.ts), hub and spoke
// (lib/hub-spoke.ts), the competitor scanner (lib/competitor-scan.ts, lib/competitor-tasks.ts), the breadcrumbs audit
// (lib/breadcrumb-audit.ts) and the daily step (lib/seo-engines-run.ts). An in-memory fake of the Supabase client stands in for the
// database and a fake web stands in for competitor sites. No network, no AI call, nothing published.
// Run: pnpm dlx tsx scripts/check-seo-engines.ts
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeAdmin, type Db, type Row } from './fake-admin'
import { DECISIONS_KEY, parseDecisions, undoAutoDecision, readDecisions, POLICY_CAPS, type AutoDecision } from '../lib/auto-decisions'
import {
  findOpportunities,
  MIN_QUEUE_IMPRESSIONS,
  proposalBlockReason,
  proposalPageType,
  pushSafeTopics,
  queryRowsFromPairs,
  runMining,
  strikingRefreshTargets,
  TOPICS_PUSHED_PER_DAY,
  type QueryPageRow,
  type QueryRow,
} from '../lib/gsc-mining'
import { bestPageFor, loadSeoPages, matchScore, TYPE_PRIORITY, type SeoPage } from '../lib/seo-pages'
import { cannibalWishes, comparePrimary, groupCannibalised, pickPrimary, MIN_IMPRESSIONS_EACH } from '../lib/cannibalization'
import { applyLinkAdds, cleanAnchor, insertContextLink, LINKS_PER_DAY, planLinkAdds, type LinkWish } from '../lib/seo-links'
import { buildHubSpokeMap, clustersFromQueries, hubSpokeWishes, pickHub } from '../lib/hub-spoke'
import {
  addCompetitor,
  analyzePage,
  BOT_NAME,
  CANNOT_READ,
  COMPETITOR_STATE_KEY,
  contentTypeGap,
  keywordGap,
  MANUAL_STEPS,
  MAX_COMPETITORS,
  MAX_PAGES_PER_COMPETITOR,
  parseCompetitorList,
  parseRobots,
  pickDueCompetitor,
  readCompetitorState,
  robotsAllows,
  runCompetitorScan,
  samplePages,
  scanCompetitor,
  serviceGap,
  USER_AGENT,
  validateCompetitorUrl,
  writeCompetitorList,
  type CompetitorFetch,
  type CompetitorResult,
  type FetchResult,
} from '../lib/competitor-scan'
import { competitorTasks } from '../lib/competitor-tasks'
import { auditBreadcrumbs, breadcrumbFindings, crumbKindOf, hasBreadcrumbJsonLd, hasVisibleBreadcrumb } from '../lib/breadcrumb-audit'
import { runSeoEngines } from '../lib/seo-engines-run'

let failed = 0
function check(label: string, ok: boolean, extra?: string) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` :: ${extra}` : ''}`)
}

const ROOT = join(__dirname, '..')
const LONG_DASH = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const NOW = new Date('2026-10-24T14:00:00.000Z')
const world = (settings: Record<string, string> = {}, tables: Record<string, Row[]> = {}) => {
  const db: Db = { tables: { app_settings: Object.entries(settings).map(([key, value]) => ({ key, value })), ...tables } }
  return { db, admin: fakeAdmin(db) }
}
const rowsOf = (db: Db, t: string) => db.tables[t] ?? []
const setting = (db: Db, key: string) => rowsOf(db, 'app_settings').find((r) => r.key === key)?.value as string | undefined
const logOf = (db: Db): AutoDecision[] => parseDecisions(setting(db, DECISIONS_KEY))

// ---- fixtures ------------------------------------------------------------------------------------------------------
const page = (path: string, type: SeoPage['type'], title: string, extra: Partial<SeoPage> = {}): SeoPage => ({ path, type, title, h1: title, keywords: [], body: '', editable: type === 'blog' || type === 'guide' || type === 'destination', thin: false, ...extra })
const PAGES: SeoPage[] = [
  page('/blog/singles-cruise-tips', 'blog', 'Singles Cruise Tips for First Timers'),
  page('/blog/best-singles-cruises', 'blog', 'Best Singles Cruises'),
  page('/destinations/caribbean', 'destination', 'Caribbean'),
  page('/packages/rhine-7-night', 'package', 'Rhine River Cruise Cologne to Basel'),
  page('/blog/thin-secret', 'blog', 'Secret Hidden Atoll Guide', { thin: true }),
]

const pr = (query: string, path: string, clicks: number, impressions: number, position: number): QueryPageRow => ({ query, path, clicks, impressions, position })

async function main() {
  // ================================================================================================
  // Static facts: files, dashes, routes, wiring, no new cron
  // ================================================================================================
  {
    const files = [
      'lib/seo-pages.ts', 'lib/seo-links.ts', 'lib/gsc-mining.ts', 'lib/cannibalization.ts', 'lib/hub-spoke.ts', 'lib/competitor-scan.ts', 'lib/competitor-tasks.ts',
      'lib/breadcrumb-audit.ts', 'lib/seo-engines-run.ts', 'app/api/admin/seo-engines/route.ts', 'app/api/admin/seo-engines/scan/route.ts', 'app/admin/seo-engines/page.tsx',
      'components/admin/seo-engines-panel.tsx', 'scripts/check-seo-engines.ts',
    ]
    check('files: every new file exists and none contains a long dash', files.every((f) => existsSync(join(ROOT, f))) && files.every((f) => !LONG_DASH.test(read(f))))
    for (const f of ['app/api/admin/seo-engines/route.ts', 'app/api/admin/seo-engines/scan/route.ts']) {
      const handlers = read(f).split(/export async function /).slice(1)
      check(`route ${f}: every handler calls isAuthorized before anything else`, handlers.length >= 1 && handlers.every((h) => /^(GET|POST)\(request: Request\) \{\s*\n\s*if \(!isAuthorized\(request\)\)/.test(h)))
    }
    check('route: the main route has a GET and a POST', /export async function GET/.test(read('app/api/admin/seo-engines/route.ts')) && /export async function POST/.test(read('app/api/admin/seo-engines/route.ts')))
    const cron = read('app/api/cron/gsc-snapshot/route.ts')
    check('wiring: the SEO engines run inside the existing gsc-snapshot cron behind a time guard and a try/catch', /runSeoEngines/.test(cron) && /SEO_BUDGET_MS/.test(cron) && /SEO engines skipped/.test(cron) && /seo engines failed/.test(cron))
    const vercel = JSON.parse(read('vercel.json')) as { crons?: { path: string }[] }
    check('wiring: no new cron (vercel.json still has exactly the two existing jobs)', (vercel.crons ?? []).map((c) => c.path).sort().join() === '/api/cron/autopilot,/api/cron/gsc-snapshot')
    check('wiring: the budget is 20 seconds', /SEO_BUDGET_MS = 20_000/.test(read('lib/seo-engines-run.ts')))
    check('wiring: the Blog page header has a small link to /admin/seo-engines', /href="\/admin\/seo-engines"/.test(read('app/admin/blog/page.tsx')))
    check('wiring: the admin nav lists the SEO engines page', /seo-engines/.test(read('lib/admin-nav.ts')))
    const engineSrc = ['lib/gsc-mining.ts', 'lib/cannibalization.ts', 'lib/hub-spoke.ts', 'lib/seo-links.ts', 'lib/seo-engines-run.ts'].map(read).join('\n')
    check('nothing published or approved from the engines: no setTopicStatus, no status approved/published, no AI call', !/setTopicStatus|status:\s*'(approved|published)'|callAnthropic|anthropicText/.test(engineSrc))
    check('the engines use the hard-coded UA and say they cannot read GBP or backlinks', USER_AGENT.includes('TravelFunBizResearchBot') && BOT_NAME === 'TravelFunBizResearchBot' && /Google Business Profile/.test(CANNOT_READ) && /backlinks/.test(CANNOT_READ))
    check('the manual steps name Google Maps About and the free backlink tools', /Google Maps/.test(MANUAL_STEPS.businessProfile.join(' ')) && /About/.test(MANUAL_STEPS.businessProfile.join(' ')) && /Ahrefs Webmaster Tools/.test(MANUAL_STEPS.backlinks.join(' ')) && /Semrush/.test(MANUAL_STEPS.backlinks.join(' ')) && /Ubersuggest/.test(MANUAL_STEPS.backlinks.join(' ')))
    const crumbFiles = ['components/guide-page.tsx', 'app/blog/[slug]/page.tsx', 'app/packages/[slug]/page.tsx', 'app/from/[city]/page.tsx']
    check('breadcrumbs: guide, post, trip and from-city pages all reference breadcrumbs in their source', crumbFiles.every((f) => /readcrumb/i.test(read(f))), crumbFiles.filter((f) => !/readcrumb/i.test(read(f))).join(', '))
  }

  // ================================================================================================
  // 1. Query mining
  // ================================================================================================
  {
    check('match: a query is covered when 60% of its words are in the page words', matchScore('singles cruise', PAGES[0]) === 1 && matchScore('solo female travel safety', PAGES[0]) === 0)
    check('match: the best page is returned above the threshold, none below it', bestPageFor('singles cruises', PAGES)?.page.path !== undefined && bestPageFor('rocket launch tickets', PAGES) === null)
    check('match: a thin (noindex) page never counts as covering a search', bestPageFor('secret hidden atoll', PAGES) === null)
    check('match: a tie goes to a guide, trip or destination over a post', TYPE_PRIORITY.destination > TYPE_PRIORITY.blog && bestPageFor('caribbean', [page('/blog/caribbean-notes', 'blog', 'Caribbean'), PAGES[2]])?.page.type === 'destination')

    const qs: QueryRow[] = [
      { query: 'solo female travel safety tips', clicks: 0, impressions: 80, position: 12 },
      { query: 'solo female travel safety', clicks: 0, impressions: 30, position: 21 },
      { query: 'what to pack for alaska', clicks: 4, impressions: 500, position: 3 },
      { query: 'best time to visit tahiti', clicks: 0, impressions: 40, position: 25 },
      { query: 'cruise vs all inclusive resort', clicks: 0, impressions: 25, position: 40 },
      { query: 'things to do in cozumel', clicks: 0, impressions: 60, position: 15 },
      { query: 'cruises from toronto', clicks: 0, impressions: 22, position: 28 },
      { query: 'singles cruise', clicks: 1, impressions: 90, position: 14 },
      { query: 'tiny search nobody does', clicks: 0, impressions: 4, position: 9 },
      { query: 'caribbean', clicks: 2, impressions: 300, position: 6 },
    ]
    const props = findOpportunities(qs, PAGES)
    const names = props.map((p) => p.primary)
    check('opportunities: a search a page already covers is not an opportunity', !names.includes('singles cruise') && !names.includes('caribbean'))
    check('opportunities: a search under 5 impressions is left out', !names.includes('tiny search nobody does'))
    check('opportunities: related searches become ONE topic (the safety pair)', props.filter((p) => /solo female/.test(p.primary)).length === 1 && (props.find((p) => /solo female/.test(p.primary))?.queries.length ?? 0) === 2)
    check('opportunities: striking distance (position 8 to 30) comes before bigger impressions at position 3', names.indexOf('solo female travel safety tips') < names.indexOf('what to pack for alaska') && props.find((p) => p.primary === 'what to pack for alaska')?.striking === false)
    check('opportunities: the topic carries total impressions and evidence in plain words', props.find((p) => /solo female/.test(p.primary))?.impressions === 110 && /110 times/.test(props.find((p) => /solo female/.test(p.primary))?.evidence ?? ''))
    check('page type: best-time, compare, from-city, guide and blog are told apart', proposalPageType('best time to visit tahiti') === 'best-time' && proposalPageType('cruise vs all inclusive resort') === 'compare' && proposalPageType('cruises from toronto') === 'from-city' && proposalPageType('things to do in cozumel') === 'guide' && proposalPageType('solo female travel safety tips') === 'blog')
    check('page type: each proposal states its best page type', props.find((p) => p.primary === 'best time to visit tahiti')?.pageType === 'best-time' && props.find((p) => p.primary === 'things to do in cozumel')?.pageType === 'guide')
    check('safe for the queue: only blog topics with 10+ impressions and a clear topic', props.find((p) => /solo female/.test(p.primary))?.safeForQueue === true && props.filter((p) => p.pageType !== 'blog').every((p) => !p.safeForQueue) && MIN_QUEUE_IMPRESSIONS === 10)

    const pairs: QueryPageRow[] = [
      pr('singles cruise', '/blog/singles-cruise-tips', 1, 90, 14),
      pr('singles cruise deals', '/blog/singles-cruise-tips', 0, 40, 9),
      pr('best singles cruises', '/blog/best-singles-cruises', 0, 12, 8),
      pr('caribbean', '/destinations/caribbean', 2, 300, 6),
      pr('caribbean cruise', '/destinations/caribbean', 0, 8, 12),
      pr('rhine cruise', '/packages/rhine-7-night', 0, 50, 19),
      pr('rhine cruise', '/blog/not-a-page', 0, 50, 15),
      pr('old thing', '/blog/best-singles-cruises', 0, 30, 45),
    ]
    const refresh = strikingRefreshTargets(pairs, PAGES)
    check('refresh: our pages at position 8 to 20 with 10+ impressions, most impressions first', refresh.map((r) => `${r.path}|${r.query}`).join() === '/blog/singles-cruise-tips|singles cruise,/packages/rhine-7-night|rhine cruise,/blog/best-singles-cruises|best singles cruises', refresh.map((r) => r.path).join())
    check('refresh: position 6, under 10 impressions, position 45 and pages that do not exist are left out', !refresh.some((r) => r.query === 'caribbean' || r.query === 'caribbean cruise' || r.query === 'old thing' || r.path === '/blog/not-a-page'))
    const rows = queryRowsFromPairs(pairs)
    check('rows: query + page rows add up per search (impression-weighted position)', rows.find((r) => r.query === 'rhine cruise')?.impressions === 100 && Math.abs((rows.find((r) => r.query === 'rhine cruise')?.position ?? 0) - 17) < 0.01)

    // pushing to the topic queue
    const safeQs: QueryRow[] = [
      'solo female travel safety tips', 'how to avoid seasickness on a cruise', 'travelling with elderly parents advice', 'how to tip the crew', 'passport rules for kids abroad',
    ].map((q, i) => ({ query: q, clicks: 0, impressions: 60 - i * 5, position: 14 + i }))
    const w = world({}, { blog_topic_queue: [{ id: 'q-old', keyword: 'how to tip the crew on cruise', status: 'rejected' }], posts: [{ slug: 'old-post', title: 'Unrelated Old Post About Greece', primary_keyword: 'greece trip', secondary_keywords: [], publish_date: '2026-01-01' }] })
    const proposals = findOpportunities(safeQs, PAGES)
    const pushed = await pushSafeTopics(w.admin, proposals, NOW)
    const queue = rowsOf(w.db, 'blog_topic_queue')
    check(`push: at most ${TOPICS_PUSHED_PER_DAY} topics a day`, pushed.pushed.length === 3 && queue.length === 4)
    check('push: topics are only ever "suggested", never approved or written', queue.filter((r) => r.id !== 'q-old').every((r) => r.status === 'suggested') && queue.filter((r) => r.id !== 'q-old').every((r) => !r.used_slug))
    check('push: a duplicate of a queued (even rejected) idea is skipped', !queue.some((r) => r.keyword === 'how to tip the crew'))
    check('push: each topic comes from a real search with its numbers as the reason, no long dash', queue.filter((r) => r.id !== 'q-old').every((r) => /Google showed us/.test(String(r.why)) && !LONG_DASH.test(String(r.angle) + String(r.why))))
    const log = logOf(w.db)
    check('push: every push is one line in the decisions log with an Undo that turns the topic down', log.length === 3 && log.every((e) => e.policy === 'seo_topics' && e.undo?.kind === 'topic-withdraw'))
    const pushedAgain = await pushSafeTopics(w.admin, proposals, NOW)
    check('push: the daily cap holds across a second run the same day', pushedAgain.pushed.length === 0 && /limit/.test(pushedAgain.note), pushedAgain.note)
    const undone = await undoAutoDecision(w.admin, log[0])
    check('push: Undo withdraws the topic (rejected) and it stays out for good', undone.ok && rowsOf(w.db, 'blog_topic_queue').find((r) => r.id === log[0].undo?.ref)?.status === 'rejected')
    const w2 = world({ automation_paused: 'true' }, {})
    check('push: nothing happens while Pause all automation is on', (await pushSafeTopics(w2.admin, proposals, NOW)).pushed.length === 0 && rowsOf(w2.db, 'blog_topic_queue').length === 0)
    const w3 = world({ auto_policy_seo_topics: 'off' }, {})
    check('push: its own switch turns it off', (await pushSafeTopics(w3.admin, proposals, NOW)).pushed.length === 0)
    check('push: a proposal duplicating an existing post title is blocked', !!proposalBlockReason(proposals[0], [], [{ slug: 's', title: proposals[0].primary }]))
    const w4 = world({}, {})
    const m = await runMining(w4.admin, { pairs: [], stored: safeQs, pages: PAGES }, NOW)
    check('mining: falls back to the stored snapshot, stores a bounded result, and says the refresh list needs the live report', m.state.source === 'stored' && m.state.proposals.length > 0 && m.state.refresh.length === 0 && /saved daily snapshot/.test(m.state.note) && !!setting(w4.db, 'seo_mining_state'))
    const w5 = world({}, {})
    const m5 = await runMining(w5.admin, { pairs: [], stored: [], pages: PAGES }, NOW)
    check('mining: with no Search Console rows it fails open with a plain note', m5.state.source === 'none' && /no rows/.test(m5.state.note))
  }

  // ================================================================================================
  // 2. Cannibalisation
  // ================================================================================================
  {
    const rows: QueryPageRow[] = [
      pr('singles cruise', '/blog/singles-cruise-tips', 3, 200, 6),
      pr('singles cruise', '/blog/best-singles-cruises', 3, 120, 9),
      pr('singles cruise', '/destinations/caribbean', 0, 15, 30),
      pr('singles cruise', '/packages/rhine-7-night', 0, 9, 40),
      pr('rhine cruise', '/packages/rhine-7-night', 1, 40, 8),
      pr('rhine cruise', '/blog/singles-cruise-tips', 1, 40, 12),
      pr('caribbean cruise', '/destinations/caribbean', 0, 50, 10),
      pr('caribbean cruise', '/blog/best-singles-cruises', 0, 9, 10),
      pr('single page query', '/blog/singles-cruise-tips', 5, 500, 2),
      pr('home query', '/', 3, 80, 4),
      pr('home query', '/blog/singles-cruise-tips', 3, 80, 4),
      pr('thin query', '/blog/thin-secret', 3, 80, 4),
      pr('thin query', '/blog/best-singles-cruises', 3, 80, 4),
    ]
    const f = groupCannibalised(rows, PAGES)
    const by = new Map(f.map((x) => [x.query, x]))
    check(`threshold: both pages need ${MIN_IMPRESSIONS_EACH}+ impressions (9 does not count)`, by.has('singles cruise') && by.get('singles cruise')?.secondaries.length === 2 && !by.has('caribbean cruise'))
    check('threshold: one page alone, the home page and a thin page never make a finding', !by.has('single page query') && !by.has('home query') && !by.has('thin query'))
    check('primary: most clicks wins, then impressions (singles cruise)', by.get('singles cruise')?.primary.path === '/blog/singles-cruise-tips')
    check('primary: equal clicks go to impressions, equal impressions go to a trip over a post', pickPrimary([{ path: '/blog/a', type: 'blog', clicks: 1, impressions: 50, position: 5 }, { path: '/blog/b', type: 'blog', clicks: 1, impressions: 60, position: 5 }])?.path === '/blog/b' && by.get('rhine cruise')?.primary.path === '/packages/rhine-7-night')
    check('primary: a guide beats a blog post on a full tie', comparePrimary({ path: '/blog/a', type: 'blog', clicks: 1, impressions: 50, position: 5 }, { path: '/hotels/a', type: 'guide', clicks: 1, impressions: 50, position: 5 }) > 0)
    check('findings: biggest first, bounded, and a suggestion for the owner is always present (differentiate, merge, canonical)', f[0].query === 'singles cruise' && f.length <= 30 && /Differentiate/.test(f[0].suggestions.join(' ')) && /Merge/.test(f[0].suggestions.join(' ')) && /Canonical/.test(f[0].suggestions.join(' ')))
    check('suggestions are only ever suggestions: they say only a person should merge or set a canonical', /Only a person/.test(f[0].suggestions.join(' ')))

    const wishes = cannibalWishes(f)
    check('wishes: each secondary links to its primary using the search as the words', wishes.some((x) => x.fromPath === '/blog/best-singles-cruises' && x.toPath === '/blog/singles-cruise-tips' && x.anchor === 'singles cruise' && x.kind === 'cannibalisation'))
    check('wishes: no wish ever points a page at itself', wishes.every((x) => x.fromPath !== x.toPath))
  }

  // ================================================================================================
  // 3. Linking: caps, rules, Undo
  // ================================================================================================
  {
    check('anchor: a search is made safe (no brackets, dashes or symbols)', cleanAnchor('[best] singles' + String.fromCharCode(0x2014) + 'cruise!!') === 'best singles cruise')
    const b1 = 'Intro text about travel.\n\nA singles cruise is a sailing for people travelling alone.\n\nMore text.'
    const r1 = insertContextLink(b1, 'singles cruise', '/blog/target')
    check('insert: the words in an ordinary sentence become the link (inline)', r1?.how === 'inline' && r1.body.includes('A [singles cruise](/blog/target) is a sailing'))
    const b2 = 'Nothing relevant here.\n\n---\n\nFooter'
    const r2 = insertContextLink(b2, 'singles cruise', '/blog/target')
    check('insert: otherwise one Related reading line is added before the closing rule', r2?.how === 'related-line' && /Related reading: \[singles cruise\]\(\/blog\/target\)\./.test(r2.body) && r2.body.indexOf('Related reading') < r2.body.indexOf('---'))
    check('insert: a page that already links to the target gets nothing', insertContextLink('See [this](/blog/target) page.', 'this', '/blog/target') === null)
    check('insert: words that are already inside a link are never re-linked', !(insertContextLink('Read [singles cruise tips](/blog/other) now.\n\nOther.', 'singles cruise', '/blog/target')?.body ?? '').includes('[[singles') && (insertContextLink('Read [singles cruise tips](/blog/other) now.\n\nOther.', 'singles cruise', '/blog/target')?.how === 'related-line'))
    check('insert: headings are never turned into links', !(insertContextLink('## Singles cruise\n\nPlain.', 'singles cruise', '/blog/target')?.body ?? '').includes('## [Singles'))
    check('insert: the change only ever adds a link (the text without link syntax is the same plus at most the related line)', (r1?.body ?? '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') === b1)
    check('insert: no long dash is ever added', !LONG_DASH.test((r1?.body ?? '') + (r2?.body ?? '')))

    const withBody = (p: SeoPage, body: string): SeoPage => ({ ...p, body })
    const secs = ['a', 'b', 'c', 'd', 'e'].map((k) => page(`/blog/sec-${k}`, 'blog', `Secondary ${k}`, { body: `Text.\n\nOur singles cruise guide.\n\nMore.` }))
    const prim = page('/blog/primary', 'blog', 'Primary singles')
    const manyWishes: LinkWish[] = secs.map((s) => ({ fromPath: s.path, toPath: prim.path, anchor: 'singles cruise', kind: 'cannibalisation', why: 'test' }))
    const plan = planLinkAdds([...manyWishes, { fromPath: prim.path, toPath: prim.path, anchor: 'x y', kind: 'cannibalisation', why: 't' }, { ...manyWishes[0], fromPath: secs[0].path }], [...secs, withBody(prim, 'Body')], 10)
    check('plan: a page is never linked to itself and gets at most one link per run', plan.adds.every((a) => a.from.path !== a.to.path) && new Set(plan.adds.map((a) => a.from.path)).size === plan.adds.length)
    check(`plan: at most the cap of pages (${LINKS_PER_DAY}) when the cap is ${LINKS_PER_DAY}`, planLinkAdds(manyWishes, [...secs, prim], LINKS_PER_DAY).adds.length === LINKS_PER_DAY)
    const trip = page('/packages/t', 'package', 'Trip', { body: 'Singles cruise trip text.', editable: false })
    const thin = page('/blog/thin', 'blog', 'Thin', { body: 'singles cruise', thin: true })
    const nb = page('/blog/nobody', 'blog', 'No body')
    const rules = planLinkAdds(
      [
        { fromPath: trip.path, toPath: prim.path, anchor: 'singles cruise', kind: 'cannibalisation', why: '' },
        { fromPath: thin.path, toPath: prim.path, anchor: 'singles cruise', kind: 'cannibalisation', why: '' },
        { fromPath: nb.path, toPath: prim.path, anchor: 'singles cruise', kind: 'cannibalisation', why: '' },
        { fromPath: secs[0].path, toPath: '/blog/not-published', anchor: 'singles cruise', kind: 'cannibalisation', why: '' },
        { fromPath: secs[0].path, toPath: thin.path, anchor: 'singles cruise', kind: 'cannibalisation', why: '' },
      ],
      [trip, thin, nb, secs[0], prim],
      5,
    )
    check('plan: trips, safe (thin) pages, pages without text, unpublished and thin targets are never edited or linked', rules.adds.length === 0 && rules.skipped.length === 5)

    // applying: log first, edit only published pages, Undo, daily cap
    const posts: Row[] = [
      { id: 'p-primary', slug: 'primary', title: 'Primary singles', status: 'published', body: 'Primary body.', primary_keyword: 'singles', secondary_keywords: [], tags: [], updated_at: '2026-10-01T00:00:00.000Z' },
      ...['a', 'b', 'c', 'd', 'e'].map((k) => ({ id: `p-${k}`, slug: `sec-${k}`, title: `Secondary ${k}`, status: 'published', body: `Text.\n\nOur singles cruise guide.\n\nMore.`, primary_keyword: 'x', secondary_keywords: [], tags: [], updated_at: '2026-10-01T00:00:00.000Z' })),
      { id: 'p-draft', slug: 'sec-draft', title: 'Draft one', status: 'draft', body: 'Our singles cruise guide.\n\nMore.', primary_keyword: 'x', secondary_keywords: [], tags: [] },
    ]
    const w = world({}, { posts: posts.map((p) => ({ ...p })), content_edits: [], guides: [], travel_packages: [] })
    const pages = (await loadSeoPages(w.admin, { withBodies: true })) as SeoPage[]
    check('loader: published posts become pages with their text; a draft is not a page', pages.length === 6 && !pages.some((p) => p.path === '/blog/sec-draft') && pages.find((p) => p.path === '/blog/sec-a')?.body.includes('singles cruise') === true)
    const ws: LinkWish[] = [...['a', 'b', 'c', 'd', 'e'].map((k) => ({ fromPath: `/blog/sec-${k}`, toPath: '/blog/primary', anchor: 'singles cruise', kind: 'cannibalisation' as const, why: `Both pages show for "singles cruise".` })), { fromPath: '/blog/sec-draft', toPath: '/blog/primary', anchor: 'singles cruise', kind: 'cannibalisation' as const, why: '' }]
    const run1 = await applyLinkAdds(w.admin, ws, pages, NOW)
    check(`apply: at most ${LINKS_PER_DAY} pages are changed in a day`, run1.added === LINKS_PER_DAY && rowsOf(w.db, 'posts').filter((p) => String(p.body).includes('](/blog/primary)')).length === LINKS_PER_DAY, JSON.stringify(run1.notes))
    const edits = rowsOf(w.db, 'content_edits')
    check('apply: every change is one audit row (content_edits) with the original text as "before" and the new text as "after"', edits.length === 3 && edits.every((e) => e.field === 'links' && e.method === 'links' && String(e.before) !== String(e.after) && String(e.after).includes('](/blog/primary)') && !String(e.before).includes('](/blog/primary)')))
    check('apply: the link sits inside an existing sentence here and the draft was never touched', rowsOf(w.db, 'posts').find((p) => p.id === 'p-a')?.body === 'Text.\n\nOur [singles cruise](/blog/primary) guide.\n\nMore.' && rowsOf(w.db, 'posts').find((p) => p.id === 'p-draft')?.body === 'Our singles cruise guide.\n\nMore.')
    const log = logOf(w.db)
    check('apply: each change is a line in the decisions log with a revert-edit Undo pointing at the audit row', log.length === 3 && log.every((e) => e.policy === 'seo_links' && e.undo?.kind === 'revert-edit' && edits.some((x) => x.id === e.undo?.ref)))
    const run2 = await applyLinkAdds(w.admin, ws, pages, NOW)
    check('apply: a second run the same day adds nothing (the daily cap is counted from the log)', run2.added === 0 && /limit/.test(run2.blockedBecause ?? ''), run2.blockedBecause)
    const undo = await undoAutoDecision(w.admin, log[0])
    const reverted = rowsOf(w.db, 'posts').find((p) => p.slug === log[0].subject.replace('/blog/', ''))
    check('undo: the page text is back exactly as it was and the audit row is stamped reverted', undo.ok && reverted?.body === 'Text.\n\nOur singles cruise guide.\n\nMore.' && edits.find((e) => e.id === log[0].undo?.ref)?.reverted_at != null, undo.message)
    check('undo: the decision is marked undone and cannot be undone twice', (await readDecisions(w.admin)).find((e) => e.subject === log[0].subject)?.undone_at != null && !(await undoAutoDecision(w.admin, log[0])).ok)

    const clone = (rows: Row[]): Row[] => rows.map((r) => ({ ...r }))
    const wp = world({ automation_paused: 'true' }, { posts: clone(posts), content_edits: [] })
    check('apply: while Pause all automation is on, nothing changes', (await applyLinkAdds(wp.admin, ws, pages, NOW)).added === 0)
    const wf = world({}, { posts: clone(posts), content_edits: [] })
    wf.db.failWrites = { content_edits: 'disk full' }
    const failedRun = await applyLinkAdds(wf.admin, ws, pages, NOW)
    check('apply: if the audit log cannot be written, no page is changed', failedRun.added === 0 && rowsOf(wf.db, 'posts').every((p) => !String(p.body).includes('](/blog/primary)')))
    const stale: Row[] = clone(posts)
    const ws2 = world({}, { posts: stale, content_edits: [] })
    ws2.db.rejectUpdate = () => 'row changed'
    const rej = await applyLinkAdds(ws2.admin, ws, pages, NOW)
    check('apply: if the page cannot be written the audit row is taken back out', rej.added === 0 && rowsOf(ws2.db, 'content_edits').length === 0)

    // a guide
    const guideBody = 'Opening paragraph about the islands.\n\n## Where to stay\n\nWe like a good singles cruise out of the port.\n\n## Getting there\n\nBy ship.'
    const wg = world({}, { guides: [{ id: 'g1', kind: 'destinations', slug: 'caribbean', name: 'Caribbean', summary: 'Opening paragraph about the islands.', body: '## Where to stay\n\nWe like a good singles cruise out of the port.\n\n## Getting there\n\nBy ship.', status: 'published', quality_notes: null, sections: [] }], posts: [{ id: 'pp', slug: 'primary', title: 'Primary singles', status: 'published', body: 'x', primary_keyword: '', secondary_keywords: [], tags: [] }], content_edits: [], travel_packages: [] })
    const gp = (await loadSeoPages(wg.admin, { withBodies: true })) as SeoPage[]
    const gr = await applyLinkAdds(wg.admin, [{ fromPath: '/destinations/caribbean', toPath: '/blog/primary', anchor: 'singles cruise', kind: 'hub-to-spoke', why: 'test' }], gp, NOW)
    const gRow = rowsOf(wg.db, 'guides')[0]
    check('apply: a published guide is edited too, its structure kept (summary and sections)', gr.added === 1 && String(gRow.body).includes('[singles cruise](/blog/primary)') && gRow.summary === 'Opening paragraph about the islands.' && Array.isArray(gRow.sections) && (gRow.sections as unknown[]).length === 2, JSON.stringify(gr.notes) + guideBody.length)
    check('caps: the link and topic policies each have a cap of 3 a day', POLICY_CAPS.seo_links === 3 && POLICY_CAPS.seo_topics === 3)
  }

  // ================================================================================================
  // 4. Hub and spoke
  // ================================================================================================
  {
    const hubPage = page('/destinations/alaska', 'destination', 'Alaska Cruises', { body: 'Alaska overview with [one](/blog/alaska-packing).' })
    const s1 = page('/blog/alaska-packing', 'blog', 'What to Pack for an Alaska Cruise', { body: 'Packing for Alaska. No link up.' })
    const s2 = page('/blog/alaska-glaciers', 'blog', 'Alaska Cruise Glaciers From the Ship', { body: 'Glaciers in Alaska. Back to [Alaska cruises](/destinations/alaska).' })
    const s3 = page('/blog/alaska-bears', 'blog', 'Alaska Cruise Bear Watching Tours', { body: 'Bears in Alaska.' })
    const s4 = page('/blog/alaska-weather', 'blog', 'Alaska Cruise Weather by Month', { body: '' })
    const other = page('/blog/greece-sailing', 'blog', 'Greek Islands Sailing', { body: 'Greece.' })
    const pgs = [hubPage, s1, s2, s3, s4, other]
    const queries: QueryRow[] = [
      { query: 'alaska cruise', clicks: 10, impressions: 400, position: 5 },
      { query: 'alaska cruises', clicks: 1, impressions: 100, position: 7 },
      { query: 'greek islands sailing', clicks: 0, impressions: 50, position: 20 },
    ]
    const clusters = clustersFromQueries(queries)
    check('clusters: near-duplicate searches are one topic', clusters.length === 2 && clusters[0].members.length === 2 && clusters[0].primary === 'alaska cruise')
    const metrics = new Map([['/destinations/alaska', { clicks: 10, impressions: 400 }], ['/blog/alaska-packing', { clicks: 1, impressions: 90 }]])
    const map = buildHubSpokeMap(clusters, pgs, metrics)
    const e = map[0]
    check('hub: the strongest existing page (clicks, then impressions) is the hub', e?.hub.path === '/destinations/alaska' && pickHub([s1, hubPage], metrics)?.path === '/destinations/alaska')
    check('spokes: the other pages on the topic; a page of another topic is not a spoke; a topic with one page is not mapped', e.spokes.length === 4 && !e.spokes.some((s) => s.path === other.path) && map.length === 1)
    check('missing links: hub to spoke (hub text known) and spoke to hub (spoke text known) are reported', e.missingHubToSpoke.sort().join() === '/blog/alaska-bears,/blog/alaska-glaciers,/blog/alaska-weather' && e.missingSpokeToHub.sort().join() === '/blog/alaska-bears,/blog/alaska-packing')
    check('hub: with three or more spokes under a post hub a guide is proposed (not here: the hub is a destination page)', e.proposedHub === null && buildHubSpokeMap(clusters, [s1, s2, s3, s4], new Map())[0]?.proposedHub?.pageType === 'guide')
    const hw = hubSpokeWishes(map)
    check('wishes: spoke to hub first, then hub to spoke, with the cluster search as anchor for the hub link', hw[0].kind === 'spoke-to-hub' && hw[0].toPath === '/destinations/alaska' && hw[0].anchor === 'alaska cruise' && hw.findIndex((x) => x.kind === 'hub-to-spoke') > hw.reduce((a, x, i) => (x.kind === 'spoke-to-hub' ? i : a), -1))
    const plan = planLinkAdds(hw, pgs, 3)
    check('wishes: under the same cap rules (3 pages, never itself); a spoke without loaded text is skipped, not guessed', plan.adds.length <= 3 && plan.adds.every((a) => a.from.path !== a.to.path) && !plan.adds.some((a) => a.from.path === '/blog/alaska-weather'))
  }

  // ================================================================================================
  // 5. Competitor scanner (fake web)
  // ================================================================================================
  {
    check('own domain: refused with and without www, as a subdomain, and the .com', ['https://travelfunbiz.ca', 'https://www.travelfunbiz.ca/blog', 'travelfunbiz.com', 'https://blog.travelfunbiz.ca'].every((u) => !validateCompetitorUrl(u).ok))
    check('urls: http, passwords, ports, IP addresses, localhost and one-word names are refused', ['http://rivalcruises.com', 'https://user:pw@rivalcruises.com', 'https://rivalcruises.com:8443', 'https://192.168.0.1', 'https://localhost', 'https://intranet', 'ftp://rivalcruises.com', ''].every((u) => !validateCompetitorUrl(u).ok))
    const ok = validateCompetitorUrl('https://www.RivalCruises.com/some/path?x=1')
    check('urls: a normal https address is accepted and reduced to its origin', ok.ok && ok.origin === 'https://www.rivalcruises.com' && ok.host === 'rivalcruises.com')
    let list: string[] = []
    for (const u of ['a-agency.com', 'b-agency.com', 'c-agency.com', 'd-agency.com', 'e-agency.com']) {
      const r = addCompetitor(list, u)
      if (r.ok) list = r.list
    }
    const sixth = addCompetitor(list, 'f-agency.com')
    check(`list: at most ${MAX_COMPETITORS} competitors; a duplicate and the own domain are refused; garbage in storage is dropped`, list.length === 5 && !sixth.ok && !addCompetitor(['https://a-agency.com'], 'https://www.a-agency.com').ok && parseCompetitorList(JSON.stringify(['https://good-one.com', 'http://bad.com', 'https://travelfunbiz.ca', 42, 'https://good-one.com'])).join() === 'https://good-one.com')

    const rb = parseRobots('User-agent: *\nDisallow: /private/\nAllow: /private/public\nCrawl-delay: 2\nSitemap: https://rivalcruises.com/sm.xml\n\nUser-agent: TravelFunBizResearchBot\nDisallow: /no-bots/\n')
    check('robots: the group naming our bot wins over *, longest rule wins, sitemap is read', !robotsAllows(rb, '/no-bots/page') && robotsAllows(rb, '/private/page') && rb.sitemaps[0] === 'https://rivalcruises.com/sm.xml')
    const star = parseRobots('User-agent: *\nDisallow: /private/\nAllow: /private/public\nCrawl-delay: 2\n')
    check('robots: * group: disallow, allow overrides when longer, crawl delay read, wildcard and end anchor work', !robotsAllows(star, '/private/x') && robotsAllows(star, '/private/public/x') && star.crawlDelaySec === 2 && !robotsAllows(parseRobots('User-agent: *\nDisallow: /*.pdf$'), '/a/b.pdf') && robotsAllows(parseRobots('User-agent: *\nDisallow:'), '/anything'))

    // the fake web
    const SECRET_SENTENCE = 'Zanzibar quokka paragraphs must never be copied into our storage under any circumstance whatsoever'
    const htmlPage = (title: string, h1: string, extra = '', nav = '') =>
      `<!doctype html><html><head><title>${title}</title><meta name="description" content="${SECRET_SENTENCE} meta"><script type="application/ld+json">{"@context":"https://schema.org","@type":"TravelAgency","name":"Rival"}</script></head><body><nav><a href="/cruises">Luxury Cruises</a> ${nav}</nav><h1>${h1}</h1><h2>Why sail with us</h2><p>${SECRET_SENTENCE}. Alaska singles cruise sailings with great cabins. Alaska singles cruise sailings with great cabins.</p>${extra}<a href="/x">internal</a><a href="https://elsewhere.com/y">external</a></body></html>`
    const sitemapUrls = Array.from({ length: 70 }, (_, i) => `https://rivalcruises.com/tours/trip-${i}`)
    const web = new Map<string, FetchResult>()
    const put = (url: string, text: string, contentType = 'text/html; charset=utf-8', status = 200) => web.set(url, { status, contentType, text, finalUrl: url })
    put('https://rivalcruises.com/robots.txt', 'User-agent: *\nDisallow: /private/\nSitemap: https://rivalcruises.com/sitemap.xml\n', 'text/plain')
    put('https://rivalcruises.com/sitemap.xml', `<urlset>${['/', '/private/secret', '/files/brochure.pdf', '/reviews', '/deals', '/blog/alaska-tips', ...sitemapUrls.map((u) => new URL(u).pathname)].map((p) => `<url><loc>https://rivalcruises.com${p}</loc></url>`).join('')}<url><loc>https://other-site.com/steal</loc></url></urlset>`, 'application/xml')
    put('https://rivalcruises.com/', htmlPage('Rival Cruises | Alaska Singles Cruise and Viking River Cruises', 'Alaska Singles Cruise', '', '<a href="/viking">Viking</a>'))
    put('https://rivalcruises.com/reviews', htmlPage('Guest Reviews', 'What guests say'))
    put('https://rivalcruises.com/deals', htmlPage('Cruise Deals', 'Hot offers'))
    put('https://rivalcruises.com/blog/alaska-tips', htmlPage('Alaska Singles Cruise Tips', 'Alaska tips'))
    put('https://rivalcruises.com/private/secret', htmlPage('Secret', 'Secret'))
    put('https://rivalcruises.com/files/brochure.pdf', '%PDF', 'application/pdf')
    for (const u of sitemapUrls) put(u, htmlPage(`Greek Island Sailing Holiday ${u.slice(-2)}`, 'Greek island sailing holiday'))
    put('https://other-site.com/steal', htmlPage('Stolen', 'Stolen'))

    let clock = 0
    const calls: { url: string; at: number; ua: string }[] = []
    const fetcher: CompetitorFetch = async (url, init) => {
      clock += 40
      calls.push({ url, at: clock, ua: init.headers['User-Agent'] })
      const hit = web.get(url)
      return hit ?? { status: 404, contentType: 'text/html', text: '', finalUrl: url }
    }
    const sleep = async (ms: number) => {
      clock += ms
    }
    const realFetch = globalThis.fetch
    globalThis.fetch = (() => {
      throw new Error('real network is not allowed in this check')
    }) as typeof fetch
    const res = await scanCompetitor('https://rivalcruises.com', { fetch: fetcher, sleep, now: () => clock })
    check(`scan: at most ${MAX_PAGES_PER_COMPETITOR} pages per competitor per run`, res.pagesScanned <= MAX_PAGES_PER_COMPETITOR && res.pagesScanned === 40, String(res.pagesScanned))
    check('scan: robots.txt is read first and a disallowed page is never requested', calls[0].url.endsWith('/robots.txt') && !calls.some((c) => c.url.includes('/private/')) && res.blockedByRobots >= 1)
    check('scan: only the competitor host is requested (the other site in the sitemap is ignored)', calls.every((c) => new URL(c.url).hostname === 'rivalcruises.com'))
    check('scan: non-HTML files are never requested', !calls.some((c) => c.url.endsWith('.pdf')))
    check('scan: every request names the research bot', calls.every((c) => c.ua === USER_AGENT && c.ua.includes('TravelFunBizResearchBot')))
    check('scan: no two requests are closer than one second', calls.slice(1).every((c, i) => c.at - calls[i].at >= 1000))
    check('scan: the home page is first, and the page types are worked out (reviews, deals, tours)', res.pages[0].path === '/' && res.pageTypes.some((t) => t.type === 'reviews') && res.pageTypes.some((t) => t.type === 'deals') && res.pageTypes.some((t) => t.type === 'tour-package'))
    const stored = JSON.stringify(res)
    check('scan: NEVER copies their text (no paragraph, no meta description is stored)', !stored.includes('Zanzibar') && !stored.includes('quokka') && res.pages.every((p) => p.title.length <= 120 && p.h1.length <= 100 && p.phrases.every((ph) => ph.split(' ').length <= 3)))
    check('scan: it keeps phrases (1 to 3 words) with counts, word counts, link counts and schema types', res.topPhrases.some((p) => p.phrase.includes('alaska singles cruise') || p.phrase === 'alaska singles') && res.pages[0].wordCount > 5 && res.pages[0].internalLinks === 3 && res.pages[0].schemaTypes.includes('TravelAgency') && res.pages[0].metaDescriptionLength > 10)
    check('scan: menu labels are kept for the service gap', res.navLabels.includes('luxury cruises') && res.navLabels.includes('viking'))

    const small = await scanCompetitor('https://rivalcruises.com', { fetch: fetcher, sleep, now: () => clock, maxPages: 5 })
    check('scan: a smaller page limit is obeyed', small.pagesScanned === 5)

    // a robots.txt that bans us, a redirect off-site, a dead site
    const banned = new Map(web)
    banned.set('https://rivalcruises.com/robots.txt', { status: 200, contentType: 'text/plain', text: 'User-agent: TravelFunBizResearchBot\nDisallow: /\n', finalUrl: 'https://rivalcruises.com/robots.txt' })
    const ban = await scanCompetitor('https://rivalcruises.com', { fetch: async (u, i) => banned.get(u) ?? fetcher(u, i), sleep, now: () => clock })
    check('scan: a robots.txt that bans our bot means nothing is scanned', ban.pagesScanned === 0 && /stay out/.test(ban.notes.join(' ')))
    const redirected = await scanCompetitor('https://rivalcruises.com', { fetch: async (u) => ({ status: 200, contentType: 'text/html', text: '<html></html>', finalUrl: u.replace('rivalcruises.com', 'evil.example.org') }), sleep, now: () => clock })
    check('scan: a redirect to another website is ignored', redirected.pagesScanned === 0)
    const dead = await scanCompetitor('https://rivalcruises.com', { fetch: async () => { throw new Error('timeout') }, sleep, now: () => clock })
    check('scan: a site that cannot be reached fails open with a note (robots.txt unreadable means nothing is scanned)', dead.pagesScanned === 0 && dead.notes.length > 0)
    const own = await scanCompetitor('https://travelfunbiz.ca', { fetch: fetcher, sleep, now: () => clock })
    check('scan: our own domain is refused even if it reaches the scanner', own.pagesScanned === 0 && /own website/.test(own.notes.join(' ')))
    const late = await scanCompetitor('https://rivalcruises.com', { fetch: fetcher, sleep, now: () => clock, deadlineMs: clock + 3000 })
    check('scan: the time budget stops it early and marks the scan partial so it carries on the next day', late.complete === false && late.pagesScanned < 40)
    const cont = await scanCompetitor('https://rivalcruises.com', { fetch: fetcher, sleep, now: () => clock, previous: late })
    check('scan: a partial scan is continued, not restarted (earlier pages are kept, not read again)', cont.pagesScanned > late.pagesScanned && cont.pages.slice(0, late.pagesScanned).map((p) => p.path).join() === late.pages.map((p) => p.path).join())

    // sampling
    const s = samplePages(sitemapUrls, 'https://rivalcruises.com', 40)
    check('sampling: 70 addresses become 40, home first, spread across the list', s.length === 40 && s[0] === 'https://rivalcruises.com/' && s[1] === sitemapUrls[0] && s[39] !== sitemapUrls[38])

    // analysis helper
    const a = analyzePage('<html><head><title>T</title></head><body><nav><a href="/a">A</a></nav><h1>One</h1><p>word word</p></body></html>', 'https://rivalcruises.com/x/')
    check('analyze: path, h1, and that menu words are not counted as page words', a.path === '/x' && a.h1 === 'One' && a.wordCount === 3)

    // gaps
    const ours: SeoPage[] = [...PAGES]
    const kg = keywordGap(res, ours)
    check('keyword gap: phrases they target in titles that none of our pages cover are listed, covered ones are not', kg.some((k) => /greek island/.test(k.phrase)) && !kg.some((k) => k.phrase === 'singles cruise'))
    check('keyword gap: biggest first and a phrase we already cover (singles cruise) is not a gap', kg[0].theirPages >= kg[kg.length - 1].theirPages && !kg.some((k) => k.phrase === 'singles cruise'))
    const sg = serviceGap(res, ours)
    check('service gap: services in their menu and titles that we do not mention (viking, luxury) are listed; singles and caribbean are ours', sg.some((x) => x.term === 'viking' && x.category === 'cruise line') && sg.some((x) => x.term === 'luxury') && !sg.some((x) => x.term === 'singles'))
    const cg = contentTypeGap(res, ours)
    check('content type gap: page types they have and we do not (reviews, deals); ones we have (blog) are not', cg.some((x) => x.type === 'reviews') && cg.some((x) => x.type === 'deals') && !cg.some((x) => x.type === 'blog'))

    // stored run
    const wc = world({}, {})
    await writeCompetitorList(wc.admin, ['https://rivalcruises.com'])
    const stats = await runCompetitorScan(wc.admin, 'https://rivalcruises.com', ours, { fetch: fetcher, sleep, now: () => clock })
    const st = await readCompetitorState(wc.admin)
    check('stored: the result and its gaps are saved under seo_competitor_state, bounded', !!stats.result && st.competitors['rivalcruises.com']?.gaps.keyword.length > 0 && !!setting(wc.db, COMPETITOR_STATE_KEY) && (setting(wc.db, COMPETITOR_STATE_KEY) ?? '').length < 200_000)
    check('stored: still no copied text in the saved state', !(setting(wc.db, COMPETITOR_STATE_KEY) ?? '').includes('Zanzibar'))
    const state0 = { competitors: {} as Record<string, never> }
    const list2 = ['https://rivalcruises.com', 'https://b-agency.com']
    check('schedule: a never-scanned competitor is due first', pickDueCompetitor(list2, st, NOW) === 'https://b-agency.com' && pickDueCompetitor(list2, state0, NOW) === 'https://rivalcruises.com')
    const fresh = { competitors: { 'rivalcruises.com': { ...(st.competitors['rivalcruises.com'] as object), scannedAt: new Date(NOW.getTime() - 2 * 86_400_000).toISOString(), complete: true } as never } }
    check('schedule: a competitor scanned less than 7 days ago is not due; after 7 days it is', pickDueCompetitor(['https://rivalcruises.com'], fresh, NOW) === null && pickDueCompetitor(['https://rivalcruises.com'], { competitors: { 'rivalcruises.com': { ...(fresh.competitors['rivalcruises.com'] as object), scannedAt: new Date(NOW.getTime() - 8 * 86_400_000).toISOString() } as never } }, NOW) === 'https://rivalcruises.com')

    const tasks = competitorTasks(['https://rivalcruises.com'])
    check('tasks: two manual tasks per competitor (profile categories, backlinks) with the steps; no long dash', tasks.length === 2 && tasks[0].id.startsWith('comp-gbp-') && tasks[1].id.startsWith('comp-backlinks-') && tasks.every((t) => t.steps.length >= 3 && !LONG_DASH.test(JSON.stringify(t))))
    globalThis.fetch = realFetch
  }

  // ================================================================================================
  // 6. Breadcrumbs audit
  // ================================================================================================
  {
    const ld = (n: number) => JSON.stringify({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: Array.from({ length: n }, (_, i) => ({ '@type': 'ListItem', position: i + 1, name: `L${i}` })) })
    check('crumbs: page kinds are told apart', crumbKindOf('/blog/x') === 'post' && crumbKindOf('/packages/x') === 'trip' && crumbKindOf('/from/toronto') === 'from' && crumbKindOf('/hotels/x') === 'guide' && crumbKindOf('/destinations/x') === 'guide' && crumbKindOf('/about') === null)
    check('crumbs: a BreadcrumbList with two items counts, one item or none does not, a broken block is ignored', hasBreadcrumbJsonLd([ld(2)]) && !hasBreadcrumbJsonLd([ld(1)]) && !hasBreadcrumbJsonLd(['{broken', '{"@type":"Article"}']) && hasBreadcrumbJsonLd([JSON.stringify({ '@graph': [JSON.parse(ld(3))] })]))
    check('crumbs: a visible trail is found by its nav label or class', hasVisibleBreadcrumb('<nav aria-label="Breadcrumb"><a>Home</a></nav>') && hasVisibleBreadcrumb('<ol class="breadcrumbs">') && !hasVisibleBreadcrumb('<nav><a>Home</a></nav>'))
    const pages = [
      { path: '/blog/a', jsonLd: [ld(3)], html: '<nav aria-label="breadcrumb"></nav>' },
      { path: '/blog/b', jsonLd: [], html: '<nav aria-label="breadcrumb"></nav>' },
      { path: '/packages/a', jsonLd: [], html: '<p>no trail</p>' },
      { path: '/from/toronto', jsonLd: [ld(2)], html: '<div class="breadcrumb"></div>' },
      { path: '/hotels/x', jsonLd: [] },
      { path: '/privacy', jsonLd: [] },
    ]
    const au = auditBreadcrumbs(pages)
    check('crumbs: pages missing the data are listed per kind and whole missing kinds are named', au.byKind.post.missingJsonLd.join() === '/blog/b' && au.byKind.trip.missingVisible.join() === '/packages/a' && au.missingKinds.some((m) => m.kind === 'trip' && m.what === 'structured data') && au.missingKinds.some((m) => m.kind === 'trip' && m.what === 'visible trail') && au.missingKinds.some((m) => m.kind === 'guide' && m.what === 'structured data') && !au.missingKinds.some((m) => m.kind === 'from'))
    const fnd = breadcrumbFindings(pages, 'https://travelfunbiz.ca')
    check('crumbs: findings are info only, read-only, one per page missing the data', fnd.length === 3 && fnd.every((x) => x.severity === 'info' && x.kind === 'breadcrumb-missing'))
  }

  // ================================================================================================
  // 7. The daily step end to end (fakes only)
  // ================================================================================================
  {
    const posts: Row[] = [
      { id: 'p1', slug: 'singles-cruise-tips', title: 'Singles Cruise Tips for First Timers', status: 'published', body: 'Intro.\n\nEvery singles cruise needs a plan.\n\nEnd.', primary_keyword: 'singles cruise', secondary_keywords: [], tags: [], updated_at: '2026-10-01T00:00:00.000Z' },
      { id: 'p2', slug: 'best-singles-cruises', title: 'Best Singles Cruises', status: 'published', body: 'Intro.\n\nOur favourite singles cruise lines.\n\nEnd.', primary_keyword: 'best singles cruises', secondary_keywords: [], tags: [], updated_at: '2026-10-01T00:00:00.000Z' },
    ]
    const w = world({ seo_competitors: JSON.stringify(['https://rivalcruises.com']) }, { posts, content_edits: [], guides: [], travel_packages: [], blog_topic_queue: [], gsc_rankings: [] })
    const pairs = [
      pr('singles cruise', '/blog/singles-cruise-tips', 5, 200, 6),
      pr('singles cruise', '/blog/best-singles-cruises', 2, 100, 9),
      pr('solo female travel safety tips', '/blog/singles-cruise-tips', 0, 80, 12),
      pr('solo female travel safety', '/blog/singles-cruise-tips', 0, 30, 21),
    ]
    let clock = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = (() => {
      throw new Error('real network is not allowed in this check')
    }) as typeof fetch
    const site = new Map<string, FetchResult>([
      ['https://rivalcruises.com/robots.txt', { status: 200, contentType: 'text/plain', text: 'User-agent: *\nAllow: /\n', finalUrl: 'https://rivalcruises.com/robots.txt' }],
      ['https://rivalcruises.com/', { status: 200, contentType: 'text/html', text: '<html><head><title>Rival Luxury Cruises</title></head><body><h1>Luxury Cruises</h1><a href="/a">a</a></body></html>', finalUrl: 'https://rivalcruises.com/' }],
    ])
    const out = await runSeoEngines(w.admin, {
      now: NOW,
      deadlineMs: Date.now() + 20_000,
      getPairs: async () => pairs,
      fetch: async (u) => {
        clock += 50
        return site.get(u) ?? { status: 404, contentType: 'text/html', text: '', finalUrl: u }
      },
      sleep: async (ms) => {
        clock += ms
      },
    })
    globalThis.fetch = realFetch
    check('daily step: one note for the whole step, no exception', /^SEO engines:/.test(out.note) && /ideas/.test(out.note) && /competing pages: 1/.test(out.note), out.note)
    check('daily step: mining stored, a safe topic suggested (not approved), cannibalisation stored, one competitor scanned', !!setting(w.db, 'seo_mining_state') && rowsOf(w.db, 'blog_topic_queue').length === 1 && rowsOf(w.db, 'blog_topic_queue')[0].status === 'suggested' && !!setting(w.db, 'seo_cannibalization_state') && !!setting(w.db, 'seo_hubspoke_state') && !!setting(w.db, COMPETITOR_STATE_KEY))
    check('daily step: the secondary page got one logged link to the primary and it is in the changed paths', out.changedPaths.includes('/blog/best-singles-cruises') && String(rowsOf(w.db, 'posts').find((p) => p.id === 'p2')?.body).includes('](/blog/singles-cruise-tips)') && rowsOf(w.db, 'content_edits').length >= 1)
    check('daily step: the primary page was not edited by the cannibalisation link', !String(rowsOf(w.db, 'posts').find((p) => p.id === 'p1')?.body).includes('](/blog/best-singles-cruises)') || logOf(w.db).some((e) => e.subject === '/blog/singles-cruise-tips'))
    const wp = world({ automation_paused: 'true', seo_competitors: JSON.stringify(['https://rivalcruises.com']) }, { posts: posts.map((p) => ({ ...p })), content_edits: [], guides: [], travel_packages: [], blog_topic_queue: [] })
    const paused = await runSeoEngines(wp.admin, { now: NOW, deadlineMs: Date.now() + 20_000, getPairs: async () => pairs, fetch: async () => { throw new Error('must not be called while paused') } })
    check('daily step: while automation is paused no page changes, no topic is queued and no competitor is contacted', rowsOf(wp.db, 'content_edits').length === 0 && rowsOf(wp.db, 'blog_topic_queue').length === 0 && !setting(wp.db, COMPETITOR_STATE_KEY) && /paused/.test(paused.note), paused.note)
    const wn = world({}, { posts: posts.map((p) => ({ ...p })), content_edits: [], guides: [], travel_packages: [], blog_topic_queue: [], gsc_rankings: [] })
    const none = await runSeoEngines(wn.admin, { now: NOW, deadlineMs: Date.now() + 20_000, getPairs: async () => [] })
    check('daily step: with no Search Console data it fails open (no pairs, no stored rows): nothing changes, no crash', /^SEO engines:/.test(none.note) && rowsOf(wn.db, 'content_edits').length === 0)
    const wt = world({}, { posts: posts.map((p) => ({ ...p })), content_edits: [], guides: [], travel_packages: [], blog_topic_queue: [] })
    const timeout = await runSeoEngines(wt.admin, { now: NOW, deadlineMs: Date.now() - 1, getPairs: async () => pairs })
    check('daily step: with the time budget already used no link is added and no competitor is scanned', rowsOf(wt.db, 'content_edits').length === 0 && !setting(wt.db, COMPETITOR_STATE_KEY) && timeout.changedPaths.length === 0)
  }

  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) FAILED.`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
