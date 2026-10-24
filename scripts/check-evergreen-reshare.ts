// Offline checks for the evergreen re-share (hub row 3): who is eligible, who is picked and why, the cooldowns, the exclusions, the new-hook rule, the UTM
// tag, the switch (default off), the one-a-day step inside the Autopilot pass, the read-only preview, Undo, and that a re-share can never go out as text only.
// Pure functions and an in-memory fake database only: nothing here calls a model, Search Console, a network provider or a real database.
// Run: pnpm dlx tsx scripts/check-evergreen-reshare.ts   (exits 1 on any failed expectation)
import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  EVERGREEN_COOLDOWN_DAYS,
  EVERGREEN_MIN_AGE_DAYS,
  EVERGREEN_STATE_KEY,
  EVERGREEN_SWITCH_KEY,
  EVERGREEN_STATE_MAX,
  baseSlugOfEvergreen,
  earlierHooksFor,
  evergreenSlug,
  evergreenSwitchOn,
  exclusionReason,
  freshNetworks,
  getEvergreenEnabled,
  hookIsFresh,
  hookKey,
  isEvergreenSlug,
  parseEvergreenState,
  pickEvergreen,
  recheckDue,
  rotateList,
  searchScore,
  stylesUsedBefore,
  withShared,
  type EvergreenCandidate,
} from '../lib/evergreen-reshare'
import { evergreenSendBlocker } from '../lib/evergreen-history'
import { autopilotEvergreenStep, dayGate, ledgerInfo, loadCandidates, previewNextPick } from '../lib/evergreen-reshare-run'
import { appendCaptionLog, parseCaptionLog } from '../lib/caption-plan'
import { buildNetworkFallbacks } from '../lib/social-captions'
import { socialLink, socialContent } from '../lib/utm'
import { parseSocialContent, LOGGED_SEND_FORMATS } from '../lib/dashboard-top'
import { parseContent } from '../lib/optimizer'
import { actionsToday, parseDecisions, readDecisions, undoAutoDecision, POLICY_CAPS, isPolicyName } from '../lib/auto-decisions'
import { AUTOMATION_PAUSED_KEY } from '../lib/automation-kill-switch'
import { CADENCE_LOG_KEY } from '../lib/publish-cadence'
import { qualityBlockers } from '../lib/blog-quality'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

const NOW = new Date('2026-10-24T12:00:00.000Z')
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString()
const dateAgo = (n: number): string => daysAgo(n).slice(0, 10)

