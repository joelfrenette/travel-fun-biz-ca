// Offline check for "the scheduled AI auto-heal never publishes; it queues the improved item for a Today review card".
// Covers: the repairs in review mode (publish:false) repair and log but never publish (held guides, held page copy, stuck blog drafts);
// the default mode still publishes (so the System check Auto-heal button and the daily self-heal behave as before); the ai_heal step forces
// review mode and queues each improved item; the queue (cap 20, dedupe, trim); the Today card kind; approve (publishes through the normal
// route, a refusal keeps it held and shows why) and reject (revertEdit, old text and note back); a review-held row is left alone by the
// daily heal. In-memory fake database and scripted model only: no network, no real database, no AI call.
// Run: pnpm dlx tsx scripts/check-ai-heal-review.ts
import { readFileSync } from 'node:fs'

process.env.ANTHROPIC_API_KEY = ''
process.env.INDEXNOW_KEY = ''

import type { SupabaseClient } from '@supabase/supabase-js'
import { fakeAdmin, type Db } from './fake-admin'
import {
  AI_HEAL_REVIEW_KEY, REVIEW_HOLD_NOTE, REVIEW_OPEN_CAP, addItem, approveReview, enqueueReview, openCount, parseQueue, readQueue, rejectReview, reopenReview, reviewKey, parseReviewKey, summarize,
  type ImprovedInfo, type ReviewDeps, type ReviewItem,
} from '../lib/ai-heal-review'
import { composedGuideFromRow, healHeldCopy, healHeldGuides, isHealDraftCandidate, composedCopyFromRow, type CopyBriefParts, type GuideBriefParts } from '../lib/heal-drafts'
import { rehealStuckDrafts, isRehealCandidate } from '../lib/blog-reheal'
import { guideBlockers } from '../lib/guide-composer'
import { pageCopyBlockers } from '../lib/page-copy-composer'
import { revertEdit } from '../lib/content-edits'
import { withDryRun } from '../lib/dry-run'
import { runAiFixStep, type AiFixDeps } from '../lib/system-check-ai'
import { runAiHeal, type AiHealDeps } from '../lib/flywheel/steps/ai-heal'
import { TODAY_KINDS, parseCardId, needsConfirm, actionFor } from '../lib/today-cards'
import type { ComposedPost } from '../lib/blog-composer'
import type { HealBudget } from '../lib/heal-loop'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
}
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

const scriptedModel = (suggest: () => string) => async (prompt: string): Promise<string | null> => {
  if (/independent quality reviewer/.test(prompt)) return '{"pass":true,"failures":[]}'
  if (/repairing sentences/.test(prompt)) return suggest()
  if (/Write ONLY the fields listed/.test(prompt)) return '{}'
  return null
}
const deleteFirst = () => '{"rewrites":[{"id":0,"delete":true}]}'
const reword = () => '{"rewrites":[{"id":0,"text":"The old town is a pleasant place to wander."}]}'
const memBudget = (cap = 30): HealBudget => {
  const b: HealBudget = { cap, used: 0, readable: true, remaining: () => Math.max(0, cap - b.used), take: async (n = 1) => (b.used + n > cap ? false : ((b.used += n), true)) }
  return b
}

