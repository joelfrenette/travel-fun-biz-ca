// Offline checks for WP18 (KPI honesty, auto-approve, heal re-try, page copy default, guide social release,
// GA4 visits). Run: pnpm dlx tsx scripts/check-wp18.ts
import { readFileSync } from 'node:fs'
import { latestRollingImpressions } from '../lib/funnel'
import { sumDimensionRows } from '../lib/search-console'
import { activePlatformsOf } from '../lib/social-provider'
import { autoApproveDecision, summariseAutoApprovals } from '../lib/blog-topics'
import { autoPublishBlockers } from '../lib/blog-composer'
import { composedFromRow, firstPackageSlug, nextRehealState, rehealStuckDrafts, rejectedPostSlugs, selectRehealCandidates, triesLeftToday, type RehealTags } from '../lib/blog-reheal'
import { revertEdit } from '../lib/content-edits'
import { fakeAdmin, type Db } from './fake-admin'
import { PAGE_COPY_DEFAULT_MODE, pageCopyModeOf } from '../lib/page-copy-run'
import { autoHoldNote, CAPTION_FAILED_PREFIX, clearAutoHoldNote, DEFAULT_GUIDE_RELEASE_HOURS, guideCaptionProblems, parseReleaseHours, releaseHeldGuides } from '../lib/guide-release'
import { enrollGuideIfDue } from '../lib/guide-distribution'
import { sessionsByPath } from '../lib/ga4'
import { applyGa4Sessions, snapshotContentPerformance } from '../lib/content-performance'
import { rankScores } from '../lib/style-choice'
import { classifyBlockers, fixOnOfferPhrases, repairContent, ruleFor, type RepairFields } from '../lib/content-repair'
import { COPY_LIMITS } from '../lib/content-repair-adapters'
import { agencyClaims } from '../lib/guide-composer'

// Nothing here may reach a paid API (the blog re-check can write a whole post again, which would call the AI if a key were set).
process.env.ANTHROPIC_API_KEY = ''
process.env.INDEXNOW_KEY = ''
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failed++
}
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

// ---- A: KPI honesty ----
check('funnel awareness uses the latest rolling row, never a sum',
  latestRollingImpressions([{ day: '2026-10-10', impressions: 1000 }, { day: '2026-10-12', impressions: 1200 }, { day: '2026-10-11', impressions: 1100 }]) === 1200)
check('funnel awareness with no rows is 0', latestRollingImpressions([]) === 0)
check('funnel awareness with null impressions is 0', latestRollingImpressions([{ day: '2026-10-12', impressions: null }]) === 0)
check('funnel query reads one row, latest first', /order\('day', \{ ascending: false \}\)\.limit\(1\)/.test(src('lib/funnel.ts')))

const named = sumDimensionRows([{ clicks: 3, impressions: 40 }, { clicks: 1, impressions: 10 }])
check('sumDimensionRows adds a report', named.clicks === 4 && named.impressions === 50)
const sc = src('lib/search-console.ts')
check('ranking snapshot totals come from the page report', /const totals = pages\.length \? pageTotals : namedQueryTotals/.test(sc))

const admin = src('app/admin/page.tsx')
check('admin home has no sample numbers or fake badges', !/sampleData|sampleChannels|1,247|\+12%|\+8%|\+23%/.test(admin))
check('admin home shows the honest not-connected state with a Setup link', /Google Analytics is not connected/.test(admin) && /Open the Setup steps/.test(admin))
check('admin home never labels data as sample', !/Sample Data/i.test(admin))

check('self-healing card says checklist score, not a Google ranking', /not a Google ranking/.test(src('components/admin/self-healing-card.tsx')))
check('keyword ideas say opportunity estimate', /opportunity estimate/.test(src('app/admin/keywords/page.tsx')))

check('active networks with GHL come from ghl_accounts, not the stale list',
  activePlatformsOf('ghl', [{ id: '1', platform: 'Facebook', name: 'a' }, { id: '2', platform: 'facebook', name: 'b' }, { id: '3', platform: 'linkedin', name: 'c' }], ['bluesky']).join(',') === 'facebook,linkedin')
