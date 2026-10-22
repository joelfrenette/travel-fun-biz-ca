// Offline checks for the Growth digest builder. Run: pnpm dlx tsx scripts/check-growth-digest.ts
import { buildGrowthDigest, growthDigestText, pickGscDays, changeText, textBar, trendLines, MAX_ACTIONS, UNREAD, type DigestInput, type Read } from '../lib/growth-digest'
import { briefHtml } from '../lib/brief-html'
import type { Brief } from '../lib/debrief'

let failed = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failed++
}
const ok = <T,>(value: T): Read<T> => ({ ok: true, value })
const bad: Read<never> = { ok: false, reason: 'boom' }

const NOW = new Date('2026-10-22T12:00:00Z')
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString()

function base(over: Partial<DigestInput> = {}): DigestInput {
  return {
    now: NOW,
    gscDays: ok([
      { day: '2026-10-21', clicks: 150, impressions: 3000, queries: 80 },
      { day: '2026-10-14', clicks: 100, impressions: 2000, queries: 60 },
      { day: '2026-10-13', clicks: 90, impressions: 1900, queries: 58 },
    ]),
    gscRows: ok([
      { day: '2026-10-21', kind: 'query', key: 'aruba resorts', position: 8, clicks: 10, impressions: 1000 },
      { day: '2026-10-21', kind: 'query', key: 'brand new search', position: 20, clicks: 0, impressions: 400 },
      { day: '2026-10-21', kind: 'query', key: 'tiny new', position: 30, clicks: 0, impressions: 10 },
      { day: '2026-10-21', kind: 'page', key: '/blog/a', position: 6, clicks: 5, impressions: 300 },
      { day: '2026-10-21', kind: 'page', key: '/blog/b', position: 18, clicks: 1, impressions: 200 },
      { day: '2026-10-21', kind: 'page', key: '/blog/c', position: 40, clicks: 0, impressions: 3 },
      { day: '2026-10-14', kind: 'query', key: 'aruba resorts', position: 10, clicks: 8, impressions: 1000 },
      { day: '2026-10-14', kind: 'page', key: '/blog/a', position: 12, clicks: 2, impressions: 100 },
      { day: '2026-10-14', kind: 'page', key: '/blog/b', position: 18.2, clicks: 1, impressions: 150 },
    ]),
    bing: ok({ configured: true, status: 'ok', crawled7d: 40, indexed: 120, asOf: '2026-10-20' }),
    postsWritten: ok(4),
    postsPublished: ok(3),
    newsBriefs: ok(2),
    guidesPublished: ok(5),
    guidesFlagged: ok(1),
    postsHeld: ok(2),
    reels: ok(3),
    carousels: ok(4),
    sends: ok([
      { at: iso(1), network: 'facebook' },
      { at: iso(2), network: 'facebook' },
      { at: iso(2), network: 'instagram/facebook' },
      { at: iso(20), network: 'threads' },
    ]),
    gate: ok({ pass: 10, retry: 1, skip: 1, deferred: 2 }),
    cadence: ok({ guides: 5, posts: 3 }),
    leads: ok([
      { at: iso(1), isTest: false, pkg: 'Aruba' },
      { at: iso(2), isTest: false, pkg: 'Aruba' },
      { at: iso(3), isTest: true, pkg: 'Test' },
      { at: iso(9), isTest: false, pkg: 'Cuba' },
    ]),
    visits: ok([
      { source: 'facebook', content: 'question' },
      { source: 'facebook', content: 'question' },
      { source: 'instagram', content: 'number' },
    ]),
    visitTrackingOn: ok(true),
    ai: ok([
      { feature: 'blog', costUsd: 0.5 },
      { feature: 'guides', costUsd: 1.5 },
      { feature: 'blog', costUsd: 0.5 },
    ]),
    social: ok({ platforms: ['facebook', 'instagram'] }),
    ...over,
  }
}
const text = (i: DigestInput) => growthDigestText(buildGrowthDigest(i))
const allLines = (i: DigestInput) => {
  const d = buildGrowthDigest(i)
  return [...d.sections.flatMap((s) => s.lines), ...d.trends, ...d.actions]
}