// ---------------------------------------------------------------------------------------------------
// Fixtures (the same shapes scripts/check-heal-loop.ts uses)
// ---------------------------------------------------------------------------------------------------
const now = new Date()
const SUMMARY = 'Lisbon is a hilly coastal city that rewards slow walking and long lunches.'
const GROUNDING = 'Lisbon is a city in Portugal. Travellers walk the hills and ride the trams.'
const SENT = [
  'Walking shoes with good grip help on the stone streets.', 'Trams and funiculars climb the steep hills.', 'A day pass keeps getting around simple.', 'Cafes fill with locals at midday.',
  'Grilled fish and custard tarts are common here.', 'Most places serve lunch at a relaxed pace.', 'Coastal towns sit a short train ride away.', 'Narrow lanes open onto small squares.',
  'Evenings suit a slow stroll by the river.', 'Small shops sell tiles, tins and cork goods.', 'Travellers often plan the day around one main stop.', 'Museums are easy to reach on foot or by tram.',
  'A relaxed pace makes the hills feel gentler.', 'Local markets are a good place to browse.', 'Viewpoints reward a short climb.', 'Guides can help plan a loose route.',
  'Comfortable shoes matter more than a long list of stops.', 'Lunch stretches into the afternoon for many visitors.',
]
const HEADINGS = ['Getting around', 'The old town', 'Food and drink', 'Day trips', 'Neighbourhoods', 'Planning your days', 'Local tips', 'Before you go']
const makeSections = (famousIn = 1) =>
  HEADINGS.map((heading, i) => {
    const sentences = Array.from({ length: 17 }, (_x, k) => SENT[(i * 3 + k) % SENT.length])
    if (i === famousIn) sentences[2] = 'The famous old town is a pleasant place to wander.'
    if (i === 0) sentences[3] = 'Read about [all our trips](/packages) for more ideas.'
    return { heading, body: sentences.join(' ') }
  })
const GUIDE_ID = '11111111-1111-4111-8111-111111111111'
const COPY_ID = '22222222-2222-4222-8222-222222222222'
const POST_ID = '33333333-3333-4333-8333-333333333333'
const ORIGINAL_GUIDE_NOTE = 'superlative or rating claim (reputation claim)'
const guideRow = (over: Record<string, unknown> = {}, famousIn = 1) => {
  const sections = makeSections(famousIn)
  return {
    id: GUIDE_ID, kind: 'destinations', slug: 'lisbon', name: 'Lisbon', parent_slug: null, status: 'draft', source: 'ai', review_state: null,
    quality_notes: ORIGINAL_GUIDE_NOTE, created_at: new Date(Date.now() - 86_400_000).toISOString(),
    summary: SUMMARY, body: sections.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n'), sections,
    faq: [{ q: 'Is Lisbon hilly?', a: 'Yes, the streets climb.' }, { q: 'Can I walk?', a: 'Yes, with grip shoes.' }, { q: 'Are there trams?', a: 'Yes, in the old streets.' }, { q: 'Is lunch long?', a: 'It can be.' }],
    key_takeaways: ['Hilly city', 'Walk with grip', 'Ride the trams'], meta_title: 'Lisbon travel guide', meta_description: 'A plain guide to Lisbon for travellers who like to walk.', og_title: 'Lisbon travel guide', og_description: 'A plain guide to Lisbon.',
    primary_keyword: 'lisbon travel guide', secondary_keywords: [], ...over,
  }
}
const guideParts: GuideBriefParts = { ctx: { grounding: GROUNDING, allowedPaths: new Set(['/', '/packages']), names: ['Portugal', 'all our trips'] }, links: [{ path: '/packages', label: 'all our trips' }] }
const guideBrief = async () => guideParts

