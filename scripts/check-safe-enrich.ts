// Offline checks for safe-page enrichment (lib/safe-enrich.ts): picks one safe page a day, respects the 3-try cap and the 2-day gap, replaces
// the text only when the result passes the gate and the independent judge and is clearly fuller, leaves the safe page alone on any failure,
// clears the note (indexing resumes) on success, and never touches a guessed name or a named property whose name is not in stored package data.
// Fakes only: no network, no database, no AI call.
// Run: pnpm dlx tsx scripts/check-safe-enrich.ts
import { readFileSync } from 'node:fs'

process.env.ANTHROPIC_API_KEY = ''
process.env.INDEXNOW_KEY = ''

import { fakeAdmin, type Db, type Row } from './fake-admin'
import { groundingText, guideBlockers, type ComposedGuide, type GateContext, type GuideBrief } from '../lib/guide-composer'
import { buildSafePage, fieldsToGuide, parentFromGrounding } from '../lib/guide-repairs'
import { GUIDE_LIMITS } from '../lib/content-repair-adapters'
import { memoryBudget } from '../lib/heal-loop'
import { revertEdit } from '../lib/content-edits'
import { GUESSED_PROPERTY_NOTE } from '../lib/guide-run'
import { ENRICH_REASON_PREFIX, SAFE_PAGE_NOTE, guideKinds, isSafePageNote, withoutThinPages, type GuideKind } from '../lib/guides'
import {
  ENRICH_ATTEMPTS_KEY,
  ENRICH_MAX_ATTEMPTS,
  ENRICH_MIN_BUDGET,
  describeSafePage,
  enrichBlockReason,
  enrichmentShortfall,
  listSafePages,
  nameIsStored,
  orderEnrichable,
  readEnrichAttempts,
  runSafeEnrichment,
  sectionCountOf,
  type EnrichAttempts,
  type EnrichBrief,
  type EnrichBriefLoader,
} from '../lib/safe-enrich'

const LONG_DASH = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']')
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failed++
}
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const wordCount = (s: string, b: string) => `${s} ${b}`.trim().split(/\s+/).filter(Boolean).length

const NOW = new Date('2026-10-22T10:00:00Z')
const daysAfter = (n: number) => new Date(NOW.getTime() + n * 86_400_000)

const LINKS = [
  { path: '/packages/atlantis-week', label: 'the "Atlantis Week" trip' },
  { path: '/packages', label: 'all our trips' },
  { path: '/#contact', label: 'the contact form' },
]
const ALLOWED = new Set(['/', '/packages', '/packages/atlantis-week'])

function briefFor(kind: GuideKind, name: string, withPackage: boolean): GuideBrief {
  return {
    kind,
    name,
    parentName: null,
    packages: withPackage ? [{ name: 'Atlantis Week', slug: 'atlantis-week', destination: 'Bahamas', category: 'families', short_description: 'A relaxed family week.', year: '2027' }] : [],
    keywords: [],
    blurb: null,
    links: LINKS,
  }
}
const ctxFor = (b: GuideBrief): GateContext => ({ grounding: groundingText(b), allowedPaths: ALLOWED, names: [...(b.parentName ? [b.parentName] : []), ...b.links.map((l) => l.label)] })

interface Safe {
  fields: NonNullable<ReturnType<typeof buildSafePage>>
  ctx: GateContext
  brief: GuideBrief
}
function safeFor(kind: GuideKind, name: string, withPackage: boolean): Safe {
  const brief = briefFor(kind, name, withPackage)
  const ctx = ctxFor(brief)
  const fields = buildSafePage({ kind, name, parentName: parentFromGrounding(ctx.grounding), links: LINKS, limits: GUIDE_LIMITS }, ctx)
  if (!fields) throw new Error(`no safe page for ${name}`)
  return { fields, ctx, brief }
}