// ---- pure helpers
check('changeText up', changeText(150, 100) === 'up 50% from 100')
check('changeText down', changeText(80, 100) === 'down 20% from 100')
check('changeText flat', changeText(100, 100).startsWith('the same'))
check('changeText from zero never divides', changeText(5, 0) === 'up from 0')
check('textBar scales', textBar(10, 10, 20) === '#'.repeat(20) && textBar(5, 10, 20) === '#'.repeat(10))
check('textBar tiny value still shows one mark', textBar(1, 1000, 20) === '#')
check('textBar zero is empty', textBar(0, 10) === '')
check('trendLines unreadable', trendLines('X', null, 5).join('') === `X: ${UNREAD}`)
{
  const p = pickGscDays([
    { day: '2026-10-21', clicks: 1, impressions: 1, queries: 1 },
    { day: '2026-10-14', clicks: 1, impressions: 1, queries: 1 },
  ])
  check('pickGscDays picks 7 days back', p.latest?.day === '2026-10-21' && p.before?.day === '2026-10-14')
  const q = pickGscDays([{ day: '2026-10-21', clicks: 1, impressions: 1, queries: 1 }, { day: '2026-10-20', clicks: 1, impressions: 1, queries: 1 }])
  check('pickGscDays has no before when history is short', q.before === null)
  check('pickGscDays empty', pickGscDays([]).latest === null)
}

// ---- week over week math
{
  const t = text(base())
  check('impressions now and change', t.includes('Impressions (times Google showed us): 3,000, up 50% from 2,000.'), t)
  check('clicks change', t.includes('Clicks to the site from Google: 150, up 50% from 100.'))
  check('queries change', t.includes('Searches we showed up for: 80, up 33% from 60.'))
  check('pages with impressions counted from rows', t.includes('Pages Google showed at least once: 3, up 50% from 2.'), t)
  check('average position is impression weighted', t.includes('Average position of our top searches: 11.6 (was 10.0'), t)
  check('best new search is the biggest new one', t.includes('Best new search: "brand new search"'))
  check('best moving page is /blog/a (12 to 6)', t.includes('Best page moving up: /blog/a (position 12.0 to 6.0)'), t)
  check('trend bars present', buildGrowthDigest(base()).trends.some((l) => l.includes('7 days ago') && l.includes('#')))
  check('leads week over week, test excluded', t.includes('Real leads: 2, up 100% from 1. Test leads (not counted): 1.'), t)
  check('social sends split joined networks, old ones dropped', t.includes('Social posts sent: facebook 3, instagram 1'), t)
  check('ai total and per item', t.includes('$2.50') && t.includes('Cost per published item (posts and guides): $0.31.'), t)
  check('picture check numbers', t.includes('Skipped by the picture check: 1 (it passed 10, put off 2 for later)'))
  check('visits tally', t.includes('facebook 2') && t.includes('question 2'))
}

// ---- failures say "could not be read", never zero
{
  const t = text(
    base({ gscDays: bad, gscRows: bad, bing: bad, postsWritten: bad, postsPublished: bad, newsBriefs: bad, guidesPublished: bad, guidesFlagged: bad, postsHeld: bad, reels: bad, carousels: bad, sends: bad, gate: bad, cadence: bad, leads: bad, visits: bad, ai: bad, social: bad }),
  )
  check('google failure says could not be read', t.includes(`Google Search numbers: ${UNREAD}`))
  check('bing failure', t.includes(`Bing: ${UNREAD}`))
  check('posts failure', t.includes(`Blog posts written: ${UNREAD}`))
  check('guides failure', t.includes(`Guides published: ${UNREAD}`))
  check('reels and carousels failure', t.includes(`Reels posted: ${UNREAD}`) && t.includes(`Carousels posted: ${UNREAD}`))
  check('sends failure', t.includes(`Social posts sent: ${UNREAD}`))
  check('gate failure', t.includes(`Skipped by the picture check: ${UNREAD}`))
  check('cadence failure', t.includes(`Pacing limit log: ${UNREAD}`))
  check('leads failure', t.includes(`Leads: ${UNREAD}`))
  check('visits failure', t.includes(`Visits by source: ${UNREAD}`))
  check('ai failure and cost per item', t.includes(`AI spend: ${UNREAD}`) && !t.includes('Cost per published item'))
  check('trend failure', t.includes(`Real leads: ${UNREAD}`) && t.includes(`Google impressions: ${UNREAD}`))
  check('no made-up zeros on failure', !/Blog posts written: 0/.test(t) && !/Real leads: 0/.test(t))
}
{
  const t = text(base({ gscRows: bad }))
  check('rows failure keeps the totals but says detail unreadable', t.includes('Impressions (times Google showed us): 3,000') && t.includes(`Average position, pages with impressions, best new search and best page: ${UNREAD}`))
  const t2 = text(base({ gscDays: ok([{ day: '2026-10-21', clicks: 5, impressions: 50, queries: 4 }]) }))
  check('short history says nothing to compare, no invented change', t2.includes('nothing to compare') && !t2.includes('up from') && !t2.includes('down '))
  const t3 = text(base({ gscDays: ok([]) }))
  check('empty snapshot table is not a failure and not a zero', t3.includes('no snapshot yet'))
  const t4 = text(base({ visits: ok([]), visitTrackingOn: ok(false) }))
  check('visits off is said plainly', t4.includes('visit tracking is switched off'))
  const t5 = text(base({ bing: ok({ configured: false, status: null, crawled7d: null, indexed: null, asOf: null }) }))
  check('bing not connected', t5.includes('Bing: not connected'))
  const t6 = text(base({ postsPublished: ok(0), guidesPublished: ok(0) }))
  check('cost per item not divided by zero', t6.includes('nothing was published, so it is not worked out') && !t6.includes('Infinity') && !t6.includes('NaN'))
}

