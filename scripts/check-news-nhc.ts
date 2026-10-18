// Growth loop WP20 tuning: hurricane centre feeds. Offline check (no network, no database, no model call that costs money).
// Run: pnpm dlx tsx scripts/check-news-nhc.ts
// Built from the REAL titles the live draft run showed on 2026-10-17: six items per active storm, plus the outlook.
import { fakeAdmin, type Db } from './fake-admin'
import { sourceByKey } from '../lib/news-sources'
import { classifyItem, stormKey, stormKeysMatch, coveredByEarlierStormPost, nhcProductRank } from '../lib/news-relevance'
import { ingestFeeds, reevaluateItems, STORM_COVERED_REASON, NO_LONGER_QUALIFIES_REASON } from '../lib/news-ingest'
import { runNewsStep } from '../lib/news-run'
import { isSupersededBody } from '../lib/news-post'
import { writerPrompt, type NewsFacts, type NewsBrief } from '../lib/news-brief'
import type { FetchDeps } from '../lib/news-feed'

delete process.env.ANTHROPIC_API_KEY
globalThis.fetch = (async () => {
  throw new Error('the real network is blocked in this check')
}) as unknown as typeof fetch

let failed = 0
function check(label: string, ok: boolean, extra?: string) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` :: ${extra}` : ''}`)
}

type Row = Record<string, unknown>
const HOUR = 3_600_000
const NOW = Date.parse('2026-10-17T12:00:00Z')
const nhcAt = sourceByKey('nhc-atlantic')!
const nhcEp = sourceByKey('nhc-pacific')!

const T = {
  summary: 'Summary for Hurricane Trudy (EP1/EP212026)',
  publicAdv: 'Hurricane Trudy Public Advisory Number 19',
  forecastAdv: 'Hurricane Trudy Forecast Advisory Number 19',
  discussion: 'Hurricane Trudy Forecast Discussion Number 19',
  probs: 'Hurricane Trudy Wind Speed Probabilities Number 19',
  graphics: 'Hurricane Trudy Graphics',
  outlook: 'Eastern North Pacific Tropical Weather Outlook',
}
const DESC_19 = 'Hurricane Trudy has maximum sustained winds near 105 mph. A hurricane warning is in effect for the coast of southwestern Mexico.'
const DESC_NONE = 'There are no tropical cyclones at this time.'

const item = (title: string, guid: string, whenMs: number, desc: string) =>
  `<item><title>${title}</title><link>https://www.nhc.noaa.gov/text/${guid}.shtml</link><guid>${guid}</guid><pubDate>${new Date(whenMs).toUTCString()}</pubDate><description>${desc}</description></item>`
const feed = (...items: string[]) => `<?xml version="1.0"?><rss version="2.0"><channel><title>NHC</title>${items.join('')}</channel></rss>`

function feedDeps(routes: Record<string, string>, nowMs: () => number): FetchDeps {
  return {
    now: nowMs,
    fetch: (async (url: string) => {
      if (String(url).endsWith('/robots.txt')) return new Response('', { status: 404 })
      const r = routes[String(url)]
      if (r === undefined) return new Response('', { status: 404 })
      return new Response(r, { status: 200, headers: { 'content-type': 'application/xml' } })
    }) as unknown as typeof fetch,
  }
}
const world = (settings: Record<string, string> = {}, tables: Record<string, Row[]> = {}) => {
  const db: Db = { tables: { app_settings: Object.entries(settings).map(([key, value]) => ({ key, value })), ...tables } }
  return { db, admin: fakeAdmin(db) }
}
const rowsOf = (db: Db, t: string) => db.tables[t] ?? []
const newsRows = (db: Db) => rowsOf(db, 'news_items')
const byStatus = (db: Db, s: string) => newsRows(db).filter((r) => r.status === s)