const sectionsOfBody = (body: string) => body.split(/^(?=##\s)/m).filter((c) => /^##\s/.test(c)).map((c) => c.trimEnd())
const paragraphsOf = (section: string) => section.replace(/^##[^\n]*\n+/, '').split(/\n\s*\n/).filter(Boolean)

/** A guide that is fuller than the safe page: every section gets one more paragraph (taken from the neighbouring section) until the
 * text is at least `factor` times as long. Built only from safe-page sentences, so it passes the real gate. */
function fullerGuide(s: Safe, name: string, kind: GuideKind, factor: number, sectionCount = 10): ComposedGuide {
  let secs = sectionsOfBody(s.fields.body)
  if (sectionCount < secs.length) {
    // fold the tail into fewer sections
    const head = secs.slice(0, sectionCount - 1)
    const tail = secs.slice(sectionCount - 1).map((x) => paragraphsOf(x).join('\n\n'))
    secs = [...head, `${secs[sectionCount - 1].split('\n')[0]}\n\n${tail.join('\n\n')}`]
  }
  const target = Math.ceil(wordCount(s.fields.summary ?? '', s.fields.body) * factor) + 5
  const extras = secs.map((_x, i) => paragraphsOf(secs[(i + 1) % secs.length]))
  let round = 0
  let body = secs.join('\n\n')
  while (wordCount(s.fields.summary ?? '', body) < target && round < secs.length * 2) {
    const i = round % secs.length
    const para = extras[i][round >= secs.length ? 1 % extras[i].length : 0]
    secs[i] = `${secs[i]}\n\n${para}`
    body = secs.join('\n\n')
    round++
  }
  // A real rewrite changes the search text too, so the fresh page gets its own meta description and share description.
  return fieldsToGuide({ ...s.fields, body, meta_description: `A fuller plain-English guide to ${name} with practical points for planning a trip.`, og_description: `A fuller guide to ${name} and how to plan a trip.` }, name, guideKinds[kind].guideLabel, `${name} guide`)
}

interface Rig {
  db: Db
  admin: ReturnType<typeof fakeAdmin>
  composed: string[]
  loadBrief: EnrichBriefLoader
  model: (prompt: string) => Promise<string | null>
}

function rowFor(kind: GuideKind, slug: string, name: string, s: Safe, extra: Row = {}): Row {
  const g = fieldsToGuide(s.fields, name, guideKinds[kind].guideLabel, `${name} guide`)
  return {
    id: `g-${slug}`, kind, slug, name, parent_slug: null, status: 'published', source: 'ai', review_state: null, quality_notes: SAFE_PAGE_NOTE,
    created_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-20T00:00:00Z',
    summary: g.summary, body: g.body, sections: g.sections, faq: g.faq, key_takeaways: g.key_takeaways,
    meta_title: g.meta_title, meta_description: g.meta_description, og_title: g.og_title, og_description: g.og_description, primary_keyword: g.primary_keyword, secondary_keywords: [],
    ...extra,
  }
}

/** The fakes. `freshFor(slug)` is what the standard writer "writes" for that guide; the model passes (or fails) the judge as told. */
function rig(rows: Row[], freshFor: (row: Row) => ComposedGuide | { error: string }, opts: { judgePass?: boolean; briefs?: Record<string, Safe>; extraTables?: Record<string, Row[]>; settings?: Row[] } = {}): Rig {
  const db: Db = { tables: { app_settings: [{ key: 'guides_publish_mode', value: 'publish' }, ...(opts.settings ?? [])], content_edits: [], guides: rows, ...(opts.extraTables ?? {}) } }
  const composed: string[] = []
  const loadBrief: EnrichBriefLoader = async (row): Promise<EnrichBrief | null> => {
    const s = opts.briefs?.[`${String(row.kind)}/${String(row.slug)}`]
    if (!s) return null
    return {
      ctx: s.ctx,
      links: LINKS,
      compose: async () => {
        composed.push(`${String(row.kind)}/${String(row.slug)}`)
        const r = freshFor(row)
        return 'error' in r ? r : { guide: r }
      },
    }
  }
  const model = async (prompt: string): Promise<string | null> => {
    if (/independent quality reviewer/.test(prompt)) return opts.judgePass === false ? '{"pass":false,"failures":[{"quote":"nothing in particular here","reason":"unsupported"}]}' : '{"pass":true,"failures":[]}'
    return '{"rewrites":[]}'
  }
  return { db, admin: fakeAdmin(db), composed, loadBrief, model }
}

async function main() {
  const atlantis = safeFor('resorts', 'Atlantis Paradise Island', true)
  const riviera = safeFor('destinations', 'Riviera Maya', false)
  const safeWords = wordCount(atlantis.fields.summary ?? '', atlantis.fields.body)
  check('setup: the safe page passes the real gate and has 10 sections', guideBlockers(fieldsToGuide(atlantis.fields, 'Atlantis Paradise Island', 'Resort Guide', 'x'), atlantis.ctx).length === 0 && sectionCountOf(atlantis.fields.body) === 10, `${safeWords} words`)
  const full = fullerGuide(atlantis, 'Atlantis Paradise Island', 'resorts', 1.4)
  check('setup: the fuller test page passes the real gate and is at least 1.4 times the safe page', guideBlockers(full, atlantis.ctx).length === 0 && wordCount(full.summary, full.body) >= safeWords * 1.4, JSON.stringify({ b: guideBlockers(full, atlantis.ctx), w: wordCount(full.summary, full.body), safeWords }))

  const BRIEFS = { 'resorts/atlantis-paradise-island': atlantis, 'destinations/riviera-maya': riviera }
  const rowA = () => rowFor('resorts', 'atlantis-paradise-island', 'Atlantis Paradise Island', atlantis)
  const rowB = () => rowFor('destinations', 'riviera-maya', 'Riviera Maya', riviera, { created_at: '2026-10-21T00:00:00Z' })
  const freshOk = (row: Row) => (String(row.slug) === 'atlantis-paradise-island' ? fullerGuide(atlantis, 'Atlantis Paradise Island', 'resorts', 1.4) : fullerGuide(riviera, 'Riviera Maya', 'destinations', 1.4))

  // ---------------------------------------------------------------------------------------------
  // 1. The pure rules
  // ---------------------------------------------------------------------------------------------
  {
    const live = rowA()
    const att = (n: number, at: string): EnrichAttempts[string] => ({ n, at, last: 'x' })
    check('R1: a live AI safe page with no tries is due', enrichBlockReason(live, undefined, NOW) === null)
    check('R2: a draft, a manual page or a page without the safe-page note is never due', enrichBlockReason({ ...live, status: 'draft' }, undefined, NOW) !== null && enrichBlockReason({ ...live, source: 'manual' }, undefined, NOW) !== null && enrichBlockReason({ ...live, quality_notes: null }, undefined, NOW) !== null)
    check(`R3: after ${ENRICH_MAX_ATTEMPTS} tries it is never due again, however old the last try`, enrichBlockReason(live, att(ENRICH_MAX_ATTEMPTS, '2020-01-01T00:00:00Z'), NOW) !== null && enrichBlockReason(live, att(ENRICH_MAX_ATTEMPTS - 1, '2020-01-01T00:00:00Z'), NOW) === null)
    check('R4: at least 2 days between tries (47h no, 48h yes)', enrichBlockReason(live, att(1, new Date(NOW.getTime() - 47 * 3_600_000).toISOString()), NOW) !== null && enrichBlockReason(live, att(1, new Date(NOW.getTime() - 48 * 3_600_000).toISOString()), NOW) === null)
    check('R5: a guessed name (taken from a trip title) is never due, even with the safe-page note', enrichBlockReason({ ...live, quality_notes: `${SAFE_PAGE_NOTE}; ${GUESSED_PROPERTY_NOTE}` }, undefined, NOW) !== null)
    const rows = [
      { ...rowB(), slug: 'older-one', created_at: '2026-10-01T00:00:00Z' },
      { ...rowA(), slug: 'one-try', created_at: '2026-09-01T00:00:00Z' },
      { ...rowA(), slug: 'fresh', created_at: '2026-10-10T00:00:00Z' },
      { ...rowA(), slug: 'capped', created_at: '2026-08-01T00:00:00Z' },
    ]
    const attempts: EnrichAttempts = { 'resorts:one-try': att(1, '2026-10-01T00:00:00Z'), 'resorts:capped': att(3, '2026-10-01T00:00:00Z') }
    check('R6: due pages are ordered fewest tries first, then oldest first, and a capped page is left out', orderEnrichable(rows, attempts, NOW).map((r) => String(r.slug)).join(',') === 'older-one,fresh,one-try', orderEnrichable(rows, attempts, NOW).map((r) => String(r.slug)).join(','))
    check('R7: force (the admin script) lifts the 2-day gap but not the 3-try cap', enrichBlockReason(live, att(1, NOW.toISOString()), NOW, { force: true }) === null && enrichBlockReason(live, att(3, NOW.toISOString()), NOW, { force: true }) !== null)
    check('R8: a named property needs its name in stored package data; a destination does not', !nameIsStored('hotels', atlantis.brief.packages.length ? riviera.ctx.grounding : '') && nameIsStored('resorts', atlantis.ctx.grounding) && nameIsStored('destinations', riviera.ctx.grounding) && !nameIsStored('ships', riviera.ctx.grounding) && !nameIsStored('yachts', riviera.ctx.grounding))
    const safe = { summary: atlantis.fields.summary ?? '', body: atlantis.fields.body }
    check('R9: fuller means at least 1.3 times the words and at least 8 sections', enrichmentShortfall(safe, { summary: full.summary, body: full.body }) === null)
    check('R9b: the same page, or only 1.2 times as long, is not fuller', enrichmentShortfall(safe, safe) !== null && enrichmentShortfall(safe, fullerGuide(atlantis, 'Atlantis Paradise Island', 'resorts', 1.2)) !== null)
    const six = fullerGuide(atlantis, 'Atlantis Paradise Island', 'resorts', 1.4, 6)
    check('R9c: a long page with only 6 sections is not fuller', sectionCountOf(six.body) === 6 && wordCount(six.summary, six.body) >= safeWords * 1.3 && enrichmentShortfall(safe, { summary: six.summary, body: six.body }) !== null, `${sectionCountOf(six.body)} sections`)
  }

  // ---------------------------------------------------------------------------------------------
  // 2. Success: one page, text replaced through content_edits, note cleared, indexing unlocked, Undo works
  // ---------------------------------------------------------------------------------------------
  {
    const r = rig([rowA(), rowB()], freshOk, { briefs: BRIEFS })
    const before = { ...r.db.tables.guides[0] }
    const out = await runSafeEnrichment(r.admin, { now: NOW, model: r.model, budget: memoryBudget(60), loadBrief: r.loadBrief })
    const a = r.db.tables.guides[0]
    const b = r.db.tables.guides[1]
    check('E1: exactly one safe page is upgraded per run (the oldest)', out.action === 'enriched' && out.enriched === 1 && r.composed.join(',') === 'resorts/atlantis-paradise-island', JSON.stringify({ out: out.note, composed: r.composed, problems: out.problems }))
    check('E2: the upgraded page is fuller (1.3 times the words, 8+ sections) and its text really changed', wordCount(String(a.summary), String(a.body)) >= safeWords * 1.3 && sectionCountOf(String(a.body)) >= 8 && a.body !== before.body && Array.isArray(a.sections) && (a.sections as unknown[]).length >= 8)
    check('E3: the safe-page note is cleared, so the page is indexable and listed again', a.quality_notes === null && !isSafePageNote(String(a.quality_notes)) && withoutThinPages([{ slug: 'x', quality_notes: a.quality_notes as string | null }]).length === 1)
    check('E4: the other safe page is untouched (one a day)', b.body === rowB().body && isSafePageNote(String(b.quality_notes)) && !r.composed.includes('destinations/riviera-maya'))
    const edits = r.db.tables.content_edits
    const bodyEdit = edits.find((e) => e.field === 'body')
    check('E5: every change is logged first to content_edits against the SAFE PAGE text, tagged as an enrichment, pointing at the live page', edits.length >= 2 && !!bodyEdit && bodyEdit.content_id === 'g-atlantis-paradise-island' && bodyEdit.path === '/resorts/atlantis-paradise-island' && String(bodyEdit.before).includes(String(before.body).slice(0, 80)) && String(bodyEdit.after).includes(String(a.body).slice(0, 80)) && edits.every((e) => String(e.reason).startsWith(ENRICH_REASON_PREFIX) && e.published_after === true), JSON.stringify(edits.map((e) => [e.field, e.content_id, e.path])))
    const again = await runSafeEnrichment(r.admin, { now: NOW, model: r.model, budget: memoryBudget(60), loadBrief: r.loadBrief })
    check('E6: a second run the same day does nothing (the once-a-day marker)', again.action === 'skipped' && /already tried/.test(again.note) && r.composed.length === 1, again.note)
    const store = await readEnrichAttempts(r.admin)
    check('E7: the finished page leaves the attempts record; the other page has no try', !('resorts:atlantis-paradise-island' in store.attempts) && !('destinations:riviera-maya' in store.attempts))

    // next day: the second safe page is the one tried (the first is a full page now)
    const day2 = await runSafeEnrichment(r.admin, { now: daysAfter(1), model: r.model, budget: memoryBudget(60), loadBrief: r.loadBrief })
    check('E9: the next day it moves on to the next safe page', day2.enriched === 1 && r.composed.includes('destinations/riviera-maya') && r.db.tables.guides[1].quality_notes === null, day2.note)

    // Undo of the body edit puts the safe page back, with its note, so the thin text never comes back indexable
    const rev = await revertEdit(r.admin, String(bodyEdit!.id))
    const back = r.db.tables.guides[0]
    check('E8: Undo of the upgrade restores the safe-page text AND the safe-page note (noindex again)', rev.ok && String(back.body) === String(before.body) && isSafePageNote(String(back.quality_notes)), JSON.stringify({ rev, notes: back.quality_notes }))
  }

  // ---------------------------------------------------------------------------------------------
  // 3. Failure leaves the safe page exactly as it was
  // ---------------------------------------------------------------------------------------------
  const untouched = (r: Rig, row: Row) => {
    const now = r.db.tables.guides[0]
    return now.body === row.body && now.summary === row.summary && JSON.stringify(now.faq) === JSON.stringify(row.faq) && now.quality_notes === SAFE_PAGE_NOTE && now.updated_at === row.updated_at && r.db.tables.content_edits.length === 0
  }
  {
    const row = rowA()
    const r = rig([{ ...row }], freshOk, { briefs: BRIEFS, judgePass: false })
    const out = await runSafeEnrichment(r.admin, { now: NOW, model: r.model, budget: memoryBudget(60), loadBrief: r.loadBrief })
    const att = (await readEnrichAttempts(r.admin)).attempts['resorts:atlantis-paradise-island']
    check('F1: the independent judge fails the new text, so the safe page stays untouched (and nothing is logged)', out.action === 'failed' && untouched(r, row), JSON.stringify({ out: out.note, notes: r.db.tables.guides[0].quality_notes }))
    check('F1b: the failed try is counted and explained', att?.n === 1 && att.last.length > 5 && !/started/.test(att.last), JSON.stringify(att))
  }
  {
    const row = rowA()
    const r = rig([{ ...row }], () => fullerGuide(atlantis, 'Atlantis Paradise Island', 'resorts', 1.2), { briefs: BRIEFS })
    const out = await runSafeEnrichment(r.admin, { now: NOW, model: r.model, budget: memoryBudget(60), loadBrief: r.loadBrief })
    check('F2: a page that passes the gate and the judge but is not clearly fuller does not replace the safe page', out.action === 'failed' && /not fuller/.test(out.note) && untouched(r, row), out.note)
  }
  {
    const row = rowA()
    const r = rig([{ ...row }], () => fullerGuide(atlantis, 'Atlantis Paradise Island', 'resorts', 1.5, 6), { briefs: BRIEFS })
    const out = await runSafeEnrichment(r.admin, { now: NOW, model: r.model, budget: memoryBudget(60), loadBrief: r.loadBrief })
    check('F3: a long page with fewer than 8 sections does not replace the safe page', out.action === 'failed' && /too few sections/.test(out.note) && untouched(r, row), out.note)
  }
  {
    const row = rowA()
    const r = rig([{ ...row }], () => ({ error: 'writing the article failed: overloaded' }), { briefs: BRIEFS })
    const out = await runSafeEnrichment(r.admin, { now: NOW, model: r.model, budget: memoryBudget(60), loadBrief: r.loadBrief })
    check('F4: the writer failing leaves the safe page untouched', out.action === 'failed' && untouched(r, row), out.note)
  }
  {
    // A page the gate refuses and the heal can only fix by hollowing out is NOT accepted: a fresh page full of flagged lines, stripped, is shorter than the safe page
    const row = rowA()
    const flagged = fullerGuide(atlantis, 'Atlantis Paradise Island', 'resorts', 1.0)
    const body = sectionsOfBody(flagged.body).map((s) => `${s.split('\n')[0]}\n\nThe best beaches are famous and hundreds of guests agree. We offer hosted group trips here.`).join('\n\n')
    const hollow = fieldsToGuide({ summary: flagged.summary, body, meta_title: flagged.meta_title, meta_description: flagged.meta_description, og_title: flagged.og_title, og_description: flagged.og_description, faq: flagged.faq, key_takeaways: flagged.key_takeaways }, 'Atlantis Paradise Island', 'Resort Guide', 'x')
    const r = rig([{ ...row }], () => hollow, { briefs: BRIEFS })
    const out = await runSafeEnrichment(r.admin, { now: NOW, model: r.model, budget: memoryBudget(60), loadBrief: r.loadBrief })
    check('F5: a page that only passes after most of it is stripped away never replaces the safe page', out.action === 'failed' && untouched(r, row) && !out.ladder.includes('safe-page'), JSON.stringify({ a: out.action, n: out.note }))
  }
  {
    // a person edited the page while the heal was working: the guarded save matches nothing and the edit is taken back
    const row = rowA()
    const r = rig([{ ...row }], freshOk, { briefs: BRIEFS })
    const slowModel = async (prompt: string) => {
      r.db.tables.guides[0].updated_at = '2026-10-22T09:59:00Z'
      return r.model(prompt)
    }
    const out = await runSafeEnrichment(r.admin, { now: NOW, model: slowModel, budget: memoryBudget(60), loadBrief: r.loadBrief })
    const now = r.db.tables.guides[0]
    check('F6: a page changed by someone else while the upgrade ran is left alone, and its audit rows are taken back', out.action === 'failed' && now.body === row.body && isSafePageNote(String(now.quality_notes)) && r.db.tables.content_edits.length === 0, out.note)
  }
  {
    const row = rowA()
    const r = rig([{ ...row }], freshOk, { briefs: BRIEFS })
    r.db.failWrites = { content_edits: 'disk full' }
    const out = await runSafeEnrichment(r.admin, { now: NOW, model: r.model, budget: memoryBudget(60), loadBrief: r.loadBrief })
    check('F7: if the audit log cannot be written, the page is not changed (log first, then apply)', out.action === 'skipped' || out.action === 'failed', out.note)
    check('F7b: and the text is still the safe page', r.db.tables.guides[0].body === row.body && isSafePageNote(String(r.db.tables.guides[0].quality_notes)))
  }

  // ---------------------------------------------------------------------------------------------
  // 4. Attempts and spacing across days: 3 tries, 2 days apart, then never again
  // ---------------------------------------------------------------------------------------------
  {
    const row = rowA()
    const r = rig([{ ...row }], () => fullerGuide(atlantis, 'Atlantis Paradise Island', 'resorts', 1.2), { briefs: BRIEFS })
    const tryOn = async (days: number) => runSafeEnrichment(r.admin, { now: daysAfter(days), model: r.model, budget: memoryBudget(60), loadBrief: r.loadBrief })
    const d0 = await tryOn(0)
    const d1 = await tryOn(1)
    const d2 = await tryOn(2)
    const d4 = await tryOn(4)
    const d6 = await tryOn(6)
    const d30 = await tryOn(30)
    const n = (await readEnrichAttempts(r.admin)).attempts['resorts:atlantis-paradise-island']?.n
    check('A1: day 0 tries (1), day 1 waits (2-day gap), day 2 tries (2), day 4 tries (3)', d0.tried === 1 && d1.tried === 0 && /no safe page is due/.test(d1.note) && d2.tried === 1 && d4.tried === 1, JSON.stringify([d0.note, d1.note, d2.note, d4.note]))
    check('A2: after 3 tries it is never tried again (day 6 and day 30 do nothing) and the record says 3', d6.tried === 0 && d30.tried === 0 && n === ENRICH_MAX_ATTEMPTS && r.composed.length === 3, JSON.stringify({ n, composed: r.composed.length }))
    check('A3: the safe page is still the safe page after three failures', untouched(r, row))
    const line = describeSafePage(r.db.tables.guides[0], (await readEnrichAttempts(r.admin)).attempts['resorts:atlantis-paradise-island'], daysAfter(30))
    const listed = await listSafePages(r.admin, daysAfter(30))
    check('A4: the Guide Pages line says it is a safe page and that all 3 tries are used', line.state === 'used-up' && /3 of 3 tries used/.test(line.text) && listed.pages.length === 1 && listed.pages[0].attempts === 3 && listed.pages[0].path === '/resorts/atlantis-paradise-island', JSON.stringify(listed))
  }
  {
    // a corrupt attempts record fails closed: no try, no spend
    const r = rig([rowA()], freshOk, { briefs: BRIEFS, settings: [{ key: ENRICH_ATTEMPTS_KEY, value: '{not json' }] })
    const out = await runSafeEnrichment(r.admin, { now: NOW, model: r.model, budget: memoryBudget(60), loadBrief: r.loadBrief })
    check('A5: an unreadable attempts record means no try at all (fail closed)', out.tried === 0 && r.composed.length === 0 && out.problems.length > 0, out.note)
  }

  // ---------------------------------------------------------------------------------------------
  // 5. Names that must never be touched
  // ---------------------------------------------------------------------------------------------
  {
    const guessed = rowA()
    guessed.quality_notes = `${SAFE_PAGE_NOTE}; ${GUESSED_PROPERTY_NOTE}`
    const r = rig([guessed], freshOk, { briefs: BRIEFS })
    const out = await runSafeEnrichment(r.admin, { now: NOW, model: r.model, budget: memoryBudget(60), loadBrief: r.loadBrief })
    check('N1: a name guessed from a trip title is never touched (no writer call, no change)', out.tried === 0 && r.composed.length === 0 && r.db.tables.guides[0].body === guessed.body && r.db.tables.guides[0].quality_notes === guessed.quality_notes && r.db.tables.content_edits.length === 0, out.note)
  }
  {
    // a named property whose name is not in stored package data: passed over with no AI spend and no try used; a later safe page still gets its turn
    const noPkg = safeFor('hotels', 'Sea View Hotel', false)
    const hotel = rowFor('hotels', 'sea-view-hotel', 'Sea View Hotel', noPkg, { created_at: '2026-10-01T00:00:00Z' })
    const r = rig([hotel, rowB()], (row) => (String(row.slug) === 'riviera-maya' ? fullerGuide(riviera, 'Riviera Maya', 'destinations', 1.4) : { error: 'must never be written' }), { briefs: { ...BRIEFS, 'hotels/sea-view-hotel': noPkg } })
    const out = await runSafeEnrichment(r.admin, { now: NOW, model: r.model, budget: memoryBudget(60), loadBrief: r.loadBrief })
    const att = (await readEnrichAttempts(r.admin)).attempts
    check('N2: a named property whose name is not in stored package data is never written or changed', !r.composed.includes('hotels/sea-view-hotel') && r.db.tables.guides[0].body === hotel.body && isSafePageNote(String(r.db.tables.guides[0].quality_notes)), JSON.stringify(r.composed))
    check('N2b: it uses none of its tries, says why, and the next safe page is upgraded instead', att['hotels:sea-view-hotel']?.n === 0 && /not in stored package data/.test(att['hotels:sea-view-hotel']?.skip ?? '') && out.enriched === 1 && r.composed.join(',') === 'destinations/riviera-maya', JSON.stringify({ att, out: out.note }))
  }
  {
    const r = rig([rowA()], freshOk, { briefs: BRIEFS })
    const live = r.db.tables.guides[0]
    live.status = 'draft'
    const out = await runSafeEnrichment(r.admin, { now: NOW, model: r.model, budget: memoryBudget(60), loadBrief: r.loadBrief })
    check('N3: a draft is not a live safe page and is never touched', out.tried === 0 && r.composed.length === 0)
  }

  // ---------------------------------------------------------------------------------------------
  // 6. Budget, publish mode, pause, time, dry run, --only
  // ---------------------------------------------------------------------------------------------
  {
    const r = rig([rowA()], freshOk, { briefs: BRIEFS })
    const low = await runSafeEnrichment(r.admin, { now: NOW, model: r.model, budget: memoryBudget(ENRICH_MIN_BUDGET - 1), loadBrief: r.loadBrief })
    const store = await readEnrichAttempts(r.admin)
    check('B1: with too little heal budget left it waits: no writer call, no try used, and the day is not wasted', low.action === 'deferred' && r.composed.length === 0 && Object.keys(store.attempts).length === 0 && !r.db.tables.app_settings.some((s) => String(s.key).startsWith('content_repair_once:')), low.note)
    const ok = await runSafeEnrichment(r.admin, { now: NOW, model: r.model, budget: memoryBudget(60), loadBrief: r.loadBrief })
    check('B1b: the same day, once there is budget, it runs', ok.enriched === 1)
    const unreadable = await runSafeEnrichment(rig([rowA()], freshOk, { briefs: BRIEFS }).admin, { now: NOW, model: r.model, budget: { cap: 0, used: 0, readable: false, reason: 'counter unreadable', remaining: () => 0, take: async () => false }, loadBrief: r.loadBrief })
    check('B1c: an unreadable heal counter means no spend (fail closed)', unreadable.action === 'deferred')
    const short = await runSafeEnrichment(rig([rowA()], freshOk, { briefs: BRIEFS }).admin, { now: NOW, model: r.model, budget: memoryBudget(60), loadBrief: r.loadBrief, deadlineMs: Date.now() + 10_000 })
    check('B1d: with too little time left it waits and uses no try', short.action === 'deferred' && /time/.test(short.note))
  }
  {
    const draftMode = rig([rowA()], freshOk, { briefs: BRIEFS })
    draftMode.db.tables.app_settings[0].value = 'draft'
    const a = await runSafeEnrichment(draftMode.admin, { now: NOW, model: draftMode.model, budget: memoryBudget(60), loadBrief: draftMode.loadBrief })
    const paused = rig([rowA()], freshOk, { briefs: BRIEFS })
    const src2 = src('lib/automation-kill-switch.ts')
    const keyMatch = /'([a-z_]*pause[a-z_]*)'/.exec(src2)
    if (keyMatch) paused.db.tables.app_settings.push({ key: keyMatch[1], value: 'true' })
    const b = await runSafeEnrichment(paused.admin, { now: NOW, model: paused.model, budget: memoryBudget(60), loadBrief: paused.loadBrief })
    check('B2: nothing runs when guides are not in publish mode', a.action === 'skipped' && draftMode.composed.length === 0)
    check('B2b: nothing runs while automation is paused', !keyMatch || (b.action === 'skipped' && paused.composed.length === 0), b.note)
  }
  {
    const r = rig([rowA(), rowB()], freshOk, { briefs: BRIEFS })
    const dry = await runSafeEnrichment(r.admin, { now: NOW, dry: true, force: true, model: r.model, budget: memoryBudget(60), loadBrief: r.loadBrief })
    check('D1: a dry run changes nothing: no writer call, no try, no audit row, no daily marker', dry.action === 'skipped' && /dry run/.test(dry.note) && r.composed.length === 0 && r.db.tables.content_edits.length === 0 && !r.db.tables.app_settings.some((s) => String(s.key).startsWith('content_repair_once:') || s.key === ENRICH_ATTEMPTS_KEY) && r.db.tables.guides.every((g) => isSafePageNote(String(g.quality_notes))))
    const only = await runSafeEnrichment(r.admin, { now: NOW, force: true, only: 'destinations/riviera-maya', model: r.model, budget: memoryBudget(60), loadBrief: r.loadBrief })
    check('D2: --only picks that page, and force lifts the once-a-day marker and the gap', only.enriched === 1 && r.composed.join(',') === 'destinations/riviera-maya' && isSafePageNote(String(r.db.tables.guides[0].quality_notes)))
    const manual = await runSafeEnrichment(r.admin, { now: NOW, force: true, only: 'resorts/atlantis-paradise-island', model: r.model, budget: memoryBudget(60), loadBrief: r.loadBrief })
    check('D3: a second manual run the same day works (force) and upgrades the other page', manual.enriched === 1 && r.db.tables.guides[0].quality_notes === null)
    const none = await runSafeEnrichment(r.admin, { now: NOW, force: true, only: 'hotels/nope', model: r.model, budget: memoryBudget(60), loadBrief: r.loadBrief })
    check('D4: --only with a page that is not a live safe page does nothing', none.tried === 0)
  }

  // ---------------------------------------------------------------------------------------------
  // 7. Wiring: no new cron, same daily step, script flag, admin line, no em dashes
  // ---------------------------------------------------------------------------------------------
  {
    const heal = src('lib/content-heal-run.ts')
    check('W1: the daily heal step (content-heal-run) calls runSafeEnrichment, once, right after the held guides', /import \{ runSafeEnrichment \} from '@\/lib\/safe-enrich'/.test(heal) && (heal.match(/runSafeEnrichment\(/g) ?? []).length === 1 && heal.indexOf('healHeldGuides(admin') < heal.indexOf('runSafeEnrichment('))
    const vercel = src('vercel.json')
    check('W2: no new cron entry (vercel.json mentions neither enrich nor safe-page)', !/enrich|safe/i.test(vercel))
    const script = src('scripts/heal-guides-now.ts')
    check('W3: heal-guides-now has --enrich, still behind --yes, with --dry and --only supported on the same code path', /--enrich/.test(script) && /runSafeEnrichment\(admin, \{ budget: shared, force: true, only/.test(script) && /!dry && !process\.argv\.includes\('--yes'\)\) usage\(\)/.test(script) && /dry: true/.test(script))
    check('W4: the Guide Pages screen shows the safe-pages card, fed by a read-only admin route that checks isAuthorized first', /GuidesEnrichmentCard/.test(src('app/admin/guides/page.tsx')) && /isAuthorized\(request\)[\s\S]*listSafePages/.test(src('app/api/admin/guides/enrichment/route.ts')) && !/\bPOST\b/.test(src('app/api/admin/guides/enrichment/route.ts')))
    const lib = src('lib/safe-enrich.ts')
    check('W5: the enrichment gives the heal loop no safe-page rung and no section-deleting fallback, and always requires the judge', !/safePage:/.test(lib.replace(/\/\/.*$/gm, '')) && !/deleteFallback:/.test(lib.replace(/\/\/.*$/gm, '')) && /requireJudge: true/.test(lib))
    check('W6: the new files contain no long dashes', ['lib/safe-enrich.ts', 'scripts/check-safe-enrich.ts', 'components/admin/guides-enrichment.tsx', 'app/api/admin/guides/enrichment/route.ts'].every((f) => !LONG_DASH.test(src(f))))
    check('W7: Undo of an enrichment puts the safe-page note back (content-edits revert hook)', /isEnrichReason\(edit\.reason\)[\s\S]{0,120}SAFE_PAGE_NOTE/.test(src('lib/content-edits.ts')))
  }

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll safe-enrich checks passed')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