const words = ['Lisbon is a coastal city with a gentle pace for travellers who like to walk.', 'The hills reward comfortable shoes and a loose plan.', 'Trams and funiculars help on the steep streets.', 'See [the Lisbon trip](/packages/lisbon-trip) for the details of the trip we list.', 'Narrow lanes open onto small squares.', 'Grilled fish and custard tarts are common at lunch.', 'Coastal towns sit a short train ride away.', 'Viewpoints reward a short climb.', 'Small shops sell tiles, tins and cork goods.', 'Evenings suit a slow stroll by the river.', 'Museums are easy to reach on foot or by tram.', 'Local markets are a good place to browse.', 'Guides can help plan a loose route.', 'Comfortable shoes matter more than a long list of stops.', 'Lunch stretches into the afternoon for many visitors.', 'Travellers often plan the day around one main stop.', 'A relaxed pace makes the hills feel gentler.', 'Cafes fill with locals at midday.']
const copyRow = (over: Record<string, unknown> = {}) => ({
  id: COPY_ID, path: '/best-time-to-visit/lisbon', page_type: 'best-time', status: 'draft', source: 'ai', quality_notes: ORIGINAL_GUIDE_NOTE, created_at: new Date(Date.now() - 86_400_000).toISOString(),
  intro: `${words.join(' ')} The famous old town is a pleasant place to wander.`, faq: [{ q: 'Is Lisbon hilly?', a: 'Yes, the streets climb.' }, { q: 'Can I walk?', a: 'Yes, with grip shoes.' }, { q: 'Are there trams?', a: 'Yes, in the old streets.' }],
  key_takeaways: ['Hilly city', 'Walk with grip', 'Ride the trams'], meta_title: 'Lisbon travel pages', meta_description: 'A plain page about Lisbon for travellers who like to walk.', og_title: 'Lisbon travel pages', og_description: 'A plain page about Lisbon.', primary_keyword: 'lisbon travel', linked_slugs: ['lisbon-trip'], ...over,
})
const copyParts: CopyBriefParts = { ctx: { grounding: 'Lisbon is a city in Portugal. The Lisbon trip is listed.', destinations: ['Lisbon'], names: ['the "Lisbon trip" trip', 'our Lisbon page', 'Portugal'], allowedPaths: new Set(['/packages/lisbon-trip', '/destinations/lisbon']) }, links: [{ path: '/packages/lisbon-trip', label: 'the "Lisbon trip" trip' }] }

const goodBody = ['A river cruise is a relaxed way to see several towns without repacking.', '', '**Quick answer:** A river cruise suits first timers who want an easy pace, one bed all week and several towns without repacking.', '', '## Why a river cruise works for first timers', '', 'It is a floating hotel. See [the Rhine trip](/packages/rhine-cruise) for the real details, ask us in [the contact section](/#contact) or browse [our trips](/). ' + 'word '.repeat(460), '', '### Pace', '', 'Most people find the pace gentle. It is easy to settle in. You unpack once.', '', 'Have a think about who you would travel with, and our team can help you work that out.'].join('\n')
const mkPost = (extra: string): ComposedPost => ({
  title: 'River cruise for first timers', slug: 'river-cruise-heal', body: goodBody.replace('You unpack once.', `You unpack once.${extra}`),
  seo_title: 'River cruise for first timers', seo_description: 'A plain guide for first-time river cruisers.', tags: ['river cruise first timers'],
  faq: [{ q: 'Is a river cruise good for first timers?', a: 'Yes, the pace is gentle.' }, { q: 'Do I unpack every day?', a: 'No, you unpack once.' }, { q: 'Who is it for?', a: 'Anyone who likes an easy pace.' }],
  key_takeaways: ['Gentle pace', 'Unpack once', 'Good for first timers'], og_title: 'Is a river cruise right for you?', og_description: 'A plain-English look at river cruising for first timers.',
  primary_keyword: 'river cruise first timers', secondary_keywords: ['river cruise tips'], content_style: 'faq-led',
})
const postRow = (over: Record<string, unknown> = {}) => ({
  id: POST_ID, slug: 'river-cruise-1', status: 'draft', title: 'River cruise for first timers', body: mkPost(' Our guests loved the Rhine last year.').body, meta_title: 'River cruise for first timers',
  meta_description: 'A plain guide for first-time river cruisers.', tags: ['river cruise first timers'], faq: mkPost('').faq, key_takeaways: mkPost('').key_takeaways, og_title: 'Is a river cruise right for you?',
  og_description: 'A plain-English look at river cruising for first timers.', primary_keyword: 'river cruise first timers', secondary_keywords: ['river cruise tips'], content_style: 'faq-led', seo_score: null,
  created_at: new Date(Date.now() - 86_400_000).toISOString(), ...over,
})

const improvedSink = () => {
  const got: ImprovedInfo[] = []
  return { got, onImproved: (i: ImprovedInfo) => void got.push(i) }
}