// ---- actions: at most 3, each tied to a real number
{
  const calm = buildGrowthDigest(base({ guidesFlagged: ok(0), postsHeld: ok(0) }))
  check('calm week has no actions', calm.actions.length === 0, JSON.stringify(calm.actions))
  check('calm text says nothing needed', growthDigestText(calm).includes('Nothing here needs you today.'))

  const noisy = buildGrowthDigest(
    base({
      social: ok({ platforms: ['instagram'] }),
      gscDays: ok([
        { day: '2026-10-21', clicks: 50, impressions: 1000, queries: 30 },
        { day: '2026-10-14', clicks: 100, impressions: 2000, queries: 60 },
      ]),
      postsHeld: ok(4),
      guidesFlagged: ok(2),
      leads: ok([{ at: iso(10), isTest: false, pkg: 'x' }]),
      gate: ok({ pass: 1, retry: 0, skip: 9, deferred: 0 }),
    }),
  )
  check(`at most ${MAX_ACTIONS} actions with 5+ candidates`, noisy.actions.length === MAX_ACTIONS, String(noisy.actions.length))
  check('first action is the social one', /Facebook is not connected \(1 of 2/.test(noisy.actions[0]), noisy.actions[0])
  check('impressions action names real numbers', noisy.actions[1].includes('1,000') && noisy.actions[1].includes('2,000') && noisy.actions[1].includes('8 new pages'), noisy.actions[1])
  check('held drafts action sums real counts', noisy.actions[2].startsWith('6 held drafts need a look (4 blog, 2 guide)'), noisy.actions[2])
  check('every action contains a digit', noisy.actions.every((a) => /\d/.test(a)))

  const none = buildGrowthDigest(base({ social: ok({ platforms: [] }) }))
  check('no social connected is an action', none.actions[0].includes('0 of 2'))
}

// ---- no invented numbers: every number in the output traces to the input
{
  const lines = allLines(base()).join('\n')
  const allowedN = new Set([7, 28, 30, 14, 0.5])
  const input = JSON.stringify(base()) + ' 6 8 11.6 0.31 2.50 50 33 100 20 40 120 150 3,000 2,000 1,000'
  const known = new Set((input.match(/\d+(?:\.\d+)?/g) ?? []).map(Number))
  const nums = (lines.replace(/\d{4}-\d{2}-\d{2}/g, '').match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => Number(n.replace(/,/g, '')))
  const unknown = nums.filter((n) => !allowedN.has(n) && !known.has(n))
  check('no number appears that is not in the data or derived from it', unknown.length === 0, unknown.join(', '))
}

// ---- no em dashes or en dashes, anywhere
{
  const variants = [base(), base({ gscDays: bad, gscRows: bad, leads: bad, ai: bad }), base({ social: ok({ platforms: [] }), postsHeld: ok(3) })]
  const all = variants.map((v) => text(v)).join('\n')
  check('no em or en dashes in digest text', !/[–—]/.test(all))
  const brief: Brief = { dateLabel: 'Thursday, October 22', actions: [], stats: [], yesterday: [], today: [], working: [], healed: [], edits: { lines: [], total: 0, healLines: [] }, tripPages: [], trackerItems: [], growth: buildGrowthDigest(base({ postsHeld: ok(3) })) }
  const html = briefHtml(brief)
  check('brief html carries the growth section', html.includes('Growth this week') && html.includes('What to do today'))
  check('brief html has no em or en dashes', !/[–—]/.test(html))
  const noGrowth = briefHtml({ ...brief, growth: null })
  check('brief builds without growth', !noGrowth.includes('Growth this week'))
}

if (failed) {
  console.log(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll growth digest checks passed')
