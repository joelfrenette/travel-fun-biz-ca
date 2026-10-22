// QA checks for "heal-relax": adversarial probes of the gate and the repairs, the safe-page search rules (noindex, sitemap, link feeds),
// the daily runner's retry rules for rejected drafts, and the heal-guides-now script's guard rails. No network, no database, no AI call.
// Run: pnpm dlx tsx scripts/check-heal-relax-qa.ts
import { readFileSync } from 'node:fs'

process.env.ANTHROPIC_API_KEY = ''
process.env.INDEXNOW_KEY = ''

import { fakeAdmin, type Db } from './fake-admin'
import { guideKinds, isSafePageNote, SAFE_PAGE_NOTE as SAFE_NOTE_GUIDES, withoutThinPages, type GuideKind } from '../lib/guides'
import { groundingText, guideBlockers, namedThingsNotInBrief, type GateContext, type GuideBrief } from '../lib/guide-composer'
import {
  APPROVED_CTA_LINKED,
  APPROVED_CTA_PLAIN,
  APPROVED_CTA_SHORT,
  SAFE_PAGE_NOTE,
  buildSafePage,
  fieldsToGuide,
  fixAgencySentences,
  isProtectedSentence,
  nameInOpening,
  parentFromGrounding,
  repairGuideFields,
  safePool,
  type GuideRepairCfg,
} from '../lib/guide-repairs'
import { GUIDE_LIMITS } from '../lib/content-repair-adapters'
import { Tracker, type RepairFields } from '../lib/content-repair'
import { memoryBudget } from '../lib/heal-loop'
import { healComposedGuide } from '../lib/heal-targets'
import { GUIDES_HEALED_PER_DAY, healGuideRow, isHealDraftCandidate, isNowCandidate, selectHealDrafts, type GuideBriefParts } from '../lib/heal-drafts'
import { GUESSED_PROPERTY_NOTE, decideGuideSave } from '../lib/guide-run'
import { REJECTED_RETRY_DAYS } from '../lib/guides'

const LONG_DASH = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']')
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failed++
}
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

const ALLOWED = new Set(['/', '/packages', '/destinations/jamaica', '/packages/jamaica-sun'])
const LINKS = [
  { path: '/packages/jamaica-sun', label: 'the "Jamaica Sun" trip' },
  { path: '/destinations/jamaica', label: 'our Jamaica page' },
  { path: '/packages', label: 'all our trips' },
  { path: '/#contact', label: 'the contact form' },
]
function brief(kind: GuideKind, name: string, parentName: string | null): GuideBrief {
  return { kind, name, parentName, packages: [{ name: 'Jamaica Sun', slug: 'jamaica-sun', destination: 'Jamaica', category: 'singles', short_description: 'A relaxed week for solo travellers.', year: '2027' }], keywords: [], blurb: null, links: LINKS }
}
const ctxFor = (b: GuideBrief): GateContext => ({ grounding: groundingText(b), allowedPaths: ALLOWED, names: [...(b.parentName ? [b.parentName] : []), ...b.links.map((l) => l.label)] })
const cfgFor = (kind: GuideKind, name: string, ctx: GateContext): GuideRepairCfg => ({ kind, name, grounding: ctx.grounding, names: ctx.names ?? [], links: LINKS, limits: GUIDE_LIMITS })

function scripted(h: { suggest?: () => string | null; judge?: () => string | null } = {}) {
  let total = 0
  const model = async (prompt: string): Promise<string | null> => {
    total++
    if (/independent quality reviewer/.test(prompt)) return (h.judge ?? (() => '{"pass":true,"failures":[]}'))()
    if (/repairing sentences/.test(prompt)) return (h.suggest ?? (() => '{"rewrites":[]}'))()
    return null
  }
  return { model, total: () => total }
}