check('active networks with Upload-Post come from its list', activePlatformsOf('upload-post', [{ id: '1', platform: 'x', name: 'a' }], ['Bluesky', ' threads ']).join(',') === 'bluesky,threads')
check('System Health text says 15 minutes', /after 15 minutes/.test(src('lib/plain-steps.ts')) && !/after 30 minutes/.test(src('lib/plain-steps.ts')))
check('publishing a guide clears stale quality_notes', /status === 'published' \? \{ status, quality_notes: null/.test(src('lib/guides.ts')))

// ---- B: auto-approve engine ideas ----
const good = { score: 72, packageSlug: 'sandy-toes', blockers: [] as string[] }
check('B: good idea with a small backlog is approved', autoApproveDecision(good, 3).approve)
check('B: score 69 stays suggested', !autoApproveDecision({ ...good, score: 69 }, 3).approve)
check('B: score exactly 70 is approved', autoApproveDecision({ ...good, score: 70 }, 0).approve)
check('B: no grounding package stays suggested', !autoApproveDecision({ ...good, packageSlug: null }, 3).approve)
check('B: any blocker stays suggested', !autoApproveDecision({ ...good, blockers: ['uses a superlative'] }, 3).approve)
check('B: backlog of 10 stops auto-approval', !autoApproveDecision(good, 10).approve && autoApproveDecision(good, 9).approve)
check('B: unreadable backlog fails closed', !autoApproveDecision(good, null).approve)
check('B: missing score stays suggested', !autoApproveDecision({ ...good, score: null }, 0).approve)
const entries = [{ at: new Date(Date.now() - 86_400_000).toISOString(), keyword: 'a', score: 80, reason: 'x' }, { at: new Date(Date.now() - 20 * 86_400_000).toISOString(), keyword: 'b', score: 75, reason: 'x' }]
check('B: auto-approved summary counts 7 days and all', summariseAutoApprovals(entries).total === 2 && summariseAutoApprovals(entries).last7 === 1)
const ki = src('lib/keyword-intel.ts')
check('B: engine inserts approved only through the decision', /status: decision\.approve \? 'approved' : 'suggested'/.test(ki) && /recordAutoApprovals\(admin, approvals\)/.test(ki))
check('B: autopilot API exposes the auto-approved count', /autoApproved: summariseAutoApprovals/.test(src('app/api/admin/autopilot/route.ts')))

// ---- C: re-heal stuck blog drafts ----
const goodBody = ['A river cruise is a relaxed way to see several towns without repacking.', '', '**Quick answer:** A river cruise suits first timers who want an easy pace.', '', '## Why a river cruise works for first timers', '', 'It is a floating hotel. See [the Rhine trip](/packages/rhine-cruise) for the real details, ask us in [the contact section](/#contact) or browse [our trips](/). ' + 'word '.repeat(460), '', '### Pace', '', 'Most people find the pace gentle. It is easy to settle in. You unpack once.', '', 'Have a think about who you would travel with, and our team can help you work that out.'].join('\n')
const draftRow = (n: number, bodyExtra: string, over: Record<string, unknown> = {}) => ({
  id: `post-${n}`, slug: `river-cruise-${n}`, status: 'draft', title: 'River cruise for first timers', body: goodBody.replace('You unpack once.', `You unpack once.${bodyExtra}`),
  meta_title: 'River cruise for first timers', meta_description: 'A plain guide for first-time river cruisers.', tags: ['river cruise first timers'],
  faq: [{ q: 'Is a river cruise good for first timers?', a: 'Yes, the pace is gentle.' }, { q: 'Do I unpack every day?', a: 'No, you unpack once.' }, { q: 'Who is it for?', a: 'Anyone who likes an easy pace.' }],
  key_takeaways: ['Gentle pace', 'Unpack once', 'Good for first timers'], og_title: 'Is a river cruise right for you?', og_description: 'A plain-English look at river cruising for first timers.',
  primary_keyword: 'river cruise first timers', secondary_keywords: ['river cruise tips'], content_style: 'faq-led', seo_score: null,
  created_at: new Date(Date.now() - 86_400_000).toISOString(), ...over,
})
const tagRow = (n: number, tags: Record<string, unknown>) => ({ slug: `river-cruise-${n}`, variant_tags: { cta_style: 'soft-question', ...tags } })
const existing = new Set(['/', '/packages', '/packages/rhine-cruise', '/blog'])
const noModel = async () => null
// A scripted stand-in for the AI: the QA judge passes, the suggester deletes the flagged sentence, anything else says nothing.
const stubModel = async (prompt: string): Promise<string | null> => (/independent quality reviewer/.test(prompt) ? '{"pass":true,"failures":[]}' : /repairing sentences/.test(prompt) ? '{"rewrites":[{"id":0,"delete":true}]}' : '{}')

async function main() {
  const now = new Date()
  check('C: the fixture draft is clean', autoPublishBlockers(composedFromRow(draftRow(0, '')), now, { allowedPaths: ['/packages/rhine-cruise'], groundingText: 'river cruise first timers' }).length === 0)

  // pure picking rules
  const tagsMap = new Map<string, RehealTags>([['river-cruise-1', { cta_style: 'x', held_reasons: 'number not in the grounding: 180' }], ['river-cruise-2', { cta_style: 'x', held_reasons: 'fabricated experience claim' }], ['river-cruise-3', {}], ['river-cruise-4', { cta_style: 'x', held_reasons: 'number not in the grounding: 5', reheal_tries: 2 }], ['river-cruise-5', { cta_style: 'x', held_reasons: 'number not in the grounding: 5', reheal_state: 'rejected' }], ['river-cruise-6', { cta_style: 'x', held_reasons: 'number not in the grounding: 5', reheal_last: now.toISOString() }]])
  const pickRows = [1, 2, 3, 4, 5, 6].map((n) => draftRow(n, ''))
  const picked = selectRehealCandidates(pickRows, tagsMap, now, 5).map((r) => r.slug)
  check('C: a held autoblog draft with tries left is picked, including one held for a HARD reason (WP19: the heal loop takes those too)', picked.join() === 'river-cruise-1,river-cruise-2', picked.join())
  check('C: a never-scored autoblog draft with no held reasons is picked', selectRehealCandidates([draftRow(7, '')], new Map([['river-cruise-7', { cta_style: 'x' }]]), now, 2).length === 1)
  check('C: a draft older than 14 days is not picked', selectRehealCandidates([draftRow(8, '', { created_at: new Date(Date.now() - 15 * 86_400_000).toISOString() })], new Map([['river-cruise-8', { cta_style: 'x', held_reasons: 'number not in the grounding: 1' }]]), now, 2).length === 0)
  check('C: a draft with a scored seo_score and no held reasons is not stuck', selectRehealCandidates([draftRow(9, '', { seo_score: 80 })], new Map([['river-cruise-9', { cta_style: 'x' }]]), now, 2).length === 0)
  check('C: tries left today is capped at 2', triesLeftToday(0) === 2 && triesLeftToday(1) === 1 && triesLeftToday(2) === 0 && triesLeftToday(5) === 0)
  check('C: the second failed try rejects, the first retries', nextRehealState(0, false).state === 'retry' && nextRehealState(1, false).state === 'rejected' && nextRehealState(1, true).state === 'published')
  check('C: the first trip link is found', firstPackageSlug('See [x](/packages/rhine-cruise) now') === 'rhine-cruise' && firstPackageSlug('no link') === null)

  // full run against the fake database
  const clearSlots = (db: Db) => { db.tables.app_settings = (db.tables.app_settings ?? []).filter((r) => !String(r.key).startsWith('content_repair_')) }
  {
    const db: Db = {
      tables: {
        app_settings: [{ key: 'autoblog_mode', value: 'publish' }],
        content_edits: [],
        travel_packages: [],
        post_distribution: [],
        posts: [
          draftRow(1, ' The ship holds 180 guests.'),
          draftRow(2, '', { body: goodBody + '\n\nPrices start from $1,200 per person.' }),
          draftRow(3, '', { faq: [], key_takeaways: [] }),
          draftRow(4, ' The ship holds 180 guests.'),
          draftRow(5, ' The ship holds 180 guests.', { created_at: new Date(Date.now() - 20 * 86_400_000).toISOString() }),
        ],
        content_variants: [
          tagRow(1, { held_reasons: 'number not in the grounding: 180' }),
          tagRow(2, { held_reasons: 'needs a person: "x" holds a price, a date or a named person', reheal_state: 'rejected' }),
          tagRow(3, { held_reasons: 'missing FAQ (0 questions, need at least 3)' }),
          tagRow(4, { held_reasons: 'number not in the grounding: 180' }),
          { slug: 'river-cruise-5', variant_tags: { cta_style: 'x', held_reasons: 'number not in the grounding: 180' } },
        ],
      },
    }
    const admin = fakeAdmin(db)
    const r1 = await rehealStuckDrafts(admin, { existing, now, model: noModel })
    const post = (n: number) => db.tables.posts.find((p) => p.id === `post-${n}`) as Record<string, unknown>
    const tag = (n: number) => (db.tables.content_variants.find((v) => v.slug === `river-cruise-${n}`)?.variant_tags ?? {}) as RehealTags
    check('C: at most 2 drafts are tried in a day (3 and 4 were due, 1 first)', r1.tried === 2, JSON.stringify(r1))
    check('C: the fixable draft was repaired and published', post(1).status === 'published' && !String(post(1).body).includes('180') && r1.published === 1, JSON.stringify(r1))
    const logged = db.tables.content_edits.filter((e) => e.content_id === 'post-1')
    check('C: the publish and the text edit are both logged in content_edits', logged.some((e) => e.field === 'status' && e.before === 'draft' && e.after === 'published' && e.published_after === true) && logged.some((e) => e.field === 'body'), JSON.stringify(logged.map((e) => e.field)))
    check('C: the held reasons are cleared and the state recorded', tag(1).held_reasons === '' && tag(1).reheal_state === 'published')
    check('C: a draft already rejected by the heal is left alone', post(2).status === 'draft' && db.tables.content_edits.filter((e) => e.content_id === 'post-2').length === 0 && !tag(2).reheal_tries)
    check('C: with the AI down a draft stays a draft and spends no try (WP19: a deferral is not a failed try)', post(3).status === 'draft' && !tag(3).reheal_tries && !tag(3).reheal_state, JSON.stringify(tag(3)))
    check('C: the blocked draft keeps its new reasons for the admin', String(tag(3).held_reasons).includes('FAQ'))
    check('C: a draft older than 14 days is untouched', post(5).status === 'draft' && String(post(5).body).includes('180'))
    check('C: drafts tried today are not tried twice the same day', (await rehealStuckDrafts(admin, { existing, now, model: noModel })).tried === 0)

    // next day: the blocked draft gets its second try and is retired
    clearSlots(db)
    const tomorrow = new Date(now.getTime() + 86_400_000)
    db.tables.app_settings = db.tables.app_settings.filter((r) => !String(r.key).startsWith('content_repair_once'))
    const r2 = await rehealStuckDrafts(admin, { existing, now: tomorrow, model: stubModel })
    check('C: on day two, with the AI back, the draft the heal cannot fix is rejected at once (WP19)', tag(3).reheal_state === 'rejected' && r2.rejected === 1, JSON.stringify(tag(3)))
    check('C: the retired draft is reported as rejected so its slot is freed', (await rejectedPostSlugs(admin)).has('river-cruise-3'))
    check('C: draft 4 (due but beyond the day-one limit) got its turn on day two', post(4).status === 'published' || tag(4).reheal_tries === 1, JSON.stringify(tag(4)))

    // Undo works: reverting the status edit puts the post back to a draft
    const statusEdit = db.tables.content_edits.find((e) => e.content_id === 'post-1' && e.field === 'status') as Record<string, unknown>
    const undone = await revertEdit(admin, statusEdit.id as string)
    check('C: Undo of the publish puts the post back to a draft', undone.ok && post(1).status === 'draft', JSON.stringify(undone))
  }
  {
    // fail closed: the publish cannot be logged (migration 0043 missing) so nothing is published
    const db: Db = {
      tables: { app_settings: [{ key: 'autoblog_mode', value: 'publish' }], content_edits: [], posts: [draftRow(1, ' The ship holds 180 guests.')], content_variants: [tagRow(1, { held_reasons: 'number not in the grounding: 180' })] },
      rejectInsert: (t, row) => (t === 'content_edits' && row.field === 'status' ? 'violates check constraint content_edits_field_check' : null),
    }
    const r = await rehealStuckDrafts(fakeAdmin(db), { existing, now, model: noModel })
    check('C: without the status log nothing is published and the step says to apply 0043', db.tables.posts[0].status === 'draft' && r.published === 0 && r.problems.some((p) => /0043/.test(p)), JSON.stringify(r))
  }
  {
    const db: Db = { tables: { app_settings: [{ key: 'autoblog_mode', value: 'draft' }], content_edits: [], posts: [draftRow(1, ' The ship holds 180 guests.')], content_variants: [tagRow(1, {})] } }
    const r = await rehealStuckDrafts(fakeAdmin(db), { existing, now, model: noModel })
    check('C: in draft mode nothing is touched', r.tried === 0 && db.tables.posts[0].status === 'draft')
  }
  check('C: the heal step calls the re-check', /rehealStuckDrafts\(admin/.test(src('lib/content-heal-run.ts')))
  check('C: migration 0043 is written and adds status', /'status'\)\)/.test(src('supabase/migrations/0043_content_edits_status.sql')))

  // ---- D: page copy default and the "on offer" agency phrases ----
  check('D: an unset page copy mode now means publish', pageCopyModeOf(null) === 'publish' && pageCopyModeOf('') === 'publish' && PAGE_COPY_DEFAULT_MODE === 'publish')
  check('D: an explicit draft stays draft, an unreadable setting fails closed to draft', pageCopyModeOf('draft') === 'draft' && pageCopyModeOf(null, true) === 'draft' && pageCopyModeOf('nonsense') === 'draft')
  check('D: publish still means publish', pageCopyModeOf('publish') === 'publish')
  check('D: reading the mode never writes the setting', !/setSetting/.test(/export async function getPageCopyPublishMode[\s\S]*?\n}/.exec(src('lib/page-copy-run.ts'))?.[0] ?? 'setSetting'))
  const claimBlocker = (s: string) => `claim about what the agency has done or does: "${s.slice(0, 80)}"`
  for (const s of ['Here is what we have on offer.', 'The trips we have on offer are listed below.', 'We have three river cruises on offer.', 'Our team has a few sailings on offer.']) {
    check(`D: "${s}" is classified REPAIRABLE by the agency-offer rule`, ruleFor(claimBlocker(s))?.id === 'agency-offer' && classifyBlockers([claimBlocker(s)]).repairable.length === 1)
  }
  check('D: a general agency claim is still the general rule', ruleFor(claimBlocker('We host groups here every spring.'))?.id === 'agency')
  const fixed = [
    ['Here is what we have on offer.', 'Here is what is on offer.'],
    ['See all the trips we have on offer.', 'See all the trips on offer.'],
    ['We have three river cruises on offer.', 'Three river cruises are on offer.'],
    ['The itinerary we have on offer is gentle.', 'The itinerary on offer is gentle.'],
  ] as const
  for (const [from, to] of fixed) check(`D: fixer turns "${from}" into "${to}"`, fixOnOfferPhrases(from) === to, fixOnOfferPhrases(from))
  check('D: the fixer leaves ordinary text alone', fixOnOfferPhrases('Santorini has a relaxed pace. Ask us about group trips.') === 'Santorini has a relaxed pace. Ask us about group trips.')
  check('D: after the fixer no agency claim is left in those sentences', fixed.every(([from]) => agencyClaims(fixOnOfferPhrases(from)).length === 0))
  {
    // end to end: the shared repair mends a page copy whose intro says "we have ... on offer", with no model call
    const goodIntro = 'Santorini and Mykonos suit different kinds of trip. ' + 'Both islands are popular with groups who like an easy pace. '.repeat(6) + 'See [our Greek trip](/packages/greek-isles).'
    const fields: RepairFields = { body: `${goodIntro} Here is what we have on offer.`, meta_title: 'Santorini or Mykonos', meta_description: 'A plain comparison.', og_title: 'Which island?', og_description: 'A plain comparison.', faq: [], key_takeaways: [] }
    const gate = (f: RepairFields) => agencyClaims(f.body).map((c) => claimBlocker(c))
    const item = { type: 'page_copy' as const, id: null, path: '/compare/x', fields, grounding: '', allowedPaths: new Set<string>(), keyword: null, limits: COPY_LIMITS, gate }
    const res = await repairContent(item, { model: async () => null, maxCalls: 0 })
    check('D: repairContent clears the phrase with plain code and zero model calls', res.blockers.length === 0 && res.calls === 0 && /Here is what is on offer\./.test(res.fields.body), JSON.stringify(res.blockers))
    check('D: that edit is logged as a plain fix', res.edits.length === 1 && res.edits[0].method === 'fixer' && /on offer/.test(res.edits[0].reason), JSON.stringify(res.edits.map((e) => e.reason)))
  }

  // ---- E: held guide social posts are released after the wait if the caption passes ----
  check('E: release hours parse: unset 24, 0 never, bad text 24, capped at 720', parseReleaseHours(null) === 24 && parseReleaseHours('') === 24 && parseReleaseHours('0') === 0 && parseReleaseHours('abc') === 24 && parseReleaseHours('-3') === 24 && parseReleaseHours('6') === 6 && parseReleaseHours('9999') === 720 && DEFAULT_GUIDE_RELEASE_HOURS === 24)
  const cleanSrc = { title: 'Hotel Aurora guide', meta_description: 'What to expect at Hotel Aurora, a quiet seaside hotel, and who it suits.', grounding: '- Quiet seaside hotel\n- Rooms face the harbour' }
  check('E: a plain caption passes', guideCaptionProblems(cleanSrc).length === 0, guideCaptionProblems(cleanSrc).join('|'))
  check('E: a superlative is a problem', guideCaptionProblems({ ...cleanSrc, meta_description: 'The best hotel on the coast, and a quiet one.' }).some((p) => /superlative/.test(p)))
  check('E: a number outside the guide facts is a problem, one inside is fine', guideCaptionProblems({ ...cleanSrc, meta_description: 'A quiet hotel with 450 rooms.' }).some((p) => /number not in/.test(p)) && guideCaptionProblems({ ...cleanSrc, meta_description: 'A quiet hotel with 450 rooms.', grounding: '- 450 rooms' }).length === 0)
  check('E: a long dash and an empty description are problems', guideCaptionProblems({ ...cleanSrc, title: `Hotel ${String.fromCharCode(8212)} Aurora` }).length > 0 && guideCaptionProblems({ ...cleanSrc, meta_description: null }).length > 0)

  const guideRow = (slug: string, over: Record<string, unknown> = {}) => ({ kind: 'hotels', slug, name: `Hotel ${slug}`, status: 'published', summary: 'A quiet hotel.', hero_image_url: null, og_title: null, meta_description: 'What to expect at this quiet seaside hotel and who it suits.', faq: [], key_takeaways: ['Quiet seaside hotel'], ...over })
  const ledger = (slug: string, hoursAgo: number, over: Record<string, unknown> = {}) => ({ content_type: 'post', slug: `guide-hotels-${slug}`, title: `Hotel ${slug}`, path: `/hotels/${slug}`, stage: 'held', attempts: 0, sent_platforms: [], last_error: autoHoldNote(24), created_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), updated_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), ...over })
  const stageOf = (db: Db, slug: string) => (db.tables.post_distribution.find((r) => r.slug === `guide-hotels-${slug}`) ?? {}) as Record<string, unknown>

  {
    // enrolment
    const mk = (hours?: string, mode = 'auto'): Db => ({ tables: { app_settings: [{ key: 'distribution_mode', value: mode }, ...(hours === undefined ? [] : [{ key: 'guide_social_release_hours', value: hours }])], post_distribution: [] } })
    let db = mk()
    await enrollGuideIfDue(fakeAdmin(db), { kind: 'hotels', slug: 'one', name: 'One', status: 'published' })
    check('E: a named place is enrolled held with the Auto-hold note (default 24 hours)', db.tables.post_distribution[0].stage === 'held' && String(db.tables.post_distribution[0].last_error).startsWith('Auto-hold:') && /24 hours/.test(String(db.tables.post_distribution[0].last_error)))
    db = mk('0')
    await enrollGuideIfDue(fakeAdmin(db), { kind: 'hotels', slug: 'one', name: 'One', status: 'published' })
    check('E: wait of 0 keeps it held with no release note (manual, as before)', db.tables.post_distribution[0].stage === 'held' && !db.tables.post_distribution[0].last_error)
    db = mk('24', 'prepare')
    await enrollGuideIfDue(fakeAdmin(db), { kind: 'hotels', slug: 'one', name: 'One', status: 'published' })
    check('E: prepare mode holds for approval with no release note', db.tables.post_distribution[0].stage === 'held' && !db.tables.post_distribution[0].last_error)
    db = mk()
    await enrollGuideIfDue(fakeAdmin(db), { kind: 'destinations', slug: 'cancun', name: 'Cancun', status: 'published' })
    check('E: a destination guide is still queued straight away', db.tables.post_distribution[0].stage === 'queued')
  }
  {
    const base = (): Db => ({
      tables: {
        app_settings: [{ key: 'distribution_mode', value: 'auto' }],
        guides: [guideRow('old'), guideRow('fresh'), guideRow('manual'), guideRow('superl', { meta_description: 'The best hotel on the coast and who it suits.' })],
        post_distribution: [ledger('old', 25), ledger('fresh', 2), ledger('manual', 30, { last_error: null }), ledger('superl', 30)],
      },
    })
    let db = base()
    let r = await releaseHeldGuides(fakeAdmin(db), { mode: 'auto' })
    check('E: after 24 hours a clean held guide is released to queued, the note cleared', stageOf(db, 'old').stage === 'queued' && stageOf(db, 'old').last_error === null, JSON.stringify(r))
    check('E: the per-day guide limit holds (only one released in a pass)', r.released === 1 && stageOf(db, 'superl').stage === 'held')
    check('E: a guide held for under 24 hours is not released', stageOf(db, 'fresh').stage === 'held')
    check('E: a row held by hand (no Auto-hold note) is never released', stageOf(db, 'manual').stage === 'held' && stageOf(db, 'manual').last_error === null)
    check('E: a failing caption stays held and says why', String(stageOf(db, 'superl').last_error).startsWith('Caption check failed:') && /superlative/.test(String(stageOf(db, 'superl').last_error)), String(stageOf(db, 'superl').last_error))
    r = await releaseHeldGuides(fakeAdmin(db), { mode: 'auto' })
    check('E: a second pass the same day releases nothing more', r.released === 0 && stageOf(db, 'fresh').stage === 'held')
    // fixing the caption lets it go the next day
    db.tables.post_distribution = db.tables.post_distribution.filter((x) => x.slug !== 'guide-hotels-old')
    ;(db.tables.guides.find((g) => g.slug === 'superl') as Record<string, unknown>).meta_description = 'What to expect at this quiet seaside hotel and who it suits.'
    r = await releaseHeldGuides(fakeAdmin(db), { mode: 'auto' })
    check('E: once the wording is fixed the held guide is released by itself', stageOf(db, 'superl').stage === 'queued', JSON.stringify(r))

    db = base()
    db.tables.app_settings.push({ key: 'guide_social_release_hours', value: '0' })
    r = await releaseHeldGuides(fakeAdmin(db), { mode: 'auto' })
    check('E: a wait of 0 never releases', r.released === 0 && stageOf(db, 'old').stage === 'held')
    db = base()
    r = await releaseHeldGuides(fakeAdmin(db), { mode: 'prepare' })
    check('E: only auto mode releases', r.released === 0 && stageOf(db, 'old').stage === 'held')
    db = base()
    db.tables.post_distribution.push({ content_type: 'post', slug: 'guide-resorts-sent', title: 'x', path: '/resorts/sent', stage: 'done', created_at: new Date(Date.now() - 5 * 86_400_000).toISOString(), updated_at: new Date().toISOString() })
    r = await releaseHeldGuides(fakeAdmin(db), { mode: 'auto' })
    check('E: a guide already sent today uses up the day, so nothing is released', r.released === 0 && stageOf(db, 'old').stage === 'held')
    db = base()
    db.tables.guides = db.tables.guides.filter((g) => g.slug !== 'old')
    r = await releaseHeldGuides(fakeAdmin(db), { mode: 'auto' })
    check('E: a guide that is no longer published is not released', stageOf(db, 'old').stage === 'held')
  }
  {
    const db: Db = { tables: { post_distribution: [ledger('old', 30, { last_error: `${CAPTION_FAILED_PREFIX} superlative` })] } }
    await clearAutoHoldNote(fakeAdmin(db), 'guide-hotels-old')
    check('E: approving by hand clears the held note', stageOf(db, 'old').last_error === null)
  }
  const dist = src('lib/distribution.ts')
  check('E: the existing posting pass calls the release step before sending, and there is no new send path', /releaseHeldGuides\(admin, \{ mode \}\)/.test(dist) && !/uploadPostSend/.test(src('lib/guide-release.ts')) && !/sendText|sendPhotos|sendVideo/.test(src('lib/guide-release.ts')))
  check('E: a held caption shows in Needs attention with grade-5 steps', /guide-caption:/.test(src('lib/issues.ts')) && /guide-caption:/.test(src('lib/plain-steps.ts')))

  // ---- F: GA4 sessions per page into the daily snapshot ----
  const sess = sessionsByPath([
    { landingPage: '/blog/a', sessions: 10 }, { landingPage: '/blog/a/', sessions: 5 }, { landingPage: '/blog/a?utm_source=x', sessions: 1 },
    { landingPage: '(not set)', sessions: 99 }, { landingPage: '/admin/autopilot', sessions: 7 }, { landingPage: '/api/x', sessions: 7 },
    { landingPage: 'https://www.travelfunbiz.ca/packages/p', sessions: 3 }, { landingPage: '/', sessions: 40 }, { landingPage: '', sessions: 2 },
  ])
  check('F: GA4 rows become sessions per site path (query and slash dropped, admin and (not set) ignored)', sess.get('/blog/a') === 16 && sess.get('/packages/p') === 3 && sess.get('/') === 40 && sess.size === 3, JSON.stringify([...sess]))
  {
    const rows = new Map<string, { path: string; visits: number | null }>([['/blog/a', { path: '/blog/a', visits: null }], ['/blog/none', { path: '/blog/none', visits: null }]])
    applyGa4Sessions(rows, new Map([['/blog/a', 16], ['/new', 4]]), (p) => { const r = { path: p, visits: null as number | null }; rows.set(p, r); return r })
    check('F: sessions fill visits, an unreported tracked page is a real 0, a new page is added', rows.get('/blog/a')?.visits === 16 && rows.get('/blog/none')?.visits === 0 && rows.get('/new')?.visits === 4)
  }
  check('F: visits is an extra signal only: it breaks a tie but never beats clicks or leads',
    rankScores([{ value: 'a', clicksPerPost: 5, posts: 3, visitsPerPost: 0 }, { value: 'b', clicksPerPost: 5, posts: 3, visitsPerPost: 40 }])[0].value === 'b' &&
    rankScores([{ value: 'a', clicksPerPost: 6, posts: 3, visitsPerPost: 0 }, { value: 'b', clicksPerPost: 5, posts: 3, visitsPerPost: 400 }])[0].value === 'a' &&
    rankScores([{ value: 'a', clicksPerPost: 5, posts: 3 }, { value: 'b', clicksPerPost: 5, posts: 4 }])[0].value === 'b')
  {
    // not connected: nothing is invented, visits stay null
    delete process.env.GA4_PROPERTY_ID
    const db: Db = { tables: { app_settings: [], site_visits: [], post_distribution: [], content_pipeline: [], leads: [], posts: [{ slug: 'a', title: 'A', status: 'published' }], content_performance: [] } }
    const note = await snapshotContentPerformance(fakeAdmin(db))
    const saved = db.tables.content_performance ?? []
    check('F: with GA4 not connected the snapshot leaves visits null and says so', saved.length > 0 && saved.every((r) => r.visits === null) && /GA4 is not connected/.test(String(note)), String(note))
  }
  check('F: GA4 is read with one report request and the snapshot caps tries at 2 a day', (src('lib/ga4.ts').match(/runReport/g) ?? []).length >= 2 && /MAX_GA4_ATTEMPTS = 2/.test(src('lib/content-performance.ts')) && !/method: 'POST'[\s\S]{0,200}batchRunReports/.test(src('lib/ga4.ts')))
  check('F: migration 0042 is written (comment only, the visits column already exists from 0029)', /comment on column public\.content_performance\.visits/.test(src('supabase/migrations/0042_visits_ga4.sql')) && !/add column/i.test(src('supabase/migrations/0042_visits_ga4.sql')))

  // ---- MAIN-END ----
}

main()
  .then(() => {
    console.log(failed ? `\n${failed} FAILED` : '\nall passed')
    process.exit(failed ? 1 : 0)
  })
  .catch((e) => {
    console.error('check crashed:', e)
    process.exit(1)
  })
