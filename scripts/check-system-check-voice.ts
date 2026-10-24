// Offline wording check for the system check (lib/system-check.ts): plain words only, like the check in Nomad's admin.
// Run: pnpm dlx tsx scripts/check-system-check-voice.ts   (exit 1 on a failure)
//
// Rules proved here, on every sentence the check can say in a green, an all-red and an all-unread fixture:
//  - no jargon word (a word like "stage" or "heartbeat" may live in a label or a code name, never in a sentence);
//  - reading grade 6 or lower on every sentence (Flesch-Kincaid, computed below);
//  - no long dash;
//  - a number that could not be read says "could not be read" and is never a zero, and such a stage is never green.
import {
  STAGE_IDS, STAGE_LABELS, STAGE_NEEDS, evaluateCheck, unreadFacts, checkBriefLines, ageText,
  type CheckFacts, type CheckResult, type WatchdogLike,
} from '../lib/system-check'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

// ---- the reading level -------------------------------------------------------------------------------
function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!w) return 0
  if (/^\d+$/.test(w)) return 1 // a number is read as one beat here: "36" is as easy as "ten"
  let n = (w.replace(/e$/, '').match(/[aeiouy]+/g) ?? []).length
  if (/[^aeiou]le$/.test(w)) n++
  return Math.max(1, n)
}
function grade(sentence: string): number {
  const words = sentence.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w))
  if (words.length === 0) return 0
  const syl = words.reduce((n, w) => n + syllables(w), 0)
  return 0.39 * words.length + 11.8 * (syl / words.length) - 15.59
}
const sentencesOf = (text: string) => text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean)

const JARGON = ['stage', 'heartbeat', 'cron', 'watchdog', 'endpoint', 'null', 'undefined', 'json', 'schema', 'telemetry', 'latency', 'threshold', 'pipeline', 'evidence', 'cadence', 'ctr', 'api', 'webhook', 'queue', 'quota', 'throttle', 'metric', 'parameter', 'sitemap indexing', 'regex', 'token']
const hasJargon = (s: string) => JARGON.find((j) => new RegExp(`(^|[^a-z])${j}s?([^a-z]|$)`, 'i').test(s))
const DASH = /[—–]/

// ---- fixtures ----------------------------------------------------------------------------------------
const NOW = new Date('2026-10-24T15:00:00Z')
const iso = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString()
const wd = (stage: string, status: WatchdogLike['status'], evidence: WatchdogLike['evidence'], unreadable = false): WatchdogLike => ({ stage, status, evidence, ...(unreadable ? { unreadable } : {}) })

const GREEN: CheckFacts = {
  now: NOW,
  watchdog: {
    at: iso(3),
    checks: [
      wd('production', 'ok', { hours_since_last_blog_post: 20, threshold_hours: 72, guides_published_48h: 3, guides_waiting: 5 }),
      wd('quality', 'ok', { posts_below_bar: 2, published_posts: 40 }),
      wd('distribution', 'ok', { mode: 'auto', sends_36h: 4, queued_rows: 1 }),
      wd('discovery', 'ok', { new_pages_missing_from_sitemap: 0 }),
      wd('clicks', 'ok', { underperforming_styles: 0, needs_more_data: 'no' }),
      wd('conversion', 'ok', { pages_with_visits_and_no_leads: 0, visit_floor: 100 }),
      wd('measurement', 'ok', { visit_tracking: 'on', visit_rows_48h: 120 }),
    ],
  },
  crawl: { lastRun: iso(5), errors: 0, warnings: 3 },
  seo: { score: 82, failing: 1 },
  jobs: { autopilot: { light: 'green', ageHours: 0.2 }, daily: { light: 'green', ageHours: 9 } },
  ai: { spend: 0.5, ceiling: 5 },
  orders: { paid30d: 2, webhookFailing: false },
  gateSkips7d: 2,
  decisions: [],
}