async function main() {
  // ---- 1. Review mode: repairs, never publishes -------------------------------------------------
  {
    const db: Db = { tables: { app_settings: [{ key: 'guides_publish_mode', value: 'publish' }], content_edits: [], guides: [guideRow()] } }
    const sink = improvedSink()
    const r = await healHeldGuides(fakeAdmin(db), { now, model: scriptedModel(reword), guideBrief, budget: memBudget(), publish: false, onImproved: sink.onImproved })
    const row = db.tables.guides[0]
    check('1 guide: review mode repairs the text but the guide stays a HELD draft', r.published === 0 && row.status === 'draft' && !/famous/i.test(String(row.body)) && r.healedDraft === 1, JSON.stringify(r))
    check('1 guide: no publish edit is logged and the text edits are not marked as published', !db.tables.content_edits.some((e) => e.field === 'status') && db.tables.content_edits.length > 0 && db.tables.content_edits.every((e) => e.published_after === false))
    check('1 guide: the row carries the review marker so the daily heal leaves it alone', row.quality_notes === REVIEW_HOLD_NOTE && !isHealDraftCandidate(row, now, [REVIEW_HOLD_NOTE]))
    check('1 guide: the improvement is reported once, with the audit rows and the original note', sink.got.length === 1 && sink.got[0].type === 'guide' && sink.got[0].id === GUIDE_ID && sink.got[0].editIds.length === db.tables.content_edits.length && sink.got[0].originalNotes === ORIGINAL_GUIDE_NOTE, JSON.stringify(sink.got))
    const again = await healHeldGuides(fakeAdmin(db), { now: new Date(now.getTime() + 2 * 86_400_000), model: scriptedModel(reword), guideBrief, budget: memBudget() })
    check('1 guide: even the DEFAULT-mode daily heal does not publish or touch a review-held row', again.tried === 0 && db.tables.guides[0].status === 'draft', JSON.stringify(again))
  }
  {
    // default mode is unchanged (the System check button and the daily heal publish as always)
    const db: Db = { tables: { app_settings: [{ key: 'guides_publish_mode', value: 'publish' }], content_edits: [], guides: [guideRow()] } }
    const r = await healHeldGuides(fakeAdmin(db), { now, model: scriptedModel(reword), guideBrief, budget: memBudget() })
    check('1 guide: default mode (no publish option) still publishes a healed guide, as before', r.published === 1 && db.tables.guides[0].status === 'published' && db.tables.guides[0].quality_notes === null)
  }
  {
    const db: Db = { tables: { app_settings: [{ key: 'page_copy_publish_mode', value: 'publish' }], content_edits: [], page_copy: [copyRow()] } }
    const sink = improvedSink()
    const r = await healHeldCopy(fakeAdmin(db), { now, model: scriptedModel(reword), copyBrief: async () => copyParts, budget: memBudget(), publish: false, onImproved: sink.onImproved })
    const row = db.tables.page_copy[0]
    check('1 copy: review mode repairs the page copy but it stays a HELD draft', r.published === 0 && row.status === 'draft' && !/famous/i.test(String(row.intro)) && row.quality_notes === REVIEW_HOLD_NOTE, JSON.stringify(r))
    check('1 copy: no publish edit is logged, one improvement is reported', !db.tables.content_edits.some((e) => e.field === 'status') && sink.got.length === 1 && sink.got[0].type === 'page_copy' && sink.got[0].id === COPY_ID)
    const db2: Db = { tables: { app_settings: [{ key: 'page_copy_publish_mode', value: 'publish' }], content_edits: [], page_copy: [copyRow()] } }
    const r2 = await healHeldCopy(fakeAdmin(db2), { now, model: scriptedModel(reword), copyBrief: async () => copyParts, budget: memBudget() })
    check('1 copy: default mode still publishes, as before', r2.published === 1 && db2.tables.page_copy[0].status === 'published')
  }
  {
    const tag = { slug: 'river-cruise-1', variant_tags: { cta_style: 'soft-question', held_reasons: 'fabricated personal experience claim' } }
    const mk = (): Db => ({ tables: { app_settings: [{ key: 'autoblog_mode', value: 'publish' }], content_edits: [], posts: [postRow()], content_variants: [{ ...tag, variant_tags: { ...tag.variant_tags } }] } })
    const existing = new Set(['/', '/packages/rhine-cruise'])
    const db = mk()
    const sink = improvedSink()
    const r = await rehealStuckDrafts(fakeAdmin(db), { existing, now, model: scriptedModel(deleteFirst), refresh: false, publish: false, onImproved: sink.onImproved })
    const post = db.tables.posts[0]
    const variant = db.tables.content_variants[0].variant_tags as Record<string, unknown>
    check('1 post: review mode fixes the draft but does NOT publish it', r.published === 0 && post.status === 'draft' && !/Our guests loved/.test(String(post.body)) && r.repaired === 1, JSON.stringify(r))
    check('1 post: nothing is logged as a publish and the draft is tagged as waiting for review', !db.tables.content_edits.some((e) => e.field === 'status') && variant.reheal_state === 'review' && variant.held_reasons === '', JSON.stringify(variant))
    check('1 post: the improvement is reported with the audit rows', sink.got.length === 1 && sink.got[0].type === 'post' && sink.got[0].id === POST_ID && sink.got[0].editIds.length > 0 && sink.got[0].path === '/blog/river-cruise-1', JSON.stringify(sink.got))
    check('1 post: a draft tagged review is not a candidate for any later heal', !isRehealCandidate(post, { cta_style: 'x', held_reasons: 'y', reheal_state: 'review' }, now))
    const db2 = mk()
    const r2 = await rehealStuckDrafts(fakeAdmin(db2), { existing, now, model: scriptedModel(deleteFirst), refresh: false })
    check('1 post: default mode still publishes a clean draft, as before', r2.published === 1 && db2.tables.posts[0].status === 'published')
  }

  // ---- 2. The ai_heal step forces review mode and queues the item --------------------------------
  {
    const ai = src('lib/flywheel/steps/ai-heal.ts')
    check('2 step: the ai_heal step sets publish:false after the caller options (nothing can switch it back on)', /\.\.\.aiDeps,\s*\n[^\n]*\n?\s*publish: false/.test(ai) || (ai.indexOf('...aiDeps') > 0 && ai.indexOf('publish: false') > ai.indexOf('...aiDeps')))
    const btn = src('lib/system-check-heal.ts')
    check('2 step: the System check Auto-heal button path does not ask for review mode', !/publish:\s*false/.test(btn) && !/onImproved/.test(btn))
    const db: Db = { tables: { app_settings: [], content_edits: [] } }
    const admin = fakeAdmin(db)
    let seen = true as boolean | undefined
    const deps: AiHealDeps = {
      listed: async () => [{ id: 'quality', light: 'amber' }],
      runAi: async (a, listed, d) => {
        seen = d.publish
        await d.onImproved?.({ type: 'guide', id: GUIDE_ID, path: '/destinations/lisbon', title: 'Lisbon', editIds: [], originalNotes: 'x' })
        return runAiFixStep(a, listed, { ...d, aiConfigured: () => true, spend: async () => ({ spend: 0, ceiling: 10 }), budget: async () => memBudget(), repairs: { posts: async () => ({ tried: 1, changed: 1, calls: 1, note: 'ok' }), guides: async () => ({ tried: 0, changed: 0, calls: 0, note: '' }), copy: async () => ({ tried: 0, changed: 0, calls: 0, note: '' }) }, edits: async () => [], append: async () => undefined })
      },
    }
    const aiDeps: AiFixDeps = {}
    const res = await runAiHeal({ admin, now, startedAt: 0, budgetMs: 200_000, dryRun: false, remainingMs: () => 100_000, room: 3 }, deps, aiDeps)
    check('2 step: the step runs the AI fix with publish:false and queues what it improved', seen === false && res.ran === true && /held for your review on Today/.test(res.note ?? '') && openCount(await readQueue(admin)) === 1, JSON.stringify({ seen, res }))
    // a full queue stops the step before any AI call
    const full: Db = { tables: { app_settings: [{ key: AI_HEAL_REVIEW_KEY, value: JSON.stringify({ items: Array.from({ length: REVIEW_OPEN_CAP }, (_x, n) => item('post', `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`)) }) }], content_edits: [] } }
    let aiCalled = false
    const stopped = await runAiHeal({ admin: fakeAdmin(full), now, startedAt: 0, budgetMs: 200_000, dryRun: false, remainingMs: () => 100_000, room: 3 }, { listed: async () => [{ id: 'quality', light: 'red' }], runAi: async () => ((aiCalled = true), { items: [], calls: 0, skipped: '' }) })
    check('2 step: with 20 items already waiting nothing new is repaired (no AI call)', stopped.ran === false && !aiCalled && /waiting for your review/.test(stopped.reason ?? ''), JSON.stringify(stopped))
    const dry = await runAiHeal({ admin, now, startedAt: 0, budgetMs: 200_000, dryRun: true, remainingMs: () => 100_000, room: 3 }, { listed: async () => (aiCalled = true, []), runAi: async () => ((aiCalled = true), { items: [], calls: 0, skipped: '' }) })
    check('2 step: a dry run does nothing', dry.ran === false && !aiCalled)
    const capped = await runAiHeal({ admin, now, startedAt: 0, budgetMs: 200_000, dryRun: false, remainingMs: () => 100_000, room: 0 }, { listed: async () => (aiCalled = true, []), runAi: async () => ((aiCalled = true), { items: [], calls: 0, skipped: '' }) })
    check('2 step: the daily cap (room 0) does nothing', capped.ran === false && !aiCalled)
  }

  // ---- 3. The queue ------------------------------------------------------------------------------
  {
    const db: Db = { tables: { app_settings: [], content_edits: [{ id: 'e1', field: 'body', before: 'old text', after: 'new text' }, { id: 'e2', field: 'faq', before: 'a', after: 'b' }] } }
    const admin = fakeAdmin(db)
    const info = (n: number): ImprovedInfo => ({ type: 'guide', id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, path: `/destinations/p${n}`, title: `Page ${n}`, editIds: ['e1', 'e2'], originalNotes: null })
    const first = await enqueueReview(admin, info(1), now)
    const q1 = await readQueue(admin)
    check('3 queue: an improved item is queued with a before/after summary', first.queued && q1.items.length === 1 && /body, faq/.test(q1.items[0].summary.what) && q1.items[0].summary.before === 'old text' && q1.items[0].summary.after === 'new text', JSON.stringify(q1))
    const dup = await enqueueReview(admin, info(1), now)
    check('3 queue: the same page is never queued twice while it waits', !dup.queued && openCount(await readQueue(admin)) === 1, JSON.stringify(dup))
    for (let n = 2; n <= REVIEW_OPEN_CAP; n++) await enqueueReview(admin, info(n), now)
    check(`3 queue: ${REVIEW_OPEN_CAP} items fit`, openCount(await readQueue(admin)) === REVIEW_OPEN_CAP)
    const over = await enqueueReview(admin, info(99), now)
    check('3 queue: the 21st is refused (cap), the queue is unchanged', !over.queued && /already waiting/.test(over.reason) && openCount(await readQueue(admin)) === REVIEW_OPEN_CAP, JSON.stringify(over))
    check('3 queue: a damaged stored value reads as an empty queue', parseQueue('not json').items.length === 0 && parseQueue('{"items":"x"}').items.length === 0 && parseQueue(null).items.length === 0)
    check('3 queue: keys round-trip and bad keys are refused', parseReviewKey(reviewKey('page_copy', COPY_ID))?.type === 'page_copy' && parseReviewKey('guide-nope') === null && parseCardId(`heal-review:${reviewKey('post', POST_ID)}`)?.kind === 'heal-review' && parseCardId('heal-review:post-nope') === null)
    check('3 queue: summarize copes with no audit rows', summarize([]).what.length > 0)
    const dryDb: Db = { tables: { app_settings: [], content_edits: [] } }
    const { result: dryRes } = await withDryRun(() => enqueueReview(fakeAdmin(dryDb), info(7), now))
    check('3 queue: inside a dry run nothing is written', !dryRes.queued && dryDb.tables.app_settings.length === 0, JSON.stringify(dryRes))
  }

  // ---- 4. Approve and reject -----------------------------------------------------------------------
  {
    // A real held guide improved in review mode, then decided.
    const mk = async () => {
      const db: Db = { tables: { app_settings: [{ key: 'guides_publish_mode', value: 'publish' }], content_edits: [], guides: [guideRow()] } }
      const admin = fakeAdmin(db)
      const sink = improvedSink()
      await healHeldGuides(admin, { now, model: scriptedModel(reword), guideBrief, budget: memBudget(), publish: false, onImproved: sink.onImproved })
      await enqueueReview(admin, sink.got[0], now)
      return { db, admin, key: reviewKey('guide', GUIDE_ID) }
    }
    const deps = (db: Db, admin: SupabaseClient, gate: { refuse?: string } = {}): ReviewDeps & { published: string[] } => {
      const published: string[] = []
      return {
        published,
        publish: async (it, status = 'published') => {
          if (gate.refuse && status === 'published') return { ok: false, status: 409, error: gate.refuse }
          published.push(`${it.type}:${status}`)
          const row = db.tables.guides.find((g) => g.id === it.id)
          if (row) row.status = status
          return { ok: true, status: 200 }
        },
        revert: async (id) => {
          const r = await revertEdit(admin, id)
          return { ok: r.ok, error: r.error, needsForce: r.needsForce }
        },
        setNotes: async (it, notes) => {
          const row = db.tables.guides.find((g) => g.id === it.id)
          if (!row) return
          if (notes === REVIEW_HOLD_NOTE) row.quality_notes = notes
          else if (row.quality_notes === REVIEW_HOLD_NOTE) row.quality_notes = notes
        },
      }
    }
    {
      const { db, admin, key } = await mk()
      const d = deps(db, admin)
      const r = await approveReview(admin, key, d, now)
      const q = await readQueue(admin)
      check('4 approve: swipe right publishes through the normal publish path', r.ok && d.published[0] === 'guide:published' && db.tables.guides[0].status === 'published' && db.tables.guides[0].quality_notes === null, JSON.stringify({ r, st: db.tables.guides[0].status }))
      check('4 approve: the item is marked approved and leaves the open list', q.items[0].status === 'approved' && openCount(q) === 0)
      const again = await approveReview(admin, key, d, now)
      check('4 approve: a second tap does nothing (no second publish)', again.ok && again.noop === true && d.published.length === 1)
      db.tables.guides[0].status = 'draft'
      const reopened = await reopenReview(admin, key, d)
      check('4 approve: Today Undo (back to draft) puts the item back on the list, held and marked', reopened && openCount(await readQueue(admin)) === 1 && db.tables.guides[0].quality_notes === REVIEW_HOLD_NOTE)
    }
    {
      const { db, admin, key } = await mk()
      const d = deps(db, admin, { refuse: 'quality gate: still has a reputation claim' })
      const r = await approveReview(admin, key, d, now)
      const q = await readQueue(admin)
      check('4 approve: if the publish gate refuses, the draft stays held and the reason is shown', !r.ok && /stays held/.test(r.ok ? '' : r.error) && /reputation claim/.test(r.ok ? '' : r.error) && db.tables.guides[0].status === 'draft', JSON.stringify(r))
      check('4 approve: the refusal is kept on the item (shown on the card) and the item is still open', q.items[0].status === 'open' && /reputation claim/.test(q.items[0].refusal ?? ''))
    }
    {
      const { db, admin, key } = await mk()
      const d = deps(db, admin)
      const r = await rejectReview(admin, key, d, now)
      const q = await readQueue(admin)
      check('4 reject: swipe left keeps it held and puts the old text back (revertEdit)', r.ok && db.tables.guides[0].status === 'draft' && /famous/i.test(String(db.tables.guides[0].body)) && d.published.length === 0, JSON.stringify({ r }))
      check('4 reject: the original quality note is restored and every audit row is reverted', db.tables.guides[0].quality_notes === ORIGINAL_GUIDE_NOTE && db.tables.content_edits.every((e) => !!e.reverted_at))
      check('4 reject: the item is marked rejected and leaves the open list', q.items[0].status === 'rejected' && openCount(q) === 0)
      const again = await rejectReview(admin, key, d, now)
      check('4 reject: a second tap does nothing', again.ok && again.noop === true)
    }
    {
      // a person changed the text since: the revert is refused, nothing is lost, the card stays
      const { db, admin, key } = await mk()
      db.tables.guides[0].body = `${String(db.tables.guides[0].body)} A person added this.`
      const r = await rejectReview(admin, key, deps(db, admin), now)
      check('4 reject: if a person changed the page since, the old text is not forced back and the card stays', !r.ok && /changed|Content edits/.test(r.ok ? '' : r.error) && openCount(await readQueue(admin)) === 1 && /A person added this/.test(String(db.tables.guides[0].body)), JSON.stringify(r))
    }
  }

  // ---- 5. Wiring ---------------------------------------------------------------------------------------
  {
    const def = TODAY_KINDS['heal-review']
    check('5 card: the heal-review kind exists with Publish (undoable) and Keep held (confirm tap)', !!def && def.primary.mode === 'run' && def.secondary?.mode === 'run' && def.undo.primary === true && def.undo.secondary === false && needsConfirm('heal-review', 'reject') && !needsConfirm('heal-review', 'approve') && actionFor('heal-review', 'approve')?.label === 'Publish it')
    const actions = src('lib/today-actions.ts')
    check('5 card: lib/today-actions.ts runs and undoes it through the page routes, revertEdit and the review queue', /case 'heal-review'/.test(actions) && (actions.match(/case 'heal-review'/g) ?? []).length === 2 && /approveReview/.test(actions) && /rejectReview/.test(actions) && /revertEdit/.test(actions) && /api\/admin\/blog\/\[id\]\/route/.test(actions) && /api\/admin\/page-copy\/\[id\]\/route/.test(actions))
    const queue = src('lib/today-queue.ts')
    check('5 card: the Today queue lists open items and hides the plain draft cards for the same row', /healReviewCards\(admin\)/.test(queue) && /kind === 'blog-draft' && reviewKeys/.test(queue))
    const reg = src('docs/factory/FLYWHEEL-REGISTRY.md')
    check('5 docs: FLYWHEEL-REGISTRY.md describes the review mode', /ai_heal_review/.test(reg) && /never publishes/i.test(reg))
    check('5 text: no long dash in the new card text or queue file', !/[–—]/.test(JSON.stringify(TODAY_KINDS['heal-review']) + src('lib/ai-heal-review.ts')))
    // keep the type of the helpers referenced
    void composedGuideFromRow
    void composedCopyFromRow
    void guideBlockers
    void pageCopyBlockers
    void addItem
  }

  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) FAILED.`)
  process.exit(failed === 0 ? 0 : 1)
}

function item(type: ReviewItem['type'], id: string): ReviewItem {
  return { key: reviewKey(type, id), type, id, path: '/x', title: 'x', editIds: [], summary: { what: 'w', before: '', after: '' }, originalNotes: null, at: new Date().toISOString(), status: 'open' }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