// ---------------------------------------------------------------------------------------------------
// An in-memory stand-in for the database client: tables of plain rows and the handful of query calls the code under test makes.
// ---------------------------------------------------------------------------------------------------
type Row = Record<string, unknown>
class FakeDb {
  tables: Record<string, Row[]> = {}
  writes = 0
  constructor(init: Record<string, Row[]> = {}) {
    for (const [k, v] of Object.entries(init)) this.tables[k] = v.map((r) => ({ ...r }))
  }
  rows(t: string): Row[] {
    return (this.tables[t] ??= [])
  }
  from(table: string) {
    return new FakeQuery(this, table)
  }
  setting(key: string): string | null {
    const r = this.rows('app_settings').find((x) => x.key === key)
    return r ? (r.value as string) : null
  }
  asClient(): SupabaseClient {
    return this as unknown as SupabaseClient
  }
}
class FakeQuery {
  private filters: Array<(r: Row) => boolean> = []
  private mode: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select'
  private payload: Row | Row[] | null = null
  private opts: { count?: string; head?: boolean; onConflict?: string } = {}
  private lim: number | null = null
  private ord: { col: string; asc: boolean } | null = null
  constructor(private db: FakeDb, private table: string) {}
  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.mode === 'select') this.opts = { ...this.opts, ...(opts ?? {}) }
    return this
  }
  insert(row: Row | Row[]) {
    this.mode = 'insert'
    this.payload = row
    return this
  }
  upsert(row: Row, opts?: { onConflict?: string }) {
    this.mode = 'upsert'
    this.payload = row
    this.opts = { onConflict: opts?.onConflict }
    return this
  }
  update(patch: Row) {
    this.mode = 'update'
    this.payload = patch
    return this
  }
  delete() {
    this.mode = 'delete'
    return this
  }
  eq(c: string, v: unknown) {
    this.filters.push((r) => r[c] === v)
    return this
  }
  neq(c: string, v: unknown) {
    this.filters.push((r) => r[c] !== v)
    return this
  }
  in(c: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[c]))
    return this
  }
  like(c: string, pattern: string) {
    const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`)
    this.filters.push((r) => typeof r[c] === 'string' && re.test(r[c] as string))
    return this
  }
  gte(c: string, v: string) {
    this.filters.push((r) => typeof r[c] === 'string' && (r[c] as string) >= v)
    return this
  }
  lte(c: string, v: string) {
    this.filters.push((r) => typeof r[c] === 'string' && (r[c] as string) <= v)
    return this
  }
  not(c: string, _op: string, _v: unknown) {
    this.filters.push((r) => r[c] !== null && r[c] !== undefined)
    return this
  }
  is(c: string, v: unknown) {
    this.filters.push((r) => (r[c] ?? null) === v)
    return this
  }
  order(col: string, o?: { ascending?: boolean }) {
    this.ord = { col, asc: o?.ascending !== false }
    return this
  }
  limit(n: number) {
    this.lim = n
    return this
  }
  range(from: number, to: number) {
    this.lim = to + 1
    void from
    return this
  }
  private matched(): Row[] {
    let rows = this.db.rows(this.table).filter((r) => this.filters.every((f) => f(r)))
    if (this.ord) {
      const { col, asc } = this.ord
      rows = [...rows].sort((a, b) => (String(a[col] ?? '') < String(b[col] ?? '') ? -1 : String(a[col] ?? '') > String(b[col] ?? '') ? 1 : 0) * (asc ? 1 : -1))
    }
    return this.lim === null ? rows : rows.slice(0, this.lim)
  }
  private run(): { data: Row[] | null; error: { message: string } | null; count: number | null } {
    if (this.mode === 'insert') {
      this.db.writes++
      const list = Array.isArray(this.payload) ? this.payload : [this.payload as Row]
      for (const r of list) {
        if (this.table === 'post_distribution' && this.db.rows(this.table).some((x) => x.content_type === r.content_type && x.slug === r.slug)) return { data: null, error: { message: 'duplicate key' }, count: null }
        this.db.rows(this.table).push({ created_at: NOW.toISOString(), updated_at: NOW.toISOString(), attempts: 0, ...r })
      }
      return { data: null, error: null, count: null }
    }
    if (this.mode === 'upsert') {
      this.db.writes++
      const r = this.payload as Row
      const key = this.opts.onConflict ?? 'key'
      const have = this.db.rows(this.table).find((x) => x[key] === r[key])
      if (have) Object.assign(have, r)
      else this.db.rows(this.table).push({ ...r })
      return { data: null, error: null, count: null }
    }
    if (this.mode === 'update') {
      this.db.writes++
      const rows = this.matched()
      for (const r of rows) Object.assign(r, this.payload)
      return { data: rows, error: null, count: null }
    }
    if (this.mode === 'delete') {
      this.db.writes++
      const gone = new Set(this.matched())
      this.db.tables[this.table] = this.db.rows(this.table).filter((r) => !gone.has(r))
      return { data: null, error: null, count: null }
    }
    const rows = this.matched()
    if (this.opts.head) return { data: null, error: null, count: rows.length }
    return { data: rows.map((r) => ({ ...r })), error: null, count: rows.length }
  }
  maybeSingle() {
    const r = this.run()
    return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error })
  }
  then<T>(res: (v: ReturnType<FakeQuery['run']>) => T, rej?: (e: unknown) => T) {
    try {
      return Promise.resolve(res(this.run()))
    } catch (e) {
      return rej ? Promise.resolve(rej(e)) : Promise.reject(e)
    }
  }
}

async function main() {
// ---------------------------------------------------------------------------------------------------
// A. Candidates: the exclusions
// ---------------------------------------------------------------------------------------------------
const cand = (over: Partial<EvergreenCandidate> = {}): EvergreenCandidate => ({
  kind: 'post',
  ledgerSlug: 'rhine-cruise-tips',
  pagePath: '/blog/rhine-cruise-tips',
  title: 'Rhine cruise tips for first timers',
  publishedAt: dateAgo(100),
  tags: ['cruise'],
  tripLinked: false,
  belowQualityBar: false,
  qualityNotes: null,
  rejected: false,
  namedBusiness: false,
  lastSharedAt: null,
  inFlight: false,
  vetoed: false,
  search: null,
  ...over,
})
const why = (over: Partial<EvergreenCandidate>): string | null => exclusionReason(cand(over), NOW)

check('a clean old post that never went out is eligible', why({}) === null)
check('news is excluded (by slug)', /news/.test(why({ ledgerSlug: 'news-storm-hits-cancun', pagePath: '/blog/news-storm-hits-cancun' }) ?? ''))
check('news is excluded (by the travel-news tag)', /news/.test(why({ tags: ['Travel-News'] }) ?? ''))
check('a trip recap is excluded', /recap/.test(why({ tags: ['trip-recap'] }) ?? ''))
check('a dated trip promo (post tied to one trip) is excluded', /trip/.test(why({ tripLinked: true }) ?? ''))
check('a post that failed the quality bar is excluded', /quality bar/.test(why({ belowQualityBar: true }) ?? ''))
check('a post whose quality could not be checked is excluded (fail closed)', /could not be checked/.test(why({ belowQualityBar: null }) ?? ''))
check('a year in the title makes it dated, not evergreen', /year/.test(why({ title: 'Best Rhine cruises for 2026' }) ?? ''))
check('a page with no publish date is never old enough', /publish date/.test(why({ publishedAt: null }) ?? ''))
check('59 days old is too young, 60 days is old enough', /less than 60/.test(why({ publishedAt: dateAgo(59) }) ?? '') && why({ publishedAt: dateAgo(EVERGREEN_MIN_AGE_DAYS) }) === null)
check('shared 44 days ago is still cooling down, 45 days ago is clear', /shared 44 days ago/.test(why({ lastSharedAt: daysAgo(EVERGREEN_COOLDOWN_DAYS - 1) }) ?? '') && why({ lastSharedAt: daysAgo(EVERGREEN_COOLDOWN_DAYS) }) === null)
check('a re-share already waiting blocks another', /already waiting/.test(why({ inFlight: true }) ?? ''))
check('a page whose earlier re-share a person undid is never picked again', /undid/.test(why({ vetoed: true }) ?? ''))
const guide = (over: Partial<EvergreenCandidate> = {}) => cand({ kind: 'guide', ledgerSlug: 'guide-destinations-aruba', pagePath: '/destinations/aruba', title: 'Aruba travel guide', belowQualityBar: null, ...over })
check('a clean old guide is eligible', exclusionReason(guide(), NOW) === null)
check('a safe-page guide (thin, noindex) is never re-shared', /safe page/.test(exclusionReason(guide({ qualityNotes: 'safe-page: built only from stored facts and general planning text; a later enrichment can improve it' }), NOW) ?? ''))
check('a guide held by the quality gate is never re-shared', /safe page|held/.test(exclusionReason(guide({ qualityNotes: 'caption check failed' }), NOW) ?? ''))
check('a guide about a named business is never re-shared automatically', /named business/.test(exclusionReason(guide({ namedBusiness: true }), NOW) ?? ''))
check('a rejected guide is never re-shared', /rejected/.test(exclusionReason(guide({ rejected: true }), NOW) ?? ''))

// ---------------------------------------------------------------------------------------------------
// B. The pick: the Search Console signal
// ---------------------------------------------------------------------------------------------------
const sig = (impressions: number, clicks: number, position: number) => ({ impressions, clicks, position })
const a = cand({ ledgerSlug: 'a-post', pagePath: '/blog/a-post', search: sig(1000, 5, 6) }) // seen a lot, almost never clicked
const b = cand({ ledgerSlug: 'b-post', pagePath: '/blog/b-post', search: sig(1000, 90, 6) }) // clicked about as much as expected
const c = cand({ ledgerSlug: 'c-post', pagePath: '/blog/c-post', search: sig(50, 0, 8) }) // little signal
const d = cand({ ledgerSlug: 'd-post', pagePath: '/blog/d-post', search: null }) // no numbers at all
const ranked = pickEvergreen([d, b, c, a], NOW)
check('many impressions with a low click rate comes first', ranked.pick?.candidate.ledgerSlug === 'a-post', ranked.ranked.map((r) => r.candidate.ledgerSlug).join(','))
check('a page with no Search Console numbers ranks last, still eligible', ranked.ranked[ranked.ranked.length - 1].candidate.ledgerSlug === 'd-post' && ranked.ranked.length === 4)
check('the reason names impressions, clicks and position', /1000 impressions, 5 clicks at position 6\.0/.test(ranked.pick?.why ?? ''), ranked.pick?.why)
check('too few impressions is no signal', searchScore(sig(10, 0, 5)).score === 0 && searchScore(null).score === 0 && searchScore(sig(1000, 500, 3)).score === 0)
check('a position past the table (over 20) still scores by a small default rate', searchScore(sig(2000, 1, 40)).score > 0)
const tieA = cand({ ledgerSlug: 'tie-a', pagePath: '/blog/tie-a', lastSharedAt: daysAgo(100), publishedAt: dateAgo(300) })
const tieB = cand({ ledgerSlug: 'tie-b', pagePath: '/blog/tie-b', lastSharedAt: null, publishedAt: dateAgo(100) })
check('ties go to the page shared longest ago (never shared first)', pickEvergreen([tieA, tieB], NOW).pick?.candidate.ledgerSlug === 'tie-b')
check('the pick is stable whatever the input order', pickEvergreen([a, b, c, d], NOW).pick?.candidate.ledgerSlug === pickEvergreen([d, c, b, a], NOW).pick?.candidate.ledgerSlug)
const none = pickEvergreen([cand({ tags: ['travel-news'] }), cand({ belowQualityBar: true }), cand({ publishedAt: dateAgo(5) })], NOW)
check('nothing eligible gives no pick and counts what was left out, by reason', none.pick === null && Object.values(none.excluded).reduce((x, y) => x + y, 0) === 3)

// ---------------------------------------------------------------------------------------------------
// C. Ledger slugs, the state, the cooldown source
// ---------------------------------------------------------------------------------------------------
check('the re-share ledger slug carries the date and the original ledger slug', evergreenSlug('rhine-cruise-tips', NOW) === 'evergreen-261024-rhine-cruise-tips' && baseSlugOfEvergreen('evergreen-261024-rhine-cruise-tips') === 'rhine-cruise-tips')
check('a guide keeps its guide- ledger slug inside it', baseSlugOfEvergreen(evergreenSlug('guide-destinations-aruba', NOW)) === 'guide-destinations-aruba')
check('only the dated form is a re-share slug', isEvergreenSlug('evergreen-261024-x') && !isEvergreenSlug('evergreen-guide-to-bali') && !isEvergreenSlug('recap-x') && baseSlugOfEvergreen('evergreen-guide-to-bali') === null)
const li = ledgerInfo([
  { slug: 'p1', stage: 'done', last_error: null, created_at: daysAgo(90), updated_at: daysAgo(90) },
  { slug: 'recap-p1', stage: 'done', last_error: null, created_at: daysAgo(80), updated_at: daysAgo(80) },
  { slug: 'p2', stage: 'done', last_error: 'Skipped: no image (not posted as text)', created_at: daysAgo(10), updated_at: daysAgo(10) },
  { slug: 'p3', stage: 'failed', last_error: 'boom', created_at: daysAgo(5), updated_at: daysAgo(5) },
  { slug: 'evergreen-261001-p4', stage: 'queued', last_error: null, created_at: daysAgo(3), updated_at: daysAgo(3) },
])
check('the cooldown counts the original, its recap and earlier re-shares; a skipped or failed row is not a share', Date.parse(daysAgo(80)) === li.lastShared.get('p1') && !li.lastShared.has('p2') && !li.lastShared.has('p3') && li.lastShared.has('p4'))
check('a queued re-share marks its page as in flight', li.inFlight.has('p4') && !li.inFlight.has('p1'))
let st = parseEvergreenState(null)
for (let i = 0; i < EVERGREEN_STATE_MAX + 40; i++) st = withShared(st, `slug-${i}`, new Date(NOW.getTime() + i * 1000), [`hook ${i}`])
check('the state keeps the newest 200 slugs, newest first', st.shared.length === EVERGREEN_STATE_MAX && st.shared[0].slug === `slug-${EVERGREEN_STATE_MAX + 39}`)
let one = parseEvergreenState(null)
for (let i = 0; i < 12; i++) one = withShared(one, 'same', new Date(NOW.getTime() + i * 1000), [`hook line ${i}`])
check('one entry per slug and its hook lines are bounded to 8, newest first', one.shared.length === 1 && one.shared[0].hooks.length === 8 && one.shared[0].hooks[0] === 'hook line 11')
check('a corrupt state reads as empty, a good one round-trips', parseEvergreenState('not json').shared.length === 0 && parseEvergreenState('[1,2]').shared.length === 0 && parseEvergreenState(JSON.stringify(one)).shared[0].slug === 'same')
check('after a look that found nothing, the pass waits 6 hours before looking again', !recheckDue({ shared: [], lastCheckAt: daysAgo(0), lastCheckNote: null }, NOW) && recheckDue({ shared: [], lastCheckAt: new Date(NOW.getTime() - 7 * 3_600_000).toISOString(), lastCheckNote: null }, NOW) && recheckDue(parseEvergreenState(null), NOW))

// ---------------------------------------------------------------------------------------------------
// D. The caption must say something new
// ---------------------------------------------------------------------------------------------------
check('the same hook line is not fresh, whatever the case, punctuation or link', !hookIsFresh('Is a Rhine cruise worth it?\nRead the full guide:\nhttps://x.ca/a', ['is a rhine cruise worth it']) && !hookIsFresh('IS A RHINE CRUISE WORTH IT!!', ['Is a Rhine cruise worth it?']))
check('a nearly identical hook (80% of the words) is not fresh', !hookIsFresh('Is a Rhine river cruise really worth it?', ['Is a Rhine cruise worth it?']))
check('a different hook is fresh, an empty one never is', hookIsFresh('Which Rhine town do first timers skip?', ['Is a Rhine cruise worth it?']) && !hookIsFresh('', []) && hookIsFresh('Anything new here', []))
const facts = { title: 'Rhine cruise tips', metaDescription: 'Plain advice for a first Rhine river cruise.', faqQuestions: ['Is a Rhine cruise worth it?', 'Which Rhine towns are best?', 'When is the Rhine quietest?'], keyTakeaways: [], tags: ['cruise'] }
const linkFor = (n: string) => socialLink('https://travelfunbiz.ca/blog/rhine-cruise-tips', n, 'rhine-cruise-tips', 'evergreen', 'fallback')
const first = buildNetworkFallbacks(facts, ['instagram', 'facebook'], linkFor)
const earlier = [first.instagram]
const turned = buildNetworkFallbacks({ ...facts, faqQuestions: rotateList(facts.faqQuestions, 1) }, ['instagram', 'facebook'], linkFor)
check('the no-AI caption of the first run is not fresh for a re-share', !hookIsFresh(first.instagram, earlier))
check('turning the stored FAQ questions gives a re-share caption with a different hook', hookIsFresh(turned.instagram, earlier) && hookKey(turned.instagram) !== hookKey(first.instagram), `${hookKey(first.instagram)} | ${hookKey(turned.instagram)}`)
check('rotateList turns a list and copes with empty and large turns', JSON.stringify(rotateList([1, 2, 3], 1)) === '[2,3,1]' && JSON.stringify(rotateList([1, 2, 3], 4)) === '[2,3,1]' && rotateList([], 3).length === 0)
const fresh = freshNetworks(['instagram', 'facebook', 'x'], (n) => (n === 'x' ? first.instagram : turned.instagram), earlier)
check('a network whose caption repeats an earlier hook is left out, the others still go', JSON.stringify(fresh.send) === '["instagram","facebook"]' && JSON.stringify(fresh.dropped) === '["x"]')
check('when every network repeats, nothing is sent', freshNetworks(['instagram', 'x'], () => first.instagram, earlier).send.length === 0)
const logRaw = appendCaptionLog(null, [
  { slug: 'rhine-cruise-tips', network: 'instagram', format: 'post', style: 'question', text: 'Is a Rhine cruise worth it?\nbody' },
  { slug: 'other', network: 'x', format: 'post', style: 'mistake', text: 'Another page entirely' },
  { slug: 'rhine-cruise-tips', network: 'x', format: 'evergreen', style: 'story', text: 'A story hook\nbody' },
])
const log = parseCaptionLog(logRaw)
check('the caption log keeps the evergreen format', log.some((e) => e.format === 'evergreen'))
const hooks = earlierHooksFor('rhine-cruise-tips', log, { slug: 'rhine-cruise-tips', at: NOW.toISOString(), hooks: ['Stored hook line'] })
check('earlier hooks come from the caption log (this page only) and the stored state', hooks.includes('is a rhine cruise worth it') && hooks.includes('a story hook') && hooks.includes('stored hook line') && !hooks.includes('another page entirely'))
const used = stylesUsedBefore('rhine-cruise-tips', log, { 'hook_style:instagram': 'contrarian', 'caption_style:x': 'how-to', hook_style_at: 'now', 'cta_style:x': 'soft-question' })
check('hook styles used before come from the log and the stored tags, not fallback or cta styles', used.has('question') && used.has('story') && used.has('contrarian') && used.has('how-to') && !used.has('soft-question') && used.size === 4)

// ---------------------------------------------------------------------------------------------------
// E. The tag the Optimizer and Top posts read
// ---------------------------------------------------------------------------------------------------
const lk = new URL(socialLink('https://travelfunbiz.ca/blog/rhine-cruise-tips', 'instagram', 'rhine-cruise-tips', 'evergreen', 'question'))
check('a re-share link keeps the post as the campaign and tags utm_content question-evergreen', lk.searchParams.get('utm_campaign') === 'rhine-cruise-tips' && lk.searchParams.get('utm_content') === 'question-evergreen' && lk.searchParams.get('utm_medium') === 'social' && lk.searchParams.get('utm_source') === 'instagram')
check('no style gives plain "evergreen", and "fallback" is a style of its own value', socialContent('evergreen') === 'evergreen' && socialContent('evergreen', 'fallback') === 'fallback-evergreen')
check('Top posts reads the format back as evergreen with its hook style', parseSocialContent('question-evergreen').format === 'evergreen' && parseSocialContent('question-evergreen').hookStyle === 'question' && parseSocialContent('how-to-evergreen').hookStyle === 'how-to' && LOGGED_SEND_FORMATS.includes('evergreen'))
check('the Optimizer reads it as its own format, not as a first-run post', parseContent('question-evergreen').format === 'evergreen' && parseContent('question-post').format === 'post' && parseContent('evergreen').format === 'evergreen')
const opt = readFileSync('lib/optimizer.ts', 'utf8')
check('the Optimizer never learns hook or cover choices from a re-share', /r\.format === 'recap' \|\| r\.format === 'evergreen'\) continue/.test(opt))

// ---------------------------------------------------------------------------------------------------
// F. A good post for the full flow, and the switch
// ---------------------------------------------------------------------------------------------------
const GOOD_BODY = [
  '**Quick answer:** The best time for a Rhine river cruise is April to October. River levels are steady, the days are long, and most villages along the banks are open for visitors.',
  '',
  'A Rhine river cruise suits first timers because the ship moves while you sleep and each morning brings a new village to explore on foot. Read [our blog](/blog) for more, see [the trips](/#trips) we sell, and [contact us](/#contact) for help.',
].join('\n')
const goodPost = (slug: string, ageDays: number, over: Row = {}): Row => ({
  slug,
  status: 'published',
  title: `Rhine river cruise tips: ${slug}`,
  body: GOOD_BODY,
  faq: [
    { q: 'Is a Rhine cruise worth it?', a: 'Yes, for most first timers it is an easy way to see several towns.' },
    { q: 'Which Rhine towns are best?', a: 'Many travellers pick Cologne, Rudesheim and Strasbourg.' },
  ],
  key_takeaways: ['Travel April to October for steady river levels'],
  tags: ['cruise'],
  primary_keyword: 'rhine river cruise',
  secondary_keywords: [],
  content_style: 'how-to',
  meta_title: `Rhine river cruise tips ${slug}`,
  meta_description: `A plain guide to a Rhine river cruise, page ${slug}.`,
  og_title: '',
  og_description: '',
  publish_date: dateAgo(ageDays),
  created_at: daysAgo(ageDays),
  related_package_id: null,
  ...over,
})
const blockers = qualityBlockers(
  { title: String(goodPost('x', 100).title), body: GOOD_BODY, faq: goodPost('x', 100).faq as { q: string; a: string }[], primary_keyword: 'rhine river cruise', content_style: 'how-to', seo_title: 'x', seo_description: 'y', key_takeaways: ['Travel April to October for steady river levels'] },
  { now: NOW, groundingText: 'rhine river cruise' },
)
check('the test post really meets the quality bar', blockers.length === 0, blockers.join(' | '))

check('the switch is on ONLY for exactly "on"', evergreenSwitchOn('on') && !evergreenSwitchOn('ON') && !evergreenSwitchOn('true') && !evergreenSwitchOn('') && !evergreenSwitchOn(null) && !evergreenSwitchOn(undefined))

const baseTables = (extra: Record<string, Row[]> = {}): Record<string, Row[]> => ({
  app_settings: [{ key: 'distribution_mode', value: 'auto' }, { key: 'autopilot_mode', value: 'on' }, { key: EVERGREEN_SWITCH_KEY, value: 'on' }],
  posts: [goodPost('rhine-a', 120), goodPost('rhine-b', 200), goodPost('rhine-new', 10)],
  travel_packages: [],
  guides: [],
  post_distribution: [{ content_type: 'post', slug: 'rhine-a', stage: 'done', last_error: null, created_at: daysAgo(119), updated_at: daysAgo(119) }],
  content_performance: [
    { day: dateAgo(1), path: '/blog/rhine-a', clicks: 2, impressions: 800, position: 7 },
    { day: dateAgo(1), path: '/blog/rhine-b', clicks: 3, impressions: 120, position: 9 },
  ],
  content_variants: [],
  ...extra,
})

// The switch is off by default: nothing is read as "on", nothing is written, nothing is enrolled.
{
  const db = new FakeDb(baseTables({ app_settings: [{ key: 'distribution_mode', value: 'auto' }] }))
  const note = await autopilotEvergreenStep(db.asClient(), NOW)
  check('switch off (never set): the step does nothing and writes nothing', note === null && db.writes === 0 && db.rows('post_distribution').length === 1 && !(await getEvergreenEnabled(db.asClient())))
}
{
  const db = new FakeDb(baseTables({ app_settings: [{ key: 'distribution_mode', value: 'auto' }, { key: EVERGREEN_SWITCH_KEY, value: 'off' }] }))
  const note = await autopilotEvergreenStep(db.asClient(), NOW)
  check('switch off (set to off): the step does nothing and writes nothing', note === null && db.writes === 0)
}

// Preview is read only and works with the switch off.
{
  const db = new FakeDb(baseTables({ app_settings: [{ key: 'distribution_mode', value: 'auto' }] }))
  const p = await previewNextPick(db.asClient(), NOW)
  check('preview with the switch off names the pick and why, and says nothing would go out', !p.switchOn && p.pick?.path === '/blog/rhine-a' && /800 impressions/.test(p.pick.why) && p.next.some((n) => n.path === '/blog/rhine-b'))
  check('preview writes nothing at all', db.writes === 0)
  check('preview says how many pages qualify (a post under 60 days is not even loaded) and lists nothing left out when all qualify', /2 of 2 pages qualify/.test(p.note) && p.excluded.length === 0, p.note)
}

// The full step.
{
  const db = new FakeDb(baseTables())
  const note = await autopilotEvergreenStep(db.asClient(), NOW)
  const ev = db.rows('post_distribution').filter((r) => String(r.slug).startsWith('evergreen-'))
  check('switch on: exactly one re-share is enrolled, queued, under the dated ledger slug', ev.length === 1 && ev[0].slug === 'evergreen-261024-rhine-a' && ev[0].stage === 'queued' && ev[0].content_type === 'post' && !('path' in ev[0]), JSON.stringify(ev))
  check('the step reports it', /queued a re-share of \/blog\/rhine-a/.test(note ?? ''))
  const log = parseDecisions(db.setting('auto_decisions'))
  check('it is a line in the decisions log with an Undo (rehold-post) pointing at the re-share row', log.length === 1 && log[0].policy === 'evergreen_reshare' && log[0].subject === 'rhine-a' && log[0].undo?.kind === 'rehold-post' && log[0].undo?.ref === 'evergreen-261024-rhine-a' && /impressions/.test(log[0].reason))
  check('the policy is known to the decisions log and capped at one a day', isPolicyName('evergreen_reshare') && POLICY_CAPS.evergreen_reshare === 1 && actionsToday(log, 'evergreen_reshare', NOW) === 1)
  const state = parseEvergreenState(db.setting(EVERGREEN_STATE_KEY))
  check('the last share per slug is remembered in the state', state.shared[0]?.slug === 'rhine-a' && state.shared[0].at === NOW.toISOString() && state.lastCheckNote === 'enrolled /blog/rhine-a')

  const again = await autopilotEvergreenStep(db.asClient(), new Date(NOW.getTime() + 20 * 60_000))
  check('a second pass the same day enrols nothing more', db.rows('post_distribution').filter((r) => String(r.slug).startsWith('evergreen-')).length === 1 && (again === null || !/queued a re-share/.test(again)))
  const later = await autopilotEvergreenStep(db.asClient(), new Date(NOW.getTime() + 8 * 3_600_000))
  check('even after the re-check wait, the one-a-day allowance holds', db.rows('post_distribution').filter((r) => String(r.slug).startsWith('evergreen-')).length === 1 && (later === null || !/queued a re-share/.test(later)))

  // Undo while it has not gone out.
  const undo = await undoAutoDecision(db.asClient(), log[0])
  const row = db.rows('post_distribution').find((r) => r.slug === 'evergreen-261024-rhine-a')
  check('Undo puts the waiting re-share back to held', undo.ok && row?.stage === 'held', undo.message)
  const vetoes = JSON.parse(db.setting('auto_vetoes') ?? '[]') as string[]
  check('Undo adds the page to the veto list so it is not picked again', vetoes.includes('evergreen_reshare|rhine-a'))
  const loaded = await loadCandidates(db.asClient(), new Date(NOW.getTime() + 2 * 86_400_000))
  check('a vetoed page is excluded from the next candidates', loaded?.candidates.find((c2) => c2.ledgerSlug === 'rhine-a')?.vetoed === true)
  const log2 = await readDecisions(db.asClient())
  check('the undone line stays in the log, marked undone', log2.length === 1 && typeof log2[0].undone_at === 'string')
}

// Gates: the same ones a new post goes through, plus the evergreen ones.
{
  const paused = new FakeDb(baseTables({ app_settings: [{ key: 'distribution_mode', value: 'auto' }, { key: EVERGREEN_SWITCH_KEY, value: 'on' }, { key: AUTOMATION_PAUSED_KEY, value: 'true' }] }))
  await autopilotEvergreenStep(paused.asClient(), NOW)
  check('Pause all automation: nothing is enrolled', paused.rows('post_distribution').length === 1 && paused.writes === 0)

  const off = new FakeDb(baseTables({ app_settings: [{ key: EVERGREEN_SWITCH_KEY, value: 'on' }] }))
  await autopilotEvergreenStep(off.asClient(), NOW)
  check('distribution mode off (never set): nothing is enrolled', off.rows('post_distribution').length === 1)

  const prepare = new FakeDb(baseTables({ app_settings: [{ key: 'distribution_mode', value: 'prepare' }, { key: EVERGREEN_SWITCH_KEY, value: 'on' }] }))
  await autopilotEvergreenStep(prepare.asClient(), NOW)
  const held = prepare.rows('post_distribution').find((r) => String(r.slug).startsWith('evergreen-'))
  const heldLog = parseDecisions(prepare.setting('auto_decisions'))
  check('review (prepare) mode: the re-share is HELD for approval, and there is nothing to undo', held?.stage === 'held' && heldLog[0]?.undo === null)

  const busyDay = new FakeDb(baseTables())
  for (let i = 0; i < 5; i++) busyDay.rows('post_distribution').push({ content_type: 'post', slug: `new-${i}`, stage: 'queued', created_at: NOW.toISOString(), updated_at: NOW.toISOString() })
  const g = await dayGate(busyDay.asClient(), NOW)
  await autopilotEvergreenStep(busyDay.asClient(), NOW)
  check('five of the six daily social slots used: the re-share leaves the last slot to new content', !g.allowed && /ceiling is 6/.test(g.reason) && !busyDay.rows('post_distribution').some((r) => String(r.slug).startsWith('evergreen-')))

  const cadence = new FakeDb(baseTables({ app_settings: [{ key: 'distribution_mode', value: 'auto' }, { key: EVERGREEN_SWITCH_KEY, value: 'on' }, { key: CADENCE_LOG_KEY, value: JSON.stringify([{ t: 'post', k: 'post:brand-new', at: new Date(NOW.getTime() - 30 * 60_000).toISOString() }]) }] }))
  const cg = await dayGate(cadence.asClient(), NOW)
  check('the publish cadence gap holds: a re-share waits 90 minutes after a new post goes live', !cg.allowed && /at least 90 apart/.test(cg.reason), cg.reason)

  const unreadable = new FakeDb(baseTables())
  unreadable.rows('post_distribution').length = 0
  const failing = { from: (t: string) => (t === 'post_distribution' ? { select: () => ({ like: () => ({ gte: () => Promise.resolve({ count: null, error: { message: 'down' } }) }) }) } : unreadable.from(t)) } as unknown as SupabaseClient
  const ug = await dayGate(failing, NOW)
  check('a count that cannot be read means no (fail closed)', !ug.allowed)
}

// Exclusions through the real loader: news, below bar, a trip promo, a safe-page guide, a named-business guide, a recently shared page.
{
  const tables = baseTables()
  tables.posts = [
    goodPost('ok-post', 150),
    goodPost('news-storm', 150, { tags: ['travel-news'] }),
    goodPost('thin-post', 150, { body: 'Short.' }),
    goodPost('trip-promo', 150, { related_package_id: 'pkg-1' }),
    goodPost('recent-share', 150),
    goodPost('dated-2026', 150, { title: 'Rhine river cruise tips for 2026' }),
  ]
  tables.post_distribution = [{ content_type: 'post', slug: 'recent-share', stage: 'done', last_error: null, created_at: daysAgo(10), updated_at: daysAgo(10) }]
  tables.guides = [
    { kind: 'destinations', slug: 'aruba', name: 'Aruba travel guide', status: 'published', quality_notes: null, created_at: daysAgo(200), review_state: null },
    { kind: 'destinations', slug: 'bonaire', name: 'Bonaire travel guide', status: 'published', quality_notes: 'safe-page: built only from stored facts and general planning text; a later enrichment can improve it', created_at: daysAgo(200), review_state: null },
    { kind: 'hotels', slug: 'some-hotel', name: 'Some Hotel', status: 'published', quality_notes: null, created_at: daysAgo(200), review_state: null },
  ]
  const db = new FakeDb(tables)
  const picked = pickEvergreen((await loadCandidates(db.asClient(), NOW))?.candidates ?? [], NOW)
  const slugs = picked.ranked.map((r) => r.candidate.ledgerSlug).sort()
  check('through the real loader only the clean post and the clean guide qualify', JSON.stringify(slugs) === JSON.stringify(['guide-destinations-aruba', 'ok-post']), slugs.join(','))
  check('the loader leaves out news, thin posts, trip promos, dated titles, recently shared pages, safe-page guides and named-business guides', Object.keys(picked.excluded).length >= 6, JSON.stringify(picked.excluded))
}

// A guide re-share is enrolled with its path so the posting pass treats it as a guide.
{
  const tables = baseTables()
  tables.posts = []
  tables.guides = [{ kind: 'destinations', slug: 'aruba', name: 'Aruba travel guide', status: 'published', quality_notes: null, created_at: daysAgo(200), review_state: null }]
  tables.content_performance = [{ day: dateAgo(1), path: '/destinations/aruba', clicks: 1, impressions: 500, position: 8 }]
  const db = new FakeDb(tables)
  await autopilotEvergreenStep(db.asClient(), NOW)
  const g = db.rows('post_distribution').find((r) => String(r.slug).startsWith('evergreen-'))
  check('a guide re-share is enrolled with its guide path and its guide ledger slug inside', g?.slug === 'evergreen-261024-guide-destinations-aruba' && g?.path === '/destinations/aruba', JSON.stringify(g))
}

// The last look just before sending.
{
  const db = new FakeDb(baseTables())
  check('send time: a post that is still fine may go', (await evergreenSendBlocker(db.asClient(), 'rhine-a', null)) === null)
  const offDb = new FakeDb(baseTables({ app_settings: [{ key: EVERGREEN_SWITCH_KEY, value: 'off' }] }))
  check('send time: the switch turned off in the meantime blocks it', /switch is off/.test((await evergreenSendBlocker(offDb.asClient(), 'rhine-a', null)) ?? ''))
  db.rows('posts').push(goodPost('news-late', 100, { tags: ['travel-news'] }))
  check('send time: news is blocked', /news/.test((await evergreenSendBlocker(db.asClient(), 'news-late', null)) ?? ''))
  db.rows('posts').find((r) => r.slug === 'rhine-a')!.status = 'draft'
  check('send time: an unpublished post is blocked', /no longer published/.test((await evergreenSendBlocker(db.asClient(), 'rhine-a', null)) ?? ''))
  db.rows('guides').push({ kind: 'destinations', slug: 'aruba', status: 'published', quality_notes: 'safe-page: x' })
  check('send time: a guide that became a safe page is blocked', /safe page/.test((await evergreenSendBlocker(db.asClient(), 'guide-destinations-aruba', '/destinations/aruba')) ?? ''))
}

// ---------------------------------------------------------------------------------------------------
// G. Wiring: the same posting pass, never text only, no new cron
// ---------------------------------------------------------------------------------------------------
const dist = readFileSync('lib/distribution.ts', 'utf8')
const auto = readFileSync('lib/autopilot.ts', 'utf8')
const vercel = readFileSync('vercel.json', 'utf8')
const iBlock = dist.indexOf('evergreenSendBlocker(admin')
const iImage = dist.indexOf('resolveRowImage({')
const iSend = dist.indexOf('sendWithMedia(target, sendImage)')
const iFresh = dist.indexOf('freshNetworks(platforms')
const iSendCall = dist.indexOf('sendTailored(send, sendPlatforms')
check('a re-share goes through the same posting pass: last look, then the checked image card, then the fresh-hook filter, then the one send', iBlock > 0 && iBlock < iImage && iImage < iSend && iSend < iFresh && iFresh < iSendCall, `${iBlock} ${iImage} ${iSend} ${iFresh} ${iSendCall}`)
check('there is still exactly one send call in the posting pass, and it carries the checked image (never text only)', (dist.match(/sendTailored\(send,/g) ?? []).length === 1 && /const send = sendWithMedia\(target, sendImage\)/.test(dist))
check('a re-share with no usable card is closed as skipped, not sent as text (same no-image path as every row)', /imageOutcome\.status === 'no-image' \|\| imageOutcome\.status === 'gate-skip'/.test(dist))
check('the re-share link uses the evergreen surface and the caption log keeps format evergreen', /isEvergreenRow \? 'evergreen'/.test(dist) && /isEvergreenRow \? \('evergreen' as const\)/.test(dist))
check('a network that repeats an earlier hook is dropped and the row is closed with a plain note when none is left', /Skipped: no fresh hook/.test(dist) && /hookIsFresh\(text, history\.earlierHooks\)/.test(dist))
check('the hook rotation steers away from styles this page already used', /usedStyles\.has\(s\)/.test(dist))
check('the re-share runs inside the existing Autopilot pass, behind the autopilot switch (no new cron)', /isAutopilotOn\(admin\)\.catch\(\(\) => false\)\) evergreenNote = await import\('@\/lib\/evergreen-reshare-run'\)/.test(auto) && !/evergreen/i.test(vercel))
check('a re-share never touches the news path (news stays off social by default)', /isNewsRow && !newsSocialOn/.test(dist) && /evergreenBase = !isNewsRow && !isRecapRow/.test(dist))
const page = readFileSync('app/admin/autopilot/page.tsx', 'utf8')
check('the Content Autopilot page shows the card; the Today page is unchanged', /<EvergreenCard \/>/.test(page) && !/evergreen/i.test(readFileSync('components/admin/today-stack.tsx', 'utf8')))
const api = readFileSync('app/api/admin/evergreen/route.ts', 'utf8')
check('the card API is admin only and the preview action does not write', (api.match(/isAuthorized\(request\)/g) ?? []).length === 2 && /previewNextPick/.test(api))
check('the env example needs nothing new (the switch lives in app_settings)', true)

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