const RED: CheckFacts = {
  now: NOW,
  watchdog: {
    at: iso(60),
    checks: [
      wd('production', 'bad', { hours_since_last_blog_post: 100, threshold_hours: 72, guides_published_48h: 0, guides_waiting: 5 }),
      wd('quality', 'bad', { posts_below_bar: 12, published_posts: 40 }),
      wd('distribution', 'bad', { mode: 'auto', sends_36h: 0, queued_rows: 3 }),
      wd('discovery', 'warn', { new_pages_missing_from_sitemap: 4 }),
      wd('clicks', 'warn', { underperforming_styles: 2, needs_more_data: 'no' }),
      wd('conversion', 'warn', { pages_with_visits_and_no_leads: 3, visit_floor: 100, top_page: '/blog/x', top_page_visits: 220 }),
      wd('measurement', 'bad', { visit_tracking: 'on', visit_rows_48h: 0 }),
    ],
  },
  crawl: { lastRun: iso(5), errors: 12, warnings: 3 },
  seo: { score: 20, failing: 9 },
  jobs: { autopilot: { light: 'amber', ageHours: 5 }, daily: { light: 'amber', ageHours: 50 } },
  ai: { spend: 9, ceiling: 5 },
  orders: { paid30d: 0, webhookFailing: true },
  gateSkips7d: 4,
  decisions: [],
}

const AMBER_VARIANTS: CheckFacts[] = [
  { ...GREEN, watchdog: { at: iso(3), checks: [wd('distribution', 'ok', { mode: 'prepare', sends_36h: 0, queued_rows: 0 }), wd('production', 'ok', { hours_since_last_blog_post: 1e6, threshold_hours: 72, guides_published_48h: 0 }), wd('measurement', 'ok', { visit_tracking: 'off', visit_rows_48h: null }), wd('clicks', 'ok', { underperforming_styles: 0, needs_more_data: 'yes' }), wd('distribution', 'warn', { mode: 'auto', sends_36h: 2, queued_rows: 0 })] } },
  { ...GREEN, watchdog: { at: iso(3), checks: [wd('production', 'warn', { hours_since_last_blog_post: 80, threshold_hours: 72, guides_published_48h: 1 })] }, seo: { score: 55, failing: 1 }, ai: { spend: 4.4, ceiling: 5 }, orders: { paid30d: 1, webhookFailing: false }, crawl: { lastRun: iso(5), errors: 2, warnings: 0 } },
  { ...GREEN, watchdog: { at: iso(3), checks: [wd('quality', 'warn', { posts_below_bar: 5, published_posts: 1 }), wd('discovery', 'warn', { new_pages_missing_from_sitemap: 1 })] }, crawl: { lastRun: null, errors: 0, warnings: 0 }, seo: { score: null, failing: 0 }, jobs: { autopilot: { light: 'gray', ageHours: null }, daily: { light: 'green', ageHours: 0.1 } }, orders: { paid30d: 1, webhookFailing: false } },
]

const results: Record<string, CheckResult> = {
  green: evaluateCheck(GREEN),
  red: evaluateCheck(RED),
  unread: evaluateCheck(unreadFacts(NOW)),
  ...Object.fromEntries(AMBER_VARIANTS.map((f, i) => [`variant${i + 1}`, evaluateCheck(f)])),
}

// ---- the rules ---------------------------------------------------------------------------------------
expect('the check has eleven stages in funnel order', STAGE_IDS.join(',') === 'production,quality,distribution,discovery,clicks,conversion,measurement,money,seo,jobs,ai' && Object.values(results).every((r) => r.stages.map((s) => s.id).join(',') === STAGE_IDS.join(',')))

const all: { where: string; text: string }[] = []
for (const [name, r] of Object.entries(results)) {
  for (const s of r.stages) {
    all.push({ where: `${name}/${s.id}`, text: s.sentence })
    if (s.needs) all.push({ where: `${name}/${s.id} needs`, text: s.needs.text })
  }
}
for (const id of STAGE_IDS) all.push({ where: `needs/${id}`, text: STAGE_NEEDS[id].text })
expect('the fixtures give a good spread of sentences', all.length > 80 && new Set(all.map((a) => a.text)).size > 30, String(new Set(all.map((a) => a.text)).size))

const jargon = all.filter((a) => hasJargon(a.text))
expect('no jargon word in any sentence or link text', jargon.length === 0, jargon.map((a) => `${a.where}: "${a.text}" (${hasJargon(a.text)})`).join(' | '))

const hard = all.filter((a) => !a.where.includes('needs')).flatMap((a) => sentencesOf(a.text).map((s) => ({ where: a.where, s, g: grade(s) }))).filter((x) => x.g > 6)
expect('every sentence reads at grade 6 or lower', hard.length === 0, hard.map((x) => `${x.where}: "${x.s}" grade ${x.g.toFixed(1)}`).join(' | '))

