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
const goodBody = ['A river cruise is a relaxed way to see several towns without repacking.', '', '**Quick answer:** A river cruise suits first timers who want an easy pace.', '', '## Why a river cruise works for first timers', '', 'It is a floating hotel. See [the Rhine trip](/packages/rhine-cruise) for the real details. ' + 'word '.repeat(460), '', '### Pace', '', 'Most people find the pace gentle. It is easy to settle in. You unpack once.', '', 'Have a think about who you would travel with, and our team can help you work that out.'].join('\n')
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

async function main() {
  const now = new Date()
  check('C: the fixture draft is clean', autoPublishBlockers(composedFromRow(draftRow(0, '')), now, { allowedPaths: ['/packages/rhine-cruise'], groundingText: 'river cruise first timers' }).length === 0)

  // pure picking rules
  const tagsMap = new Map<string, RehealTags>([['river-cruise-1', { cta_style: 'x', held_reasons: 'number not in the grounding: 180' }], ['river-cruise-2', { cta_style: 'x', held_reasons: 'fabricated experience claim' }], ['river-cruise-3', {}], ['river-cruise-4', { cta_style: 'x', held_reasons: 'number not in the grounding: 5', reheal_tries: 2 }], ['river-cruise-5', { cta_style: 'x', held_reasons: 'number not in the grounding: 5', reheal_state: 'rejected' }], ['river-cruise-6', { cta_style: 'x', held_reasons: 'number not in the grounding: 5', reheal_last: now.toISOString() }]])
  const pickRows = [1, 2, 3, 4, 5, 6].map((n) => draftRow(n, ''))
  const picked = selectRehealCandidates(pickRows, tagsMap, now, 5).map((r) => r.slug)
  check('C: only a held, repairable, autoblog draft with tries left is picked', picked.join() === 'river-cruise-1', picked.join())
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
          tagRow(2, { held_reasons: 'needs a person: "x" holds a price, a date or a named person' }),
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
    check('C: the draft held for a price (HARD) is left alone', post(2).status === 'draft' && db.tables.content_edits.filter((e) => e.content_id === 'post-2').length === 0 && !tag(2).reheal_tries)
    check('C: a draft that cannot pass stays a draft and uses one try', post(3).status === 'draft' && tag(3).reheal_tries === 1 && !tag(3).reheal_state, JSON.stringify(tag(3)))
    check('C: the blocked draft keeps its new reasons for the admin', String(tag(3).held_reasons).includes('FAQ'))
    check('C: a draft older than 14 days is untouched', post(5).status === 'draft' && String(post(5).body).includes('180'))
    check('C: drafts tried today are not tried twice the same day', (await rehealStuckDrafts(admin, { existing, now, model: noModel })).tried === 0)

    // next day: the blocked draft gets its second try and is retired
    clearSlots(db)
    const tomorrow = new Date(now.getTime() + 86_400_000)
    db.tables.app_settings = db.tables.app_settings.filter((r) => !String(r.key).startsWith('content_repair_once'))
    const r2 = await rehealStuckDrafts(admin, { existing, now: tomorrow, model: noModel })
    check('C: on day two the blocked draft is tried again and retired after 2 failures', tag(3).reheal_state === 'rejected' && tag(3).reheal_tries === 2 && r2.rejected === 1, JSON.stringify(tag(3)))
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
