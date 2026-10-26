// Offline check for "the daily live-page heal HOLDS what the model writes for an already-published page; a person says Yes or No".
// Covers: the queue (cap 20, one open item per page, damaged JSON), the pre-call verdict (open item skips the page, a rejection blocks
// 30 days, a full queue skips the model call), approve (re-reads the live row, applies only when every "before" still matches, logs first
// so Undo works, a changed or unpublished page closes the item as gone), reject (30 day marker), undo of a Yes, the Today card kind, and
// source assertions that lib/content-heal-run.ts no longer writes faq / key takeaways / meta fields from a model result directly.
// In-memory fake database and fake collaborators only: no network, no real database, no AI call.
// Run: pnpm dlx tsx scripts/check-live-additions-review.ts
import { readFileSync } from 'node:fs'

process.env.ANTHROPIC_API_KEY = ''
process.env.INDEXNOW_KEY = ''

import { fakeAdmin, type Db } from './fake-admin'
import {
  LIVE_ADDITIONS_KEY, LIVE_OPEN_CAP, LIVE_REJECT_DAYS, addItem, approveAdditions, describeChanges, enqueueAdditions, openCount, parseQueue, proposeVerdict, readQueue, readRejectStamp,
  rejectAdditions, rejectedRecently, undoApproval, closeGone, additionKey, type AdditionChange, type AdditionItem, type AdditionsDeps,
} from '../lib/live-additions-review'
import { applyLiveAdditions, modelAdditions } from '../lib/content-heal-run'
import { revertEdit } from '../lib/content-edits'
import { withDryRun } from '../lib/dry-run'
import { TODAY_KINDS, TODAY_KIND_IDS, actionFor, needsConfirm, parseCardId } from '../lib/today-cards'
import { cardActionsFor } from '../lib/today-card-actions'
import type { RepairFields } from '../lib/content-repair'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
}
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const POST_ID = '33333333-3333-4333-8333-333333333333'
const faqBefore = [{ q: 'Is it easy?', a: 'Yes, quite easy.' }]
const faqAfter = [...faqBefore, { q: 'Who is it for?', a: 'Anyone who likes an easy pace.' }, { q: 'Do I unpack daily?', a: 'No, once.' }]
const takeAfter = ['Gentle pace', 'Unpack once', 'Good for first timers']
const changes = (): AdditionChange[] => [
  { field: 'faq', before: JSON.stringify(faqBefore), after: JSON.stringify(faqAfter) },
  { field: 'key_takeaways', before: '[]', after: JSON.stringify(takeAfter) },
  { field: 'meta_description', before: '', after: 'A plain guide for first-time river cruisers.' },
]
const postRow = (over: Record<string, unknown> = {}) => ({
  id: POST_ID, slug: 'river-cruise-1', status: 'published', title: 'River cruise for first timers', body: 'A river cruise is a relaxed way to see towns. '.repeat(40),
  meta_title: 'River cruise for first timers', meta_description: '', og_title: '', og_description: '', faq: faqBefore, key_takeaways: [], primary_keyword: 'river cruise first timers', content_style: 'faq-led', ...over,
})
const mkDb = (rows: Record<string, unknown>[] = [postRow()]): Db => ({ tables: { app_settings: [], content_edits: [], posts: rows, guides: [], page_copy: [], travel_packages: [] } })
const now = new Date('2026-10-25T12:00:00Z')
const info = (id = POST_ID) => ({ type: 'post' as const, id, path: '/blog/river-cruise-1', title: 'River cruise for first timers', changes: changes() })
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