expect('no long dash anywhere in the check', all.every((a) => !DASH.test(a.text)) && Object.values(results).every((r) => r.stages.every((s) => !DASH.test(`${s.label}${s.number ?? ''}`))) && !DASH.test(JSON.stringify(STAGE_LABELS)))
expect('every sentence is short: at most 3 sentences and 40 words per stage', Object.values(results).every((r) => r.stages.every((s) => sentencesOf(s.sentence).length <= 3 && s.sentence.split(/\s+/).length <= 40)), '')
expect('every sentence starts with a capital letter and ends with a full stop', all.filter((a) => !a.where.includes('needs')).every((a) => sentencesOf(a.text).every((s) => /^[A-Z0-9$]/.test(s) && /[.!?]$/.test(s))))

// ---- unread facts ------------------------------------------------------------------------------------
const unread = results.unread
expect('when nothing can be read, no stage is green', unread.stages.every((s) => s.light !== 'green' && !s.read), unread.stages.map((s) => `${s.id}:${s.light}`).join(','))
expect('an unread stage says "could not be read" and shows no number', unread.stages.every((s) => /could not be read/.test(s.sentence) && s.number === null), unread.stages.filter((s) => !/could not be read/.test(s.sentence)).map((s) => s.sentence).join(' | '))
expect('an unread stage never prints a zero', unread.stages.every((s) => !/(^|[^\d])0([^\d]|$)/.test(s.sentence)))
expect('an unread check is amber overall, never green and never red', unread.overall === 'amber')

// A stage whose own number is missing inside a readable answer
const partial = evaluateCheck({ ...GREEN, watchdog: { at: iso(3), checks: [wd('production', 'warn', { hours_since_last_blog_post: null }, true), wd('quality', 'ok', { posts_below_bar: null, published_posts: 10 })] } })
const p = (id: string) => partial.stages.find((s) => s.id === id)!
expect('a watchdog answer that says it could not read is amber and says so', p('production').light === 'amber' && /could not be read/.test(p('production').sentence) && !p('production').read)
expect('a missing number inside a good answer is amber, not a zero', p('quality').light === 'amber' && /could not be read/.test(p('quality').sentence) && p('quality').number === null)
expect('a stage the watchdog has not looked at yet is amber and says so', p('clicks').light === 'amber' && /has not looked/.test(p('clicks').sentence) && !p('clicks').read)

// ---- the verdicts ------------------------------------------------------------------------------------
expect('the all-green fixture is green on every stage', results.green.overall === 'green' && results.green.stages.every((s) => s.light === 'green' && s.read && s.needs === null), results.green.stages.filter((s) => s.light !== 'green').map((s) => `${s.id}:${s.light}:${s.sentence}`).join(' | '))
expect('the all-red fixture is red and names production first', results.red.overall === 'red' && results.red.worst?.id === 'production')
expect('every non-green stage says what needs you, with a page', Object.values(results).every((r) => r.stages.every((s) => (s.light === 'green') === (s.needs === null) && (!s.needs || s.needs.href.startsWith('/admin')))))
expect('the numbers are real: a sentence carries the number the facts held', /20 hours ago/.test(results.green.stages[0].sentence) && /2 of 40/.test(results.green.stages[1].sentence) && /4 posts went out/.test(results.green.stages[2].sentence) && /82 out of 100/.test(results.green.stages.find((s) => s.id === 'seo')!.sentence) && /\$0\.50/.test(results.green.stages.find((s) => s.id === 'ai')!.sentence))
expect('over the AI limit is red and amber starts at 80 percent', results.red.stages.find((s) => s.id === 'ai')!.light === 'red' && results.variant2.stages.find((s) => s.id === 'ai')!.light === 'amber')
expect('a reachable zero is allowed when it is real (no payments in 30 days is green)', evaluateCheck({ ...GREEN, orders: { paid30d: 0, webhookFailing: false } }).stages.find((s) => s.id === 'money')!.light === 'green')
expect('ages read in plain words', ageText(0.3) === 'under an hour' && ageText(5) === '5 hours' && ageText(60) === '3 days' && ageText(1) === '1 hour')

// ---- the brief lines ----------------------------------------------------------------------------------
const lines = checkBriefLines(results.red)
expect('the brief lines start with the counts, list at most 4 stages and have no long dash', /^System check: \d+ green, \d+ amber, \d+ red\.$/.test(lines[0]) && lines.length <= 5 && lines.every((l) => !DASH.test(l)))
expect('an unreadable check says so in the brief', checkBriefLines(null)[0] === 'System check: could not be read.')

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.')
process.exit(failures ? 1 : 0)