async function main() {
  // ---- relevance: only the plain-language products survive ----
  const c = (title: string, summary = DESC_19) => classifyItem(nhcAt, { title, summary })
  check('relevance: the Public Advisory is kept', c(T.publicAdv).relevant)
  check('relevance: the "Summary for" item is still relevant (it loses to the Public Advisory later, in the storm window)', c(T.summary).relevant)
  for (const [k, title] of [['Forecast Advisory', T.forecastAdv], ['Forecast Discussion', T.discussion], ['Wind Speed Probabilities', T.probs], ['Graphics', T.graphics]] as const) {
    const v = c(title)
    check(`relevance: the ${k} product is dropped with a plain reason`, !v.relevant && v.reason === 'technical product, not traveller news', v.reason)
  }
  check('relevance: an outlook saying there are no tropical cyclones is dropped', !c(T.outlook, DESC_NONE).relevant && !c('Atlantic Tropical Weather Outlook', DESC_NONE).relevant)
  check('relevance: an item with no named system or storm is dropped', !classifyItem(nhcAt, { title: 'NHC product update', summary: DESC_NONE }).relevant)
  check('relevance: the older plain "Advisory Number" title still works', c('Hurricane Milton Advisory Number 12').relevant)
  check('relevance: the same words on a non-NHC source are NOT dropped (rule is per source)', classifyItem({ key: 'skift', tier: 2, defaultCategory: 'industry' }, { title: 'Hurricane Trudy forecast discussion: cruise lines reroute ships', summary: 'Cruise ship sailings cancelled.' }).relevant)

  // ---- storm keys ----
  check('storm key: name plus ATCF id from the Summary title', stormKey(T.summary) === 'trudy|ep212026')
  check('storm key: name only from the Public Advisory title', stormKey(T.publicAdv) === 'trudy')
  check('storm key: Summary and Public Advisory of one storm match; two storms and two ids do not', stormKeysMatch(stormKey(T.summary), stormKey(T.publicAdv)) && !stormKeysMatch('trudy', 'vance') && !stormKeysMatch('trudy|ep212026', 'trudy|ep222026'))
  check('storm key: a plain lower-case word is not a storm name', stormKey('hurricane warning for the coast') === null && stormKey('Atlantic Tropical Weather Outlook') === null)
  check('storm key: Tropical Storm and Post-Tropical Cyclone titles give a name', stormKey('Tropical Storm Vance Public Advisory Number 3') === 'vance' && stormKey('Post-Tropical Cyclone Trudy Public Advisory Number 30') === 'trudy')
  check('rank: the Public Advisory sorts before the Summary', nhcProductRank(T.publicAdv) < nhcProductRank(T.summary))
  check('window: exactly 12 hours apart is no longer covered; 11 hours is; a non-NHC source never is', !coveredByEarlierStormPost({ sourceKey: 'nhc-atlantic', title: T.publicAdv, whenMs: 12 * HOUR }, [{ sourceKey: 'nhc-atlantic', title: T.publicAdv, whenMs: 0, status: 'published' }]) && coveredByEarlierStormPost({ sourceKey: 'nhc-atlantic', title: T.publicAdv, whenMs: 11 * HOUR }, [{ sourceKey: 'nhc-atlantic', title: T.publicAdv, whenMs: 0, status: 'published' }]) && !coveredByEarlierStormPost({ sourceKey: 'skift', title: T.publicAdv, whenMs: HOUR }, [{ sourceKey: 'skift', title: T.publicAdv, whenMs: 0, status: 'published' }]))
  check('window: a rejected or expired earlier item does not cover', !coveredByEarlierStormPost({ sourceKey: 'nhc-atlantic', title: T.publicAdv, whenMs: HOUR }, [{ sourceKey: 'nhc-atlantic', title: T.publicAdv, whenMs: 0, status: 'rejected' }, { sourceKey: 'nhc-atlantic', title: T.publicAdv, whenMs: 0, status: 'expired' }]))

  // ---- ingest: all six Trudy products and the outlook in one feed ----
  {
    const { db, admin } = world()
    const t = NOW
    const all = feed(
      item(T.summary, 'sum-19', NOW - 1 * HOUR, DESC_19),
      item(T.forecastAdv, 'fa-19', NOW - 1 * HOUR, DESC_19),
      item(T.discussion, 'fd-19', NOW - 1 * HOUR, DESC_19),
      item(T.probs, 'wp-19', NOW - 1 * HOUR, DESC_19),
      item(T.graphics, 'gr-19', NOW - 1 * HOUR, DESC_19),
      item(T.publicAdv, 'pa-19', NOW - 1 * HOUR, DESC_19),
      item(T.outlook, 'two-1', NOW - 1 * HOUR, DESC_NONE),
    )
    const r = await ingestFeeds(admin, { fetchDeps: feedDeps({ [nhcEp.feedUrl]: all }, () => t), now: new Date(t), sources: [nhcEp] })
    const cands = byStatus(db, 'new')
    check('ingest: all six Trudy products and the outlook in one feed give ONE candidate, the Public Advisory', cands.length === 1 && cands[0].title === T.publicAdv, newsRows(db).map((x) => `${x.title}=${x.status}`).join(' | '))
    check('ingest: the Summary of the same storm is stored as rejected "covered by an earlier post" with no decided_at', byStatus(db, 'rejected').length === 1 && byStatus(db, 'rejected')[0].title === T.summary && byStatus(db, 'rejected')[0].reject_reason === STORM_COVERED_REASON && byStatus(db, 'rejected')[0].decided_at === undefined && r.covered === 1)
    check('ingest: the four technical products and the outlook are not stored at all (nothing to re-read next run)', newsRows(db).length === 2 && r.notRelevant === 5, `${newsRows(db).length} rows, notRelevant ${r.notRelevant}`)

    // a second advisory 3 hours later for the same storm is covered
    const t2 = NOW + 3 * HOUR
    const later = feed(item('Hurricane Trudy Public Advisory Number 20', 'pa-20', t2 - HOUR, 'Hurricane Trudy has maximum sustained winds near 110 mph. A hurricane warning is in effect for the coast of southwestern Mexico.'), item(T.publicAdv, 'pa-19', NOW - HOUR, DESC_19))
    const r2 = await ingestFeeds(admin, { fetchDeps: feedDeps({ [nhcEp.feedUrl]: later }, () => t2), now: new Date(t2), sources: [nhcEp] })
    const adv20 = newsRows(db).find((x) => x.guid === 'pa-20')
    check('3 hours later: the next advisory of the same storm is skipped as covered, still ONE candidate', !!adv20 && adv20.status === 'rejected' && adv20.reject_reason === STORM_COVERED_REASON && byStatus(db, 'new').length === 1 && r2.covered === 1 && r2.stored === 0)

    // 13 hours after the first advisory a new one is a candidate again (it is an update); a 14 hour one is covered by it
    const t3 = NOW + 12 * HOUR
    const much = feed(item('Hurricane Trudy Public Advisory Number 24', 'pa-24', NOW + 12 * HOUR - HOUR / 2, 'Hurricane Trudy has maximum sustained winds near 125 mph. A hurricane warning is in effect for the coast of southwestern Mexico.'))
    const r3 = await ingestFeeds(admin, { fetchDeps: feedDeps({ [nhcEp.feedUrl]: much }, () => t3), now: new Date(t3), sources: [nhcEp] })
    check('13 hours later: a new advisory is stored as a candidate again (an update)', r3.stored === 1 && byStatus(db, 'new').some((x) => x.guid === 'pa-24') && byStatus(db, 'new').length === 2, `${r3.stored} stored`)
    const t4 = t3 + HOUR
    const next = feed(item('Hurricane Trudy Public Advisory Number 25', 'pa-25', t4 - HOUR / 4, 'Hurricane Trudy has maximum sustained winds near 130 mph. A hurricane warning is in effect for the coast of southwestern Mexico.'))
    const r4 = await ingestFeeds(admin, { fetchDeps: feedDeps({ [nhcEp.feedUrl]: next }, () => t4), now: new Date(t4), sources: [nhcEp] })
    check('after the update: the next advisory inside the NEW 12 hour window is covered again', r4.covered === 1 && r4.stored === 0 && byStatus(db, 'new').length === 2)
  }

  // ---- two different storms each produce one ----
  {
    const { db, admin } = world()
    const two = feed(
      item(T.publicAdv, 'pa-19', NOW - HOUR, DESC_19),
      item('Hurricane Trudy Forecast Discussion Number 19', 'fd-19', NOW - HOUR, DESC_19),
      item('Tropical Storm Vance Public Advisory Number 3', 'v-3', NOW - HOUR, 'Tropical Storm Vance has maximum sustained winds near 50 mph. A tropical storm warning is in effect for the coast of Baja California.'),
      item('Summary for Tropical Storm Vance (EP2/EP222026)', 'vs-3', NOW - HOUR, 'Tropical Storm Vance has maximum sustained winds near 50 mph.'),
    )
    await ingestFeeds(admin, { fetchDeps: feedDeps({ [nhcEp.feedUrl]: two }, () => NOW), now: new Date(NOW), sources: [nhcEp] })
    const cands = byStatus(db, 'new').map((x) => String(x.title)).sort()
    check('two different storms each produce exactly one candidate', cands.length === 2 && cands[0].includes('Trudy') && cands[1].includes('Vance'), cands.join(' | '))
  }

  // ---- re-evaluation of queued items ----
  {
    const old = new Date(NOW - 2 * HOUR).toISOString()
    const mk = (id: string, title: string, status: string, source = 'nhc-pacific', summary = DESC_19): Row => ({ id, source_key: source, guid: id, url: `https://www.nhc.noaa.gov/${id}`, title, summary_raw: summary, published_at: old, fetched_at: old, category: 'storm', tier: 1, status, post_slug: status === 'queued' ? `news-${id}` : null, decided_at: old })
    const { db, admin } = world({}, {
      news_items: [mk('q-fd', T.discussion, 'queued'), mk('q-wp', T.probs, 'queued'), mk('q-pa', T.publicAdv, 'queued'), mk('n-fd', T.forecastAdv, 'new'), mk('p-fd', T.discussion, 'published'), { ...mk('q-uk', 'Cuba travel advice: hurricane warning and airport closures', 'queued', 'uk-fcdo', 'Hurricane Trudy may affect Cuba. Airports are closed.'), category: 'advisory' }, { ...mk('q-gone', 'Hurricane Trudy Forecast Discussion Number 19', 'queued', 'a-source-that-no-longer-exists') }],
      posts: [{ id: 'post-1', slug: 'news-q-fd', title: 'News: Hurricane Trudy', body: 'x', status: 'draft' }],
    })
    const n = await reevaluateItems(admin)
    const st = (id: string) => newsRows(db).find((x) => x.id === id)
    check('re-evaluation: queued Forecast Discussion and Wind Speed Probabilities items are expired with the plain reason', st('q-fd')?.status === 'expired' && st('q-wp')?.status === 'expired' && st('q-fd')?.reject_reason === NO_LONGER_QUALIFIES_REASON && n === 3, `n=${n}`)
    check('re-evaluation: a waiting "new" technical item is expired too; a published one is never touched', st('n-fd')?.status === 'expired' && st('p-fd')?.status === 'published')
    check('re-evaluation: the Public Advisory, a non-NHC item and an item of an unknown source are untouched', st('q-pa')?.status === 'queued' && st('q-uk')?.status === 'queued' && st('q-gone')?.status === 'queued')
    check('re-evaluation: nothing is deleted and the draft post is untouched', newsRows(db).length === 7 && rowsOf(db, 'posts').length === 1 && rowsOf(db, 'posts')[0].status === 'draft' && rowsOf(db, 'posts')[0].body === 'x')
    check('re-evaluation: a second pass changes nothing', (await reevaluateItems(admin)) === 0)

    // the same through the whole step, in draft mode (no feeds, no model needed)
    const w2 = world({ travel_news_mode: 'draft' }, { news_items: [mk('q-fd', T.discussion, 'queued'), mk('q-pa', T.publicAdv, 'queued')], posts: [{ id: 'post-1', slug: 'news-q-fd', title: 'News: Hurricane Trudy', body: 'x', status: 'draft' }] })
    const res = await runNewsStep(w2.admin, { fetchDeps: feedDeps({}, () => NOW), now: new Date(NOW), sources: [] })
    check('re-evaluation: the draft-mode news step expires the old Trudy draft candidate and leaves its draft post alone', rowsOf(w2.db, 'news_items').find((x) => x.id === 'q-fd')?.status === 'expired' && rowsOf(w2.db, 'news_items').find((x) => x.id === 'q-pa')?.status === 'queued' && rowsOf(w2.db, 'posts')[0].status === 'draft' && /no longer qualified/.test(res?.note ?? ''), res?.note)
  }

  // ---- the whole step: a 13 hour later advisory becomes an update that supersedes the live post ----
  {
    const J_PASS = '{"pass":true,"failures":[]}'
    const BRIEF_19: NewsBrief = {
      headline: 'Hurricane Trudy warning in effect for coast of southwestern Mexico',
      happened: 'The US National Hurricane Center reports that Hurricane Trudy has maximum sustained winds near 105 mph.',
      means: ['A hurricane warning is in effect for the coast of southwestern Mexico, according to the advisory.', 'The source says the advisory is Public Advisory Number 19 for Hurricane Trudy from the US National Hurricane Center.'],
    }
    const BRIEF_24: NewsBrief = {
      headline: 'Hurricane Trudy advisory number 24 reports winds near 125 mph',
      happened: 'The US National Hurricane Center reports that Hurricane Trudy has maximum sustained winds near 125 mph.',
      means: ['The source says this is Public Advisory Number 24 for Hurricane Trudy.', 'According to the source, Hurricane Trudy has maximum sustained winds near 125 mph, as reported by the US National Hurricane Center.'],
    }
    const prompts: string[] = []
    const model = async (prompt: string): Promise<string | null> => {
      prompts.push(prompt)
      if (/independent fact checker/.test(prompt)) return J_PASS
      const title = /Title: (.*)/.exec(prompt)?.[1] ?? ''
      return JSON.stringify(title.includes('Number 24') ? BRIEF_24 : BRIEF_19)
    }
    const { db, admin } = world({ travel_news_mode: 'publish' })
    const t1 = NOW
    const f1 = feed(item(T.summary, 'sum-19', NOW - 2 * HOUR, DESC_19), item(T.publicAdv, 'pa-19', NOW - 2 * HOUR, DESC_19), item(T.discussion, 'fd-19', NOW - 2 * HOUR, DESC_19))
    await runNewsStep(admin, { fetchDeps: feedDeps({ [nhcEp.feedUrl]: f1 }, () => t1), model, now: new Date(t1), sources: [nhcEp], ping: async () => undefined })
    check('step: one cycle with Summary, Public Advisory and Discussion writes ONE post (the Public Advisory)', rowsOf(db, 'posts').length === 1 && byStatus(db, 'published').length === 1 && byStatus(db, 'published')[0].title === T.publicAdv, `${rowsOf(db, 'posts').length} posts; ${newsRows(db).map((x) => `${x.title}=${x.status}`).join(' | ')}`)
    const t2 = NOW + 3 * HOUR
    const f2 = feed(item('Hurricane Trudy Public Advisory Number 20', 'pa-20', t2 - HOUR, 'Hurricane Trudy has maximum sustained winds near 110 mph. A hurricane warning is in effect for the coast of southwestern Mexico.'))
    await runNewsStep(admin, { fetchDeps: feedDeps({ [nhcEp.feedUrl]: f2 }, () => t2), model, now: new Date(t2), sources: [nhcEp], ping: async () => undefined })
    check('step: an advisory 3 hours later writes nothing new', rowsOf(db, 'posts').length === 1 && newsRows(db).find((x) => x.guid === 'pa-20')?.reject_reason === STORM_COVERED_REASON)
    const t3 = NOW + 12 * HOUR
    const f3 = feed(item('Hurricane Trudy Public Advisory Number 24', 'pa-24', t3 - HOUR / 2, 'Hurricane Trudy has maximum sustained winds near 125 mph. A hurricane warning is in effect for the coast of southwestern Mexico.'))
    const r3 = await runNewsStep(admin, { fetchDeps: feedDeps({ [nhcEp.feedUrl]: f3 }, () => t3), model, now: new Date(t3), sources: [nhcEp], ping: async () => undefined })
    const posts = rowsOf(db, 'posts')
    const older = posts.find((p) => String(p.slug).includes('warning'))
    const newer = posts.find((p) => String(p.slug).includes('advisory-number-24'))
    check('step: an advisory 12 hours later writes an update post', posts.length === 2 && !!older && !!newer && newer.status === 'published', `${r3?.note} | ${posts.map((p) => p.slug).join(' ')}`)
    check('step: the update links the older post and the older post gets the "Update: superseded" heading line', !!older && !!newer && String(newer.body).includes(`](/blog/${String(older.slug)})`) && isSupersededBody(String(older.body)) && older.status === 'published')
    check('step: the writer prompt for a storm allows only places named in the item (no outside "affected areas")', prompts.some((p) => /ONLY in the feed item's own words/.test(p) && /Never add a list of affected areas/.test(p)))
    const facts: NewsFacts = { sourceName: 'x', tier: 1, title: 't', summary: 's', url: 'https://www.nhc.noaa.gov/x', publishedAt: null, category: 'advisory' }
    check('step: the storm wording is not added to non-storm prompts', !/affected areas/.test(writerPrompt(facts)) && /affected areas/.test(writerPrompt({ ...facts, category: 'storm' })))
  }

  // ---- other sources: ingest is unchanged ----
  {
    const { db, admin } = world()
    const ukSrc = sourceByKey('uk-fcdo')!
    const stateSrc = sourceByKey('us-state-dept')!
    const rss = (...items: string[]) => feed(...items)
    const stateItems = rss(
      `<item><title>Cuba - Level 3: Reconsider Travel</title><link>https://travel.state.gov/c1</link><guid>c1</guid><pubDate>${new Date(NOW - 2 * HOUR).toUTCString()}</pubDate><description>Reconsider travel to Cuba due to hurricane damage and power outages.</description></item>`,
      `<item><title>Haiti - Level 4: Do Not Travel</title><link>https://travel.state.gov/h1</link><guid>h1</guid><pubDate>${new Date(NOW - 2 * HOUR).toUTCString()}</pubDate><description>Do not travel to Haiti.</description></item>`,
    )
    const r = await ingestFeeds(admin, { fetchDeps: feedDeps({ [stateSrc.feedUrl]: stateItems, [ukSrc.feedUrl]: '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>' }, () => NOW), now: new Date(NOW), sources: [stateSrc] })
    check('other sources: official advisory items are stored as before, none marked covered', r.stored === 2 && r.covered === 0 && byStatus(db, 'new').length === 2)
  }

  if (failed) {
    console.log(`\n${failed} NHC news check(s) FAILED.`)
    process.exit(1)
  }
  console.log('\nAll NHC news checks passed.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