async function main() {
  // ================================================================================================
  // 1. SAFETY: invented names still fail; the repairs add no claim; legal text is kept; the CTA is honest
  // ================================================================================================
  const NAMED_KINDS: [GuideKind, string, string | null][] = [
    ['hotels', 'Sea View Hotel', 'Lisbon'],
    ['resorts', 'Atlantis Paradise Island', null],
    ['ships', 'Wonder of the Seas', 'Royal Caribbean International'],
    ['river-cruises', 'Rhine Castles River Cruise', 'Germany'],
    ['yachts', 'Seven Seas Explorer', null],
    ['cruise-lines', 'Royal Caribbean International', null],
    ['destinations', 'Jamaica', null],
  ]
  const INVENTED = [
    'Guests often stay at the Hilton Cancun when they visit.',
    'Many travellers book Hotel Esperanza for the pool.',
    'Dinner at Le Bernardin is a highlight of the trip.',
    'A cabin on Symphony of the Seas has a balcony.',
    'The chef Gordon Ramsay has opened a restaurant nearby.',
    'Staying at the Sandals Royal Caribbean is popular.',
    'Cruises with Norwegian Cruise Line sail from the port.',
    'The Four Seasons Bali is a quiet base.',
  ]
  for (const [kind, name, parent] of NAMED_KINDS) {
    const b = brief(kind, name, parent)
    const ctx = ctxFor(b)
    const page = buildSafePage({ kind, name, parentName: parentFromGrounding(ctx.grounding), links: LINKS, limits: GUIDE_LIMITS }, ctx)
    if (!page) {
      check(`Q1(${kind}): a safe page exists`, false)
      continue
    }
    const missed: string[] = []
    const survived: string[] = []
    for (const venue of INVENTED) {
      const f = { ...page, body: page.body.replace(/^## About .*\n\n/, (m) => `${m}${venue} `) }
      const g = fieldsToGuide(f, name, guideKinds[kind].guideLabel, `${name} guide`)
      if (!guideBlockers(g, ctx).some((x) => /named venue or person/.test(x))) missed.push(venue)
      // the plain-code repairs must not make an invented name disappear from the gate's view without removing it
      const repaired = repairGuideFields(f, cfgFor(kind, name, ctx), guideBlockers(g, ctx), new Tracker())
      const after = fieldsToGuide(repaired, name, guideKinds[kind].guideLabel, `${name} guide`)
      const stillThere = repaired.body.includes(venue.split(' ').slice(0, 3).join(' '))
      if (stillThere && !guideBlockers(after, ctx).some((x) => /named venue or person/.test(x))) survived.push(venue)
    }
    check(`Q1(${kind}): invented hotel, ship, restaurant and person names fail "named venue or person not in brief"`, missed.length === 0, JSON.stringify(missed))
    check(`Q2(${kind}): the plain-code repairs never launder an invented name past the gate`, survived.length === 0, JSON.stringify(survived))
  }

  {
    // the geography allowlist: only phrases made wholly of place words pass; brand-like phrases built from place words still need a non-place word
    const fails = ['Stay at the Hilton Jamaica tonight.', 'Dinner at Paris Hilton was fun.', 'Sail with Virgin Voyages from Miami.', 'Ride Hawaiian Airlines to the island.', 'Visit Disney Cruise Line in the Bahamas.', 'Book Singapore Airlines for the flight.', 'Meet Jordan Peterson in town.']
    const bad = fails.filter((s) => namedThingsNotInBrief(s, '').length === 0)
    check('Q3: brand and person phrases that merely contain a place word still fail', bad.length === 0, JSON.stringify(bad))
  }

  // opening-paragraph repair adds no claim
  {
    const odd = ['It is the best resort in the region.', 'This island is home to 40 beaches.', '']
    const outs = odd.map((s) => nameInOpening(s, 'Jamaica', 'destinations'))
    const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
    const allowedNew = new Set([...words('Jamaica'), 'this', 'is', 'about', ...words(guideKinds.destinations.guideLabel)])
    const added = outs.map((o, i) => words(o).filter((w) => !words(odd[i]).includes(w) && !allowedNew.has(w)))
    check('Q4: the opening repair adds only the stored name, the kind label and a few joining words (no digit, no claim word); a claim already in the text is left for the gate', added.every((a) => a.length === 0) && outs.every((o, i) => (o.match(/\d+/g) ?? []).every((d) => odd[i].includes(d))), JSON.stringify({ outs, added }))
  }

  // agency-sentence replacement must keep legally important text
  {
    const name = 'Jamaica'
    const b = brief('destinations', name, null)
    const ctx = ctxFor(b)
    const keep = [
      'We do not provide refunds on bookings made directly with the resort.',
      'We are not responsible for changes the provider makes to a schedule.',
      'We never offer insurance, so please arrange your own cover.',
      'We have no affiliation with the resort and earn a commission on some bookings.',
      "Our team can't guarantee availability at any hotel.",
    ]
    const sell = ['We offer hosted group trips to the island.', 'Our team arranges small group tours in the region.']
    const base: RepairFields = {
      summary: 'Jamaica is an island. It suits relaxed travel.',
      body: `## About Jamaica\n\n${keep.join(' ')} ${sell.join(' ')} Warm water is common.\n`,
      meta_title: 'a', meta_description: 'b', og_title: 'c', og_description: 'd',
      faq: [{ q: 'Do you offer refunds?', a: 'We do not provide refunds on bookings made directly with the resort.' }, { q: 'What do you offer?', a: 'We offer hosted group trips to the island.' }],
      key_takeaways: ['We are not responsible for provider changes.', 'We offer hosted group trips.'],
    }
    const t = new Tracker()
    const fixed = fixAgencySentences(base, cfgFor('destinations', name, ctx), t)
    check('Q5: protected (limiting or legal) sentences are recognised', keep.every(isProtectedSentence) && !sell.some(isProtectedSentence), JSON.stringify(keep.filter((k) => !isProtectedSentence(k))))
    check('Q5b: every protected sentence in the body, FAQ and takeaways survives the agency repair', keep.every((k) => fixed.body.includes(k)) && fixed.faq.some((p) => p.a.includes('We do not provide refunds')) && fixed.key_takeaways.some((x) => x.includes('not responsible')), JSON.stringify(fixed))
    check('Q5c: the selling sentences are still replaced or removed', !/We offer hosted group trips|arranges small group/.test(fixed.body) && !fixed.faq.some((p) => /We offer hosted/.test(p.a)) && !fixed.key_takeaways.some((x) => /We offer hosted/.test(x)), JSON.stringify(fixed))
  }

  // the approved CTA is honest, short of promises, and has no phone digits
  {
    const ctas = [APPROVED_CTA_LINKED, APPROVED_CTA_PLAIN, APPROVED_CTA_SHORT]
    check('Q6: no approved CTA holds a digit, a phone pattern, a dash, a price or a promise of a result', ctas.every((c) => !/\d/.test(c) && !LONG_DASH.test(c) && !/\b(?:call|phone|tel|toll|free|guarantee|best|lowest|cheapest|book|booking|licen[cs]ed|certified|expert|specialist)\b/i.test(c)), JSON.stringify(ctas))
    check('Q6b: the linked CTA points at the contact form that exists on the home page', /\(\/#contact\)/.test(APPROVED_CTA_LINKED) && /id="contact"/.test(src('app/page.tsx')))
    const pool = safePool('hotels', 'Sea View Hotel')
    const all = `${JSON.stringify(pool)} ${buildSafePage({ kind: 'hotels', name: 'Sea View Hotel', parentName: null, links: LINKS, limits: GUIDE_LIMITS }, ctxFor(brief('hotels', 'Sea View Hotel', null)))?.body ?? ''}`
    check('Q6c: the safe page makes no promise to book, arrange or handle anything for the guest', !/\b(?:we|our team|our advisors?) (?:will|can) (?:book|arrange|handle|organi[sz]e)\b|handle the booking|help with the booking/i.test(all), all.match(/.{30}booking steps.{20}/)?.[0] ?? '')
  }

  // phone numbers: the gate refuses a digit run the stored facts do not hold, and no brief carries a host's phone
  {
    const b = brief('destinations', 'Jamaica', null)
    const ctx = ctxFor(b)
    const page = buildSafePage({ kind: 'destinations', name: 'Jamaica', parentName: null, links: LINKS, limits: GUIDE_LIMITS }, ctx)!
    const withPhone = { ...page, body: page.body.replace(/^## About .*\n\n/, (m) => `${m}Call our host on 604-555-0199 or +1 (778) 555 0123 to talk it over. `) }
    const blockers = guideBlockers(fieldsToGuide(withPhone, 'Jamaica', 'Travel Guide', 'jamaica travel guide'), ctx)
    check('Q7: a phone number in the body is refused by the gate (digits not in the stored facts)', blockers.length > 0, JSON.stringify(blockers))
    const repaired = repairGuideFields(withPhone, cfgFor('destinations', 'Jamaica', ctx), blockers, new Tracker())
    check('Q7b: no repair step adds a digit', ((repaired.body.replace(withPhone.body, '').match(/\d/g) ?? []).length === 0) && !/\d/.test(page.body.replace(/\]\([^)]*\)/g, ']')), '')
    const composer = src('lib/guide-composer.ts') + src('lib/guide-run.ts') + src('lib/heal-drafts.ts')
    check('Q7c: the guide brief and grounding never read a phone, host or contact column', !/\.select\([^)]*(?:phone|host_|contact)/i.test(composer) && !/groundingText[\s\S]{0,800}phone/i.test(src('lib/guide-composer.ts')))
    const grounding = groundingText({ ...b, packages: b.packages })
    check('Q7d: the grounding text for a brief holds no phone-like digit run', !/\d{3}[-.\s)]+\d{3,4}/.test(grounding.replace(/\b20\d\d\b/g, '')), grounding.slice(0, 200))
  }

  // guessed names: never published, through the real row path, for every property kind, even when the ladder ends in a safe page
  {
    const failingModel = scripted({ suggest: () => '{"rewrites":[{"id":0,"text":"Even better, the finest bars."}]}', judge: () => '{"pass":false,"failures":[{"quote":"x","reason":"unsupported"}]}' })
    for (const [kind, name, parent] of NAMED_KINDS.filter(([k]) => k !== 'destinations')) {
      const b = brief(kind, name, parent)
      const ctx = ctxFor(b)
      const page = buildSafePage({ kind, name, parentName: parentFromGrounding(ctx.grounding), links: LINKS, limits: GUIDE_LIMITS }, ctx)!
      const dirty = page.body.replace(/^## About .*\n\n/, (m) => `${m}The best bars are famous and hundreds of guests agree. `)
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      const row = {
        id: `g-${slug}`, kind, slug, name, parent_slug: null, status: 'draft', source: 'ai', review_state: null, quality_notes: `superlative or rating claim (best); ${GUESSED_PROPERTY_NOTE}`,
        created_at: new Date(Date.now() - 86_400_000).toISOString(), updated_at: new Date(Date.now() - 86_400_000).toISOString(),
        summary: 'Warm water and music fill the days.', body: dirty, sections: [], faq: page.faq, key_takeaways: page.key_takeaways,
        meta_title: page.meta_title, meta_description: page.meta_description, og_title: page.og_title, og_description: page.og_description, primary_keyword: `${name} guide`, secondary_keywords: [],
      }
      const db: Db = { tables: { app_settings: [{ key: 'guides_publish_mode', value: 'publish' }], content_edits: [], guides: [row] } }
      const parts: GuideBriefParts = { ctx, links: LINKS }
      const r = await healGuideRow(fakeAdmin(db), db.tables.guides[0], { now: new Date(), model: failingModel.model, guideBrief: async () => parts, budget: memoryBudget(60), skipClaim: true })
      const saved = db.tables.guides[0]
      check(`Q8(${kind}): a guessed name is never published, and keeps the "taken from a trip title" note, even when the heal ends in a safe page`, saved.status === 'draft' && r.action !== 'published' && /taken from a trip title/.test(String(saved.quality_notes)) && !isSafePageNote(String(saved.quality_notes)), JSON.stringify({ r: r.action, ladder: r.ladder, status: saved.status, notes: saved.quality_notes }))
    }
    const outcome = { status: 'healed' as const, ladder: ['safe-page' as const], rounds: 5, calls: 3, note: '', reasons: [], edits: [] }
    check('Q8b: decideGuideSave(guessed, safe page) is a draft with the guessed note, for every property kind', NAMED_KINDS.every(() => { const d = decideGuideSave(true, { publish: true, note: null }, outcome as never); return !d.publish && /taken from a trip title/.test(d.note ?? '') }))
    const live = decideGuideSave(false, { publish: true, note: null }, outcome as never)
    check('Q8c: a non-guessed safe page is published with exactly the safe-page note', live.publish && live.note === SAFE_PAGE_NOTE && SAFE_PAGE_NOTE === SAFE_NOTE_GUIDES)
  }

  // ================================================================================================
  // 2. SEO: a safe page is live but not indexable, not in the sitemap, llms.txt or the related feeds
  // ================================================================================================
  {
    check('S1: isSafePageNote matches the note, with or without leading space, and nothing else', isSafePageNote(SAFE_PAGE_NOTE) && isSafePageNote('  safe-page: x') && !isSafePageNote(null) && !isSafePageNote('') && !isSafePageNote('Rejected by heal: safe-page: x') && !isSafePageNote(GUESSED_PROPERTY_NOTE))
    const rows = [
      { slug: 'a', quality_notes: null },
      { slug: 'b', quality_notes: SAFE_PAGE_NOTE },
      { slug: 'c', quality_notes: '' },
      { slug: 'd', quality_notes: 'something else' },
    ]
    const kept = withoutThinPages(rows)
    check('S2: withoutThinPages drops safe pages only, and strips the admin note from what remains', kept.map((r) => r.slug).join(',') === 'a,c,d' && kept.every((r) => !('quality_notes' in r)), JSON.stringify(kept))
    check('S3: removing the note (an enrichment, or an admin publish) makes the page indexable and listed again', withoutThinPages([{ slug: 'b', quality_notes: null }]).length === 1)
    const g = src('lib/guides.ts')
    check('S4: the sitemap read, the link feeds (related, llms.txt, autoblog, destination properties) and the public read all go through the safe-page rule', /getPublishedGuidePaths[\s\S]*?withoutThinPages/.test(g) && /listPublishedGuideLinks[\s\S]*?withoutThinPages/.test(g) && /listPropertyGuidesForDestination[\s\S]*?withoutThinPages/.test(g) && /thin: isSafePageNote\(notes\)/.test(g))
    check('S5: the guide page metadata sets robots noindex only for a thin page', /guide\.thin \? \{ robots: \{ index: false, follow: true \} \} : \{\}/.test(src('components/guide-page.tsx')))
    check('S6: a destination page does not take its search metadata from a thin guide', /guide && !guide\.thin\) return guideMetadata/.test(src('app/destinations/[slug]/page.tsx')))
    check('S7: llms.txt and the sitemap read only those filtered feeds', /listPublishedGuideLinks/.test(src('lib/llms-txt.ts')) && /getPublishedGuidePaths/.test(src('app/sitemap.ts')))
    check('S8: a safe page is not announced to IndexNow (writer, daily runner, script)', /isSafePageNote\(saved\.quality_notes\)/.test(src('lib/guide-run.ts')) && /safe-page/.test(src('lib/heal-drafts.ts').slice(src('lib/heal-drafts.ts').indexOf('export async function healHeldGuides'))) && /safe-page/.test(src('scripts/heal-guides-now.ts')))
  }

  // ================================================================================================
  // 3. scripts/heal-guides-now.ts
  // ================================================================================================
  {
    const s = src('scripts/heal-guides-now.ts')
    const code = s.replace(/\/\/.*$/gm, '')
    check('X1: refuses to run without --yes (unless --dry), before it reads the environment or the database', /if \(!dry && !process\.argv\.includes\('--yes'\)\) usage\(\)/.test(s) && s.indexOf("if (!dry && !process.argv.includes('--yes')) usage()") < s.indexOf('loadEnvLocal()', s.indexOf('async function main')))
    check('X2: a real run stops unless guides_publish_mode is publish and automation is not paused', /if \(!modeOk\)[\s\S]*?process\.exit\(1\)/.test(code) && /if \(paused\)[\s\S]*?process\.exit\(1\)/.test(code))
    check('X3: uses healGuideRow with the shared in-memory budget; no direct AI call, no write, no delete', /healGuideRow\(admin, row, \{ budget: shared, skipClaim: true \}\)/.test(code) && /memoryBudget\(budget\)/.test(code) && !/\.update\(|\.insert\(|\.delete\(|\.upsert\(|callAnthropic|modelCallFor|\.rpc\(/.test(code))
    check('X4: one guide failing never aborts the run (try/catch per guide)', /try \{\s*\n\s*const r = await healGuideRow[\s\S]*?\} catch \(e\)/.test(code))
    check('X5: --dry lists the guides and their blockers and returns before any AI call or heal', /if \(dry\) \{[\s\S]*?describeGuideRow[\s\S]*?return\s*\n\s*\}\s*\n\s*const shared = memoryBudget/.test(code))
    check('X6: --dry needs no ANTHROPIC key and no --yes', /!dry && !process\.env\.ANTHROPIC_API_KEY/.test(code))
    check('X7: the budget is capped at 400 and the script prints a table with the outcome of each guide', /budget > 400/.test(code) && /Outcome per guide/.test(code))
    check('X8: the script touches the same rows the shared rule allows: a person-rejected or unpublished draft is left alone', isNowCandidate({ source: 'ai', status: 'draft', review_state: 'rejected', quality_notes: 'looks wrong to me' }, []) === false && isNowCandidate({ source: 'ai', status: 'draft', quality_notes: '' }, []) === false && isNowCandidate({ source: 'manual', status: 'draft', quality_notes: 'x' }, []) === false && isNowCandidate({ source: 'ai', status: 'draft', review_state: 'rejected', quality_notes: 'Rejected by heal: x' }, []) === true && isNowCandidate({ source: 'ai', status: 'published', review_state: 'rejected' }, []) === true && isNowCandidate({ source: 'ai', status: 'published', review_state: null }, []) === false)
    check('X9: no long dash in the files this review touched', ['lib/guide-repairs.ts', 'lib/guides.ts', 'lib/heal-drafts.ts', 'lib/guide-failures.ts', 'scripts/heal-guides-now.ts', 'scripts/check-heal-relax-qa.ts'].every((p) => !LONG_DASH.test(src(p))))
  }

  // ================================================================================================
  // 4. the daily runner: six a day, rejected-by-heal drafts come back under the writer's bounds
  // ================================================================================================
  {
    check('D1: the daily guide count is 6', GUIDES_HEALED_PER_DAY === 6)
    const now = new Date('2026-10-21T12:00:00Z')
    const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString()
    const rej = (over: Record<string, unknown> = {}) => ({ kind: 'resorts', slug: 'x', status: 'draft', source: 'ai', review_state: 'rejected', quality_notes: 'Rejected by heal: stuff', created_at: daysAgo(5), updated_at: daysAgo(REJECTED_RETRY_DAYS + 1), ...over })
    const retry = (n: number) => ({ rejections: () => n })
    check('D2: without a retry rule (page copy) a rejected row is still finished', !isHealDraftCandidate(rej(), now, []))
    check('D3: a heal-rejected guide untouched for more than 2 days, with no earlier retry, is eligible again', isHealDraftCandidate(rej(), now, [], retry(0)))
    check('D4: ... but not before the 2 days are up', !isHealDraftCandidate(rej({ updated_at: daysAgo(1) }), now, [], retry(0)))
    check('D5: ... and not once the bounded rejections are used (the writer\'s MAX_GUIDE_REJECTIONS)', !isHealDraftCandidate(rej(), now, [], retry(1)) && !isHealDraftCandidate(rej(), now, [], retry(2)))
    check('D6: a draft a person rejected (no heal note) never comes back', !isHealDraftCandidate(rej({ quality_notes: 'wrong tone, do not publish' }), now, [], retry(0)))
    check('D7: a heal note without the rejected flag (migration 0041 missing) stays out', !isHealDraftCandidate(rej({ review_state: null }), now, [], retry(0)))
    check('D8: the 30 day age limit and the published/manual rules still hold', !isHealDraftCandidate(rej({ created_at: daysAgo(40) }), now, [], retry(0)) && !isHealDraftCandidate(rej({ status: 'published' }), now, [], retry(0)) && !isHealDraftCandidate(rej({ source: 'manual' }), now, [], retry(0)))
    check('D9: a parked row (touched long after it was created) is still left alone when it was not heal-rejected', !isHealDraftCandidate({ status: 'draft', source: 'ai', review_state: null, quality_notes: 'superlative', created_at: daysAgo(5), updated_at: daysAgo(3) }, now, [], retry(0)))
    const rows = Array.from({ length: 9 }, (_v, i) => rej({ slug: `s${i}`, created_at: daysAgo(10 - i * 0.5) }))
    check('D10: selection honours the per-day limit', selectHealDrafts(rows, now, GUIDES_HEALED_PER_DAY, [], retry(0)).length === 6)
    const h = src('lib/heal-drafts.ts')
    check('D11: an unreadable retry counter fails closed (no retries) and a second rejection bumps the counter without feeding the breaker', /readGuideFailuresChecked/.test(h) && /counted\.error \? undefined/.test(h) && /bumpRejectionCount/.test(h) && !/recordGuideFailure/.test(h))
    check('D12: the cost is still bounded by heal_loop_calls_per_day (the loop runs on the shared budget and defers when it is used up)', /budget: opts\.budget/.test(h) && /openBudget|budget/.test(src('lib/heal-loop.ts')))
  }

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed.')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