async function main() {
  // ---- 1. Pure helpers ----------------------------------------------------------------------------
  {
    check('1 parseQueue: missing or damaged JSON is an empty queue', parseQueue(null).items.length === 0 && parseQueue('{oops').items.length === 0 && parseQueue('{"items":5}').items.length === 0)
    const item = (n: number): AdditionItem => ({ key: additionKey('post', uuid(n)), type: 'post', id: uuid(n), path: '/blog/x', title: 'x', changes: changes(), what: 'w', at: now.toISOString(), status: 'open', editIds: [] })
    let q = parseQueue(null)
    for (let n = 1; n <= LIVE_OPEN_CAP; n++) q = addItem(q, item(n)).queue
    check('1 queue: holds exactly the cap of open items', openCount(q) === LIVE_OPEN_CAP && LIVE_OPEN_CAP === 20)
    const over = addItem(q, item(99))
    check('1 queue: a full queue refuses another page', !over.added && /already waiting/.test(over.reason))
    const dup = addItem(q, item(1))
    check('1 queue: a page with an open item is not added twice', !dup.added && dup.reason === 'already waiting for review')
    check('1 verdict: an open item skips the page', proposeVerdict(q, additionKey('post', uuid(1)), null, now.getTime()).why === 'open')
    check('1 verdict: a full queue skips the model call', proposeVerdict(q, additionKey('post', uuid(500)), null, now.getTime()).why === 'full')
    check('1 verdict: an empty queue allows it', proposeVerdict(parseQueue(null), additionKey('post', uuid(1)), null, now.getTime()).ok)
    const stamp = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString()
    check('1 verdict: a rejection 29 days ago still blocks, 31 days ago does not', !proposeVerdict(parseQueue(null), 'k', stamp(29), now.getTime()).ok && proposeVerdict(parseQueue(null), 'k', stamp(31), now.getTime()).ok && rejectedRecently(stamp(29), now.getTime()) && !rejectedRecently(stamp(31), now.getTime()) && LIVE_REJECT_DAYS === 30)
    const d = describeChanges(changes())
    check('1 describe: one plain sentence and readable before / after text', /FAQ/.test(d.what) && /key takeaways/.test(d.what) && /Q: Who is it for\?/.test(d.after) && /meta description: \(empty\)/.test(d.before) && !/[–—]/.test(d.what + d.before + d.after), JSON.stringify(d))
  }

  // ---- 2. The split: only model-written fields are held --------------------------------------------
  {
    const cheap: RepairFields = { title: 'T', body: 'b', meta_title: 'M', meta_description: '', og_title: 'O', og_description: '', faq: faqBefore, key_takeaways: [] }
    const proposed: RepairFields = { ...cheap, meta_description: 'Plain text.', og_description: 'Plain text.', faq: faqAfter, body: 'CHANGED BODY' }
    const ch = modelAdditions('post', cheap, proposed)
    check('2 split: modelAdditions lists only faq / takeaway / meta / share fields that changed, never the body', ch.map((c) => c.field).join(',') === 'faq,meta_description,og_description' && ch[0].before === JSON.stringify(faqBefore) && ch[0].after === JSON.stringify(faqAfter), JSON.stringify(ch.map((c) => c.field)))
    check('2 split: nothing changed means nothing held', modelAdditions('post', cheap, cheap).length === 0)
  }

  // ---- 3. Queueing --------------------------------------------------------------------------------
  {
    const db = mkDb()
    const admin = fakeAdmin(db)
    const r = await enqueueAdditions(admin, info(), now)
    const q = await readQueue(admin)
    check('3 enqueue: a proposal is stored as one open item in app_settings (no table)', r.queued && q.items.length === 1 && q.items[0].status === 'open' && db.tables.app_settings.some((s) => s.key === LIVE_ADDITIONS_KEY))
    check('3 enqueue: the live page itself is untouched while it waits', JSON.stringify(db.tables.posts[0].faq) === JSON.stringify(faqBefore) && db.tables.posts[0].meta_description === '' && db.tables.content_edits.length === 0)
    const again = await enqueueAdditions(admin, info(), now)
    check('3 enqueue: the same page is not queued twice', !again.queued && (await readQueue(admin)).items.length === 1)
    const dry = mkDb()
    const dr = await withDryRun(() => enqueueAdditions(fakeAdmin(dry), info(), now))
    check('3 enqueue: a dry run writes nothing', !dr.queued && dry.tables.app_settings.length === 0)
    check('3 enqueue: an empty change list queues nothing', !(await enqueueAdditions(fakeAdmin(mkDb()), { ...info(), changes: [] }, now)).queued)
  }

  // ---- 4. Approve with fake collaborators ------------------------------------------------------------
  {
    const db = mkDb()
    const admin = fakeAdmin(db)
    await enqueueAdditions(admin, info(), now)
    const key = additionKey('post', POST_ID)
    let applied = 0
    const ok: Pick<AdditionsDeps, 'apply'> = { apply: async () => ((applied++), { ok: true, editIds: ['e1', 'e2'] }) }
    const r = await approveAdditions(admin, key, ok, now)
    const q = await readQueue(admin)
    check('4 approve: Yes applies once and marks the item approved with its Undo handles', r.ok && applied === 1 && q.items[0].status === 'approved' && q.items[0].editIds.join() === 'e1,e2' && openCount(q) === 0)
    const second = await approveAdditions(admin, key, ok, now)
    check('4 approve: a second tap does nothing', second.ok && second.noop === true && applied === 1)

    const db2 = mkDb()
    const admin2 = fakeAdmin(db2)
    await enqueueAdditions(admin2, info(), now)
    const gone = await approveAdditions(admin2, key, { apply: async () => ({ ok: false, gone: true, reason: 'the page is no longer published' }) }, now)
    const q2 = await readQueue(admin2)
    check('4 approve: a gone page closes the item and says why', gone.ok && gone.noop === true && /no longer published/.test(gone.message) && q2.items[0].status === 'gone' && /no longer published/.test(q2.items[0].note ?? ''))

    const db3 = mkDb()
    const admin3 = fakeAdmin(db3)
    await enqueueAdditions(admin3, info(), now)
    const bad = await approveAdditions(admin3, key, { apply: async () => ({ ok: false, error: 'db down' }) }, now)
    check('4 approve: a failed write keeps the item open and the page unchanged', !bad.ok && (await readQueue(admin3)).items[0].status === 'open' && db3.tables.content_edits.length === 0)
  }

  // ---- 5. Real apply path (log first, Undo works, only when "before" still matches) ----------------------
  {
    const db = mkDb()
    const admin = fakeAdmin(db)
    await enqueueAdditions(admin, info(), now)
    const key = additionKey('post', POST_ID)
    const real: AdditionsDeps = { apply: (i) => applyLiveAdditions(admin, i), revert: async (id) => { const r = await revertEdit(admin, id); return { ok: r.ok, error: r.error, needsForce: r.needsForce } } }
    const r = await approveAdditions(admin, key, real, now)
    const row = db.tables.posts[0]
    check('5 apply: Yes writes the held FAQ, takeaways and meta text to the live page', r.ok && !r.noop && JSON.stringify(row.faq) === JSON.stringify(faqAfter) && JSON.stringify(row.key_takeaways) === JSON.stringify(takeAfter) && row.meta_description === 'A plain guide for first-time river cruisers.', JSON.stringify({ r, row: { faq: row.faq, kt: row.key_takeaways, md: row.meta_description } }))
    const edits = db.tables.content_edits
    check('5 apply: every field has an audit row (log first), method generate, before text kept', edits.length === 3 && edits.every((e) => e.method === 'generate' && e.content_id === POST_ID && e.reverted_at == null) && edits.some((e) => e.field === 'faq' && e.before === JSON.stringify(faqBefore)), JSON.stringify(edits.map((e) => e.field)))
    const q = await readQueue(admin)
    check('5 apply: the item keeps the audit ids', q.items[0].status === 'approved' && q.items[0].editIds.length === 3)
    const undo = await undoApproval(admin, key, real)
    check('5 undo: Undo puts the old text back (revertEdit) and the proposal waits for review again', undo.ok && JSON.stringify(db.tables.posts[0].faq) === JSON.stringify(faqBefore) && db.tables.posts[0].meta_description === '' && (await readQueue(admin)).items[0].status === 'open', JSON.stringify({ undo, faq: db.tables.posts[0].faq }))
  }
  {
    // the page changed meanwhile: nothing is written
    const db = mkDb([postRow({ faq: [{ q: 'A person wrote this', a: 'Yes.' }] })])
    const admin = fakeAdmin(db)
    await enqueueAdditions(admin, info(), now)
    const key = additionKey('post', POST_ID)
    const r = await approveAdditions(admin, key, { apply: (i) => applyLiveAdditions(admin, i) }, now)
    const q = await readQueue(admin)
    check('5 apply: if a target field changed since, nothing is written and the item is gone with the reason', r.ok && r.noop === true && /changed since/.test(r.message) && q.items[0].status === 'gone' && db.tables.content_edits.length === 0 && db.tables.posts[0].meta_description === '', JSON.stringify(r))
  }
  {
    const db = mkDb([postRow({ status: 'draft' })])
    const admin = fakeAdmin(db)
    await enqueueAdditions(admin, info(), now)
    const r = await applyLiveAdditions(admin, (await readQueue(admin)).items[0])
    check('5 apply: an unpublished page is never written', !r.ok && 'gone' in r && r.gone === true && db.tables.content_edits.length === 0 && db.tables.posts[0].meta_description === '')
    const missing = await applyLiveAdditions(fakeAdmin(mkDb([])), info() as unknown as AdditionItem & { changes: AdditionChange[] })
    check('5 apply: a deleted page is reported gone', !missing.ok && 'gone' in missing && missing.gone === true)
  }
  {
    const db = mkDb()
    const admin = fakeAdmin(db)
    await enqueueAdditions(admin, info(), now)
    db.failWrites = { content_edits: 'audit table down' }
    const r = await applyLiveAdditions(admin, (await readQueue(admin)).items[0])
    check('5 apply: no audit row, no edit (the page is not written if the log fails)', !r.ok && !('gone' in r && r.gone) && JSON.stringify(db.tables.posts[0].faq) === JSON.stringify(faqBefore) && db.tables.posts[0].meta_description === '')
  }

  // ---- 6. Reject: 30 day marker --------------------------------------------------------------------
  {
    const db = mkDb()
    const admin = fakeAdmin(db)
    await enqueueAdditions(admin, info(), now)
    const key = additionKey('post', POST_ID)
    const r = await rejectAdditions(admin, key, now)
    const q = await readQueue(admin)
    check('6 reject: No discards the proposal, the page is untouched, the item leaves the open list', r.ok && q.items[0].status === 'rejected' && openCount(q) === 0 && db.tables.content_edits.length === 0 && db.tables.posts[0].meta_description === '')
    const stamp = await readRejectStamp(admin, key)
    check('6 reject: the 30 day no-repeat marker is stored and blocks a new proposal', !!stamp && !proposeVerdict(q, key, stamp, now.getTime() + 29 * 86_400_000).ok && proposeVerdict(q, key, stamp, now.getTime() + 31 * 86_400_000).ok)
    const again = await rejectAdditions(admin, key, now)
    check('6 reject: a second tap does nothing', again.ok && again.noop === true)
    await closeGone(admin, [key], 'x', now)
    check('6 closeGone: only open items are closed', (await readQueue(admin)).items[0].status === 'rejected')
  }

  // ---- 7. Wiring -----------------------------------------------------------------------------------
  {
    const def = TODAY_KINDS['live-additions']
    check('7 card: the live-additions kind is registered with a yes (undoable) and a no (confirm tap)', TODAY_KIND_IDS.includes('live-additions') && !!def && def.primary.label === 'Add it to the live page' && def.secondary?.label === 'Not now' && def.undo.primary === true && def.undo.secondary === false && !needsConfirm('live-additions', 'approve') && needsConfirm('live-additions', 'reject') && actionFor('live-additions', 'approve')?.mode === 'run')
    check('7 card: facts are What / Before / After / Written and the id shape is a post, guide or copy key', def.facts.join('|') === 'What|Before|After|Written' && !!parseCardId(`live-additions:${additionKey('post', POST_ID)}`) && !parseCardId('live-additions:nope'))
    check('7 card: it has a plain files / pages entry for Copy to Claude', cardActionsFor('live-additions') !== undefined && /live-additions-review/.test(src('lib/today-card-actions.ts')))
    const actions = src('lib/today-actions.ts')
    check('7 card: today-actions runs and undoes it (run, undo cases) through the approve / reject / undo functions', (actions.match(/case 'live-additions'/g) ?? []).length === 2 && /approveAdditions/.test(actions) && /rejectAdditions/.test(actions) && /undoAdditions/.test(actions) && /applyLiveAdditions/.test(actions) && /revertEdit/.test(actions))
    const queue = src('lib/today-queue.ts')
    check('7 card: the Today queue lists open items and closes items whose page is no longer published', /liveAdditionCards\(admin\)/.test(queue) && /closeGoneAdditions/.test(queue) && /status === 'published'/.test(queue))
    check('7 text: no long dash in the new card text or store', !/[–—]/.test(JSON.stringify(def) + src('lib/live-additions-review.ts')))
  }

  // ---- 8. The heal no longer writes model output straight to a published page --------------------------
  {
    const run = src('lib/content-heal-run.ts')
    const start = run.indexOf('for (const s of queue) {')
    const end = run.indexOf('// 2b. Trip pages')
    const loop = run.slice(start, end)
    check('8 heal: the main loop was found', start > 0 && end > start && loop.length > 500)
    check('8 heal: the model result is built on a separate copy, never assigned back to the applied fields', !/\bfields = next\b/.test(loop) && /let proposedFields = next/.test(loop) && /modelAdditions\(item\.type, fields, proposedFields\)/.test(loop))
    check('8 heal: the model fields are no longer logged as an edit of the live page by the loop', !/touch\(k, 'generate'/.test(loop) && !/'generate'/.test(loop))
    check('8 heal: the model result is queued (held), after the cheap fixes were applied', /enqueueAdditions\(admin/.test(loop) && loop.indexOf('insertEdits(admin, edits)') < loop.indexOf('enqueueAdditions(admin'))
    check('8 heal: the model call is skipped for a page with an open item, a recent rejection, or when the queue is full', /status === 'open'\) continue/.test(loop) && /proposeVerdict\(additions, addKey/.test(loop) && /readRejectStamp/.test(loop))
    check('8 heal: log-first, reverted fields, NOGEN, daily-once and spend counters are still there', /insertEdits\(admin, edits\)/.test(loop) && loop.indexOf('insertEdits(admin, edits)') < loop.indexOf('.update({ ...columnsFrom') && /restoreField/.test(loop) && /NOGEN_PREFIX/.test(loop) && /claimDailyOnce/.test(loop) && /recordRepairSpend\(admin, 1\)/.test(loop) && /claimRepairSlot/.test(loop))
    check('8 heal: the run summary says how many additions wait for review', /AI addition/.test(run) && /additionsWaiting/.test(run))
    check('8 apply: the approved path logs first then updates, only a published row', /export async function applyLiveAdditions/.test(run) && /row\.status !== 'published'/.test(run) && run.indexOf('const logged = await insertEdits(admin, edits)', run.indexOf('applyLiveAdditions')) < run.indexOf('.update({ ...columnsFrom(item, next)'))
    check('8 scope: trip pages are unchanged (healTripPages still applies its own fixes)', /async function healTripPages/.test(run) && !/enqueueAdditions/.test(run.slice(run.indexOf('async function healTripPages'), run.indexOf('async function healTripPages') + 6000)))
  }

  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) FAILED.`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
