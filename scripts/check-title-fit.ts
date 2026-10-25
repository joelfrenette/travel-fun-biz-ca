// Offline check for the 60 character title rule (lib/title-fit.ts and where it is applied). No network, no database, no AI.
// Run: pnpm dlx tsx scripts/check-title-fit.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.ANTHROPIC_API_KEY = ''
process.env.INDEXNOW_KEY = ''

import { fakeAdmin, type Db } from './fake-admin'
import { dateSuffix, fitTitle, planPostTitle, slugIdSuffix, uniqueFitTitle, TITLE_FIT_MAX } from '../lib/title-fit'
import { newsHeadlineOf, newsTitle, trustedHeadline } from '../lib/news-post'
import { TITLE_MAX } from '../lib/site-crawl'
import { healCrawlFindings, MAX_TITLE_FIXES_PER_RUN } from '../lib/site-crawl-run'
import type { Finding } from '../lib/site-crawl'
import { dangling } from '../lib/sentence-safe'
import { AUTOMATION_PAUSED_KEY } from '../lib/automation-kill-switch'

let failed = 0
function expect(name: string, ok: boolean, detail = '') {
  if (!ok) {
    failed++
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`)
  } else console.log(`ok   ${name}`)
}
const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const HANGING = /(?:^|\s)(?:of|the|a|an|and|or|to|for|in|at|by|with|from|on|as|after|amid|near|than)$/i

const examples = [
  'News: Canada travel advisory update for Saudi Arabia',
  'News: Canada travel advisory update for Saint Vincent and the Grenadines',
  'News: Canada travel advisory update for Bosnia and Herzegovina and neighbouring regions',
  'News: Hurricane Melissa strengthens near Jamaica with maximum sustained winds of 140 mph',
  'News: Tropical Storm Rafael forecast to become a hurricane as it moves toward the Cayman Islands and western Cuba',
  'News: UK travel advice update for Democratic Republic of the Congo',
  'News: Typhoon Ragasa No. 3 advisory 12A: heavy rain and flooding expected across northern Luzon — residents told to prepare',
  'Canada changes its advisory for Saint Vincent and the Grenadines: Exercise a high degree of caution to Avoid non-essential travel',
  'A'.repeat(108),
  'Visit Mt. Rushmore and the Cathedral of St. Peter and St. Paul in the heart of the capital city this summer',
]
for (const t of examples) {
  const out = fitTitle(t)
  expect(`fits 60: "${t.slice(0, 50)}..." -> "${out}"`, out.length > 0 && out.length <= TITLE_FIT_MAX, String(out.length))
  expect(`no dangling word: "${out}"`, !HANGING.test(out) && !dangling(out) && !/[,;:]$/.test(out) && !/…|\.\.\./.test(out) && !/[—–]/.test(out))
  expect(`idempotent: "${out}"`, fitTitle(out) === out)
}

// Key facts survive.
expect('country name kept', /Saudi Arabia/.test(fitTitle(examples[0])) && /Saint Vincent and the Grenadines/.test(fitTitle(examples[1])))
expect('advisory kind kept', /advisory/i.test(fitTitle(examples[1])))
expect('storm name kept', /Melissa/.test(fitTitle(examples[3])) && /Rafael/.test(fitTitle(examples[4])))
expect('short title untouched', fitTitle('Cuba in March') === 'Cuba in March')
expect('em dash removed even when short', fitTitle('Cuba — in March') === 'Cuba, in March')
expect('a number after "of" is not left hanging', !/\bof \d*$/.test(fitTitle('News: Hurricane Melissa nears Jamaica with maximum sustained winds of 140 mph', 52)))
expect('St. abbreviation is not cut', !dangling(fitTitle('Weekend at the Cathedral of St. Peter and St. Paul with the family tour', 40)))

// Suffix and dedupe.
const a = fitTitle('News: Canada travel advisory update for Saudi Arabia', 60, { uniqueSuffix: '(Oct 12)' })
expect('suffix kept and within 60', a.endsWith('(Oct 12)') && a.length <= 60, a)
const taken = new Set([fitTitle(examples[0]).toLowerCase()])
const u = uniqueFitTitle(examples[0], taken, [dateSuffix('2026-10-12T10:00:00Z'), slugIdSuffix('news-canada-travel-advisory-update-for-saudi-arabia-caaff2')])
expect('collision gets a date', u !== fitTitle(examples[0]) && u.length <= 60 && u.includes('(Oct 12)'), u)
const taken2 = new Set([fitTitle(examples[0]).toLowerCase(), u.toLowerCase()])
const u2 = uniqueFitTitle(examples[0], taken2, [dateSuffix('2026-10-12'), slugIdSuffix('news-x-caaff2')])
expect('second collision falls to the id', u2.includes('(caaff2)') && !taken2.has(u2.toLowerCase()) && u2.length <= 60, u2)
expect('deterministic', uniqueFitTitle(examples[0], taken, ['(Oct 12)']) === uniqueFitTitle(examples[0], taken, ['(Oct 12)']))
expect('long title with a long suffix still within 60', fitTitle(examples[4], 60, { uniqueSuffix: '(caaff2)' }).length <= 60)

// planPostTitle: rendered title (meta_title, else "title | site") is what counts.
const SITE = 'TravelFunBiz.ca'
const p1 = planPostTitle({ slug: 'news-canada-travel-advisory-update-for-saudi-arabia-3d9939', title: 'News: Canada travel advisory update for Saudi Arabia', meta_title: null, publish_date: '2026-10-12' }, new Set(), SITE)
expect('52 char news title (70 shown) gets an explicit search title within 60', p1.meta_title !== null && p1.meta_title.length <= 60 && p1.title.length <= 60 && p1.metaChanged, JSON.stringify(p1))
const p2 = planPostTitle({ slug: 'news-canada-travel-advisory-update-for-saudi-arabia-caaff2', title: 'News: Canada travel advisory update for Saudi Arabia', meta_title: null, publish_date: '2026-10-12' }, new Set([(p1.meta_title ?? '').toLowerCase()]), SITE)
expect('duplicate gets a different title within 60', p2.title !== p1.title && p2.title.length <= 60 && (p2.meta_title ?? '').length <= 60 && p2.meta_title !== p1.meta_title, JSON.stringify(p2))
const p3 = planPostTitle({ slug: 'a-b', title: 'Cuba in March', meta_title: null }, new Set(), SITE)
expect('a fine title is left alone', !p3.titleChanged && !p3.metaChanged && p3.meta_title === null)
const p4 = planPostTitle({ slug: 'a-b', title: 'Cuba in March', meta_title: 'x'.repeat(5) + ' ' + 'y'.repeat(70) }, new Set(), SITE)
expect('a long search title is shortened', (p4.meta_title ?? '').length <= 60 && p4.metaChanged && !p4.titleChanged)
expect('planPostTitle is idempotent', (() => { const q = planPostTitle({ slug: 'news-x-3d9939', title: p1.title, meta_title: p1.meta_title, publish_date: '2026-10-12' }, new Set(), SITE); return !q.titleChanged && !q.metaChanged })())

// A queued news draft is judged from its full headline (kept in the cover alt text), not from the shortened title.
const longHeadline = 'Subtropical Storm Josephine advisory number 2 with maximum sustained winds of 65 mph'
expect('headline round trip: a shortened title still reads back as the full headline', newsHeadlineOf({ title: newsTitle(longHeadline), alt_text: longHeadline }) === longHeadline)
const withDate = fitTitle(`News: ${longHeadline}`, 60, { uniqueSuffix: '(Oct 12)' })
expect('headline round trip: a title with a date suffix too', newsHeadlineOf({ title: withDate, alt_text: longHeadline }) === longHeadline, withDate)
expect('headline round trip: a hand-edited title is NOT trusted', trustedHeadline({ title: 'News: Something else entirely', alt_text: longHeadline }) === null)

// Wired in.
expect('crawl flags titles over 60', TITLE_MAX === 60)
expect('newsTitle fits 60', examples.slice(0, 5).every((t) => newsTitle(t.replace(/^News: /, '')).length <= 60) && newsTitle('x'.repeat(90)).length <= 60)
const publish = read('lib/news-publish.ts')
expect('news publish: search title is written and duplicates are disambiguated', /meta_title: newsTitle\(/.test(publish) && /uniqueFitTitle\(/.test(publish))
expect('autoblog: post title and search title are fitted', /title: fitTitle\(final\.title\)/.test(read('lib/autoblog-run.ts')) && /fitTitle\(final\.seo_title\)/.test(read('lib/autoblog-run.ts')))
expect('news-post uses the fitter', /fitTitle\(`News:/.test(read('lib/news-post.ts')))
expect('backfill script exists and is dry-run by default', /process\.argv\.includes\('--apply'\)/.test(read('scripts/fit-news-titles.ts')) && /news-title-fit-before\.json/.test(read('scripts/fit-news-titles.ts')))

// The heal step, against the in-memory database.
const sitemap = new Set<string>()
const fetchNo = (async () => { throw new Error('no network in this check') }) as never
const finding = (slug: string, kind: 'title-long' | 'title-duplicate'): Finding => ({ url: `https://www.travelfunbiz.ca/blog/${slug}`, kind, severity: 'warning', message: 'x', hint: 'y' }) as Finding
function seed(n: number, opts: { paused?: boolean } = {}): Db {
  const db: Db = { tables: { app_settings: opts.paused ? [{ key: AUTOMATION_PAUSED_KEY, value: 'true' }] : [], content_edits: [], posts: [], guides: [] } }
  for (let i = 0; i < n; i++) {
    db.tables.posts.push({ id: `p${i}`, slug: `news-canada-travel-advisory-update-for-saudi-arabia-${String(i).padStart(6, '0')}`, status: 'published', updated_at: '2026-10-01T00:00:00Z', publish_date: '2026-10-12', title: i === 0 ? 'News: Canada travel advisory update for Saudi Arabia' : `News: Hurricane Number${i} strengthens near Jamaica with maximum sustained winds of 140 mph`, meta_title: null, body: 'b' })
  }
  return db
}
async function main() {
  {
    const db = seed(3)
    const admin = fakeAdmin(db)
    const findings = db.tables.posts.map((p) => finding(String(p.slug), 'title-long'))
    const r = await healCrawlFindings(admin as never, findings, { fetch: fetchNo, sitemapPaths: sitemap })
    expect('heal: rewrites the titles', r.fixed === 3 && db.tables.posts.every((p) => String(p.meta_title ?? '').length > 0 && String(p.meta_title).length <= 60 && String(p.title).length <= 60), JSON.stringify(db.tables.posts.map((p) => [p.title, p.meta_title])))
    expect('heal: logs every change with before and after', db.tables.content_edits.length >= 3 && db.tables.content_edits.every((e) => (e.field === 'title' || e.field === 'meta_title') && e.published_after === false && typeof e.before === 'string' && typeof e.after === 'string'))
    expect('heal: never changes status or body', db.tables.posts.every((p) => p.status === 'published' && p.body === 'b'))
    expect('heal: the findings are marked healed', r.healedKeys.size === 3)
    const second = await healCrawlFindings(admin as never, findings, { fetch: fetchNo, sitemapPaths: sitemap })
    expect('heal: a second run changes nothing', second.fixed === 0)
  }
  {
    const db = seed(2)
    for (const p of db.tables.posts) p.title = 'News: Canada travel advisory update for Saudi Arabia'
    const admin = fakeAdmin(db)
    const r = await healCrawlFindings(admin as never, db.tables.posts.map((p) => finding(String(p.slug), 'title-duplicate')), { fetch: fetchNo, sitemapPaths: sitemap })
    const shown = db.tables.posts.map((p) => String(p.meta_title ?? '') || `${p.title} | TravelFunBiz.ca`)
    expect('heal: duplicates end up different and within 60', r.fixed >= 1 && new Set(shown.map((s) => s.toLowerCase())).size === 2 && shown.every((s) => s.length <= 60), JSON.stringify(shown))
  }
  {
    const db = seed(30)
    for (const p of db.tables.posts) p.title = `News: Hurricane Name${p.id} strengthens near Jamaica with maximum sustained winds of 140 mph`
    const admin = fakeAdmin(db)
    const r = await healCrawlFindings(admin as never, db.tables.posts.map((p) => finding(String(p.slug), 'title-long')), { fetch: fetchNo, sitemapPaths: sitemap })
    expect(`heal: capped at ${MAX_TITLE_FIXES_PER_RUN} a run`, r.fixed === MAX_TITLE_FIXES_PER_RUN, String(r.fixed))
  }
  {
    const db = seed(3, { paused: true })
    const admin = fakeAdmin(db)
    const r = await healCrawlFindings(admin as never, db.tables.posts.map((p) => finding(String(p.slug), 'title-long')), { fetch: fetchNo, sitemapPaths: sitemap })
    expect('heal: nothing changes while automation is paused', r.fixed === 0 && db.tables.content_edits.length === 0 && db.tables.posts.every((p) => p.meta_title === null))
  }
  if (failed) {
    console.error(`\n${failed} check(s) failed`)
    process.exit(1)
  }
  console.log('\nall title-fit checks passed')
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
