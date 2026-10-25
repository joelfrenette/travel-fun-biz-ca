import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting } from '@/lib/app-settings'
import { collectIssues, type Issue } from '@/lib/issues'
import { cardsFromIssues } from '@/lib/today-issues'
import { cardId, TODAY_KINDS, type TodayCard, type TodayFact, type TodayKindId } from '@/lib/today-cards'
import {
  TODAY_LEADS_DONE_KEY, TODAY_LOG_KEY, TODAY_SNOOZE_KEY,
  lastOpenEntry, orderCards, parseIdList, parseLog, parseSnoozed, plain, visibleCards, type LogEntry,
} from '@/lib/today-state'
import { listTopicQueue } from '@/lib/blog-topics'
import { listUnassignedHot } from '@/lib/lead-desk-store'
import { whatTheyAsked } from '@/lib/lead-desk'
import { CAPTION_FAILED_PREFIX } from '@/lib/guide-release'
import { guidePublishBlock } from '@/lib/posts-menu-2'
import { isNewsSlug } from '@/lib/news-post'
import { countBelowBar } from '@/lib/blog-quality-count'
import type { PackageGrounding } from '@/lib/blog-topics'
import { canPromote, type PromotionPackage } from '@/lib/promotion'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { isAutopilotOn } from '@/lib/autopilot'
import { readCronRuns } from '@/lib/cron-heartbeat'
import { judgeAllCrons, judgeCron } from '@/lib/cron-health'
import { startOfSiteDayIso } from '@/lib/content-edits'
import { readSeoFixCandidates, SEO_FIX_MAX } from '@/lib/seo-playbook-todo'
import { closeGone as closeGoneReviews, openItems as openReviewItems, readQueue as readReviewQueue } from '@/lib/ai-heal-review'

// Builds the Today queue: every human decision, as cards, most urgent first. Each source is read on its own inside a
// try/catch, so a source that cannot be read (a table that is not there yet) is reported in `problems` and never
// empties the queue or takes the page down.

const PER_KIND = 15
const TZ = 'America/Toronto'
const DAY_MS = 86_400_000

type Row = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const ms = (v: unknown) => {
  const t = Date.parse(str(v))
  return Number.isFinite(t) ? t : 0
}
const when = (v: unknown) => (ms(v) ? new Date(ms(v)).toLocaleString('en-CA', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }) : '')
const day = (v: unknown) => (ms(v) ? new Date(ms(v)).toLocaleDateString('en-CA', { timeZone: TZ, dateStyle: 'medium' }) : '')
const fact = (label: string, value: unknown): TodayFact | null => {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? plain(value) : ''
  return text ? { label, value: text.length > 400 ? `${text.slice(0, 397)}...` : text } : null
}
const facts = (...list: (TodayFact | null)[]): TodayFact[] => list.filter((f): f is TodayFact => !!f)

function card(kind: TodayKindId, key: string, title: string, f: TodayFact[], sortKey: number, extra: { why?: string; link?: TodayCard['link'] } = {}): TodayCard {
  return { id: cardId(kind, key), kind, title: plain(title).slice(0, 200), why: extra.why ?? TODAY_KINDS[kind].why, facts: f, ...(extra.link ? { link: extra.link } : {}), sortKey }
}

// ---------------------------------------------------------------------------------------------------
// Loaders, one per source. Each returns cards and may throw; buildTodayCards catches.
// ---------------------------------------------------------------------------------------------------

async function heldPostCards(admin: SupabaseClient): Promise<TodayCard[]> {
  const { data, error } = await admin.from('post_distribution').select('slug, title, last_error, created_at').eq('content_type', 'post').eq('stage', 'held').order('created_at', { ascending: true }).limit(60)
  if (error) throw new Error(error.message)
  const out: TodayCard[] = []
  for (const r of (data ?? []) as Row[]) {
    const slug = str(r.slug)
    const note = str(r.last_error)
    const kind: TodayKindId = note.startsWith(CAPTION_FAILED_PREFIX) ? 'guide-caption-held' : slug.startsWith('guide-') ? 'held-guide-post' : 'held-post'
    const label = kind === 'guide-caption-held' ? 'What the check said' : 'Note'
    out.push(card(kind, slug, str(r.title) || slug, facts(fact('Held since', when(r.created_at)), fact(label, note)), ms(r.created_at), { link: { label: 'Open Post Distribution', href: '/admin/distribution' } }))
  }
  return out
}

async function newsDraftCards(admin: SupabaseClient): Promise<TodayCard[]> {
  const { data, error } = await admin.from('news_items').select('source_key, post_slug, fetched_at').eq('status', 'queued').not('post_slug', 'is', null).order('fetched_at', { ascending: true }).limit(40)
  if (error) throw new Error(error.message)
  const items = (data ?? []) as Row[]
  const slugs = items.map((i) => str(i.post_slug)).filter(Boolean)
  if (!slugs.length) return []
  const { data: posts, error: pErr } = await admin.from('posts').select('slug, title, status').in('slug', slugs)
  if (pErr) throw new Error(pErr.message)
  const draft = new Map(((posts ?? []) as Row[]).filter((p) => p.status === 'draft').map((p) => [str(p.slug), str(p.title)]))
  const out: TodayCard[] = []
  for (const i of items) {
    const slug = str(i.post_slug)
    if (!draft.has(slug)) continue
    out.push(card('news-draft', slug, draft.get(slug) || slug, facts(fact('Source', str(i.source_key).replace(/[-_]/g, ' ')), fact('Written', when(i.fetched_at))), ms(i.fetched_at), { link: { label: 'Read the draft', href: '/admin/news' } }))
  }
  return out
}

async function topicCards(admin: SupabaseClient): Promise<TodayCard[]> {
  const rows = (await listTopicQueue(admin)).filter((r) => r.status === 'suggested')
  return rows
    .slice(0, 40)
    .map((r) => card('topic', r.id, r.title_idea || r.angle, facts(fact('Search phrase', r.keyword), fact('Why this one', r.why), fact('Where the idea came from', r.source)), ms(r.created_at), { link: { label: 'Open the topic queue', href: '/admin/blog?tab=autoblog' } }))
}

async function guideReviewCards(admin: SupabaseClient): Promise<TodayCard[]> {
  let res = await admin.from('guides').select('id, kind, name, quality_notes, source, status, review_state, updated_at').eq('status', 'draft').eq('source', 'ai').order('updated_at', { ascending: true }).limit(60)
  // Before migration 0041 there is no review_state column: every AI draft counts as waiting.
  if (res.error && /review_state|column|schema cache/i.test(res.error.message)) res = (await admin.from('guides').select('id, kind, name, quality_notes, source, status, updated_at').eq('status', 'draft').eq('source', 'ai').order('updated_at', { ascending: true }).limit(60)) as typeof res
  if (res.error) throw new Error(res.error.message)
  const out: TodayCard[] = []
  for (const g of (res.data ?? []) as unknown as Row[]) {
    if (g.review_state === 'rejected') continue
    const blocked = guidePublishBlock({ status: 'draft', quality_notes: str(g.quality_notes) })
    out.push(
      card('guide-review', str(g.id), str(g.name) || 'Guide page', facts(fact('Kind of page', str(g.kind).replace(/-/g, ' ')), fact('Quality notes', str(g.quality_notes) || 'None'), fact('Written', when(g.updated_at)), blocked ? fact('Cannot publish here', blocked) : null), blocked ? 1e15 + ms(g.updated_at) : ms(g.updated_at), { link: { label: 'Read it first', href: `/admin/guides/${str(g.id)}` } }),
    )
  }
  return out
}

const REVIEW_TABLE = { post: 'posts', guide: 'guides', page_copy: 'page_copy' } as const

/** Held drafts the scheduled AI auto-heal improved but did NOT publish (lib/ai-heal-review.ts). A person publishes or keeps them held.
 * An item whose draft was published, deleted or already reverted elsewhere is closed and drops out (so it never clogs the 20-item cap). */
async function healReviewCards(admin: SupabaseClient): Promise<TodayCard[]> {
  const queue = await readReviewQueue(admin)
  const open = openReviewItems(queue)
  if (open.length === 0) return []
  const gone: string[] = []
  const live = new Set<string>()
  for (const type of ['post', 'guide', 'page_copy'] as const) {
    const ids = open.filter((i) => i.type === type).map((i) => i.id)
    if (!ids.length) continue
    const { data, error } = await admin.from(REVIEW_TABLE[type]).select('id, status').in('id', ids)
    if (error) throw new Error(error.message)
    for (const r of (data ?? []) as Row[]) if (r.status === 'draft') live.add(`${type}:${str(r.id)}`)
  }
  const allEditIds = open.flatMap((i) => i.editIds)
  const reverted = new Set<string>()
  if (allEditIds.length) {
    const { data } = await admin.from('content_edits').select('id, reverted_at').in('id', allEditIds)
    for (const r of (data ?? []) as Row[]) if (r.reverted_at) reverted.add(str(r.id))
  }
  const out: TodayCard[] = []
  for (const i of open) {
    const allReverted = i.editIds.length > 0 && i.editIds.every((e) => reverted.has(e))
    if (!live.has(`${i.type}:${i.id}`) || allReverted) {
      gone.push(i.key)
      continue
    }
    const href = i.type === 'post' ? `/admin/blog/${i.id}` : i.type === 'guide' ? `/admin/guides/${i.id}` : '/admin/content-edits'
    out.push(
      card('heal-review', i.key, `Improved: ${i.title}`, facts(fact('What changed', i.summary.what), fact('Before', i.summary.before), fact('After', i.summary.after), fact('Improved', when(i.at)), fact('The last publish check said', i.refusal)), ms(i.at), { link: { label: 'Read it first', href } }),
    )
  }
  if (gone.length) await closeGoneReviews(admin, gone).catch(() => undefined)
  return out
}

async function blogDraftCards(admin: SupabaseClient): Promise<TodayCard[]> {
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString()
  const { data, error } = await admin.from('posts').select('*').eq('status', 'draft').gte('created_at', since).order('created_at', { ascending: true }).limit(30)
  if (error) throw new Error(error.message)
  const drafts = ((data ?? []) as Row[]).filter((r) => !isNewsSlug(str(r.slug))).slice(0, PER_KIND)
  if (!drafts.length) return []
  let packages: PackageGrounding[] = []
  try {
    const pk = await admin.from('travel_packages').select('name, slug, destination, short_description, full_description, highlights, available_from, available_to').eq('status', 'published').limit(300)
    packages = (pk.data ?? []) as PackageGrounding[]
  } catch {
    packages = []
  }
  return drafts.map((r) => {
    let verdict = 'Could not be checked'
    try {
      verdict = countBelowBar([r], packages).count > 0 ? 'Below the quality bar. Open it to see what to fix.' : 'Passes the quality checks'
    } catch {
      verdict = 'Could not be checked'
    }
    return card('blog-draft', str(r.id), str(r.title) || str(r.slug), facts(fact('Search phrase', str(r.primary_keyword)), fact('Written', when(r.created_at)), fact('Quality check', verdict)), ms(r.created_at), { link: { label: 'Read the draft', href: `/admin/blog/${str(r.id)}` } })
  })
}

async function leadCards(admin: SupabaseClient): Promise<TodayCard[]> {
  const since = new Date(Date.now() - 3 * DAY_MS).toISOString()
  const { data, error } = await admin.from('leads').select('id, name, email, phone, package, forwarded_to_ghl, created_at').eq('is_test', false).gte('created_at', since).order('created_at', { ascending: false }).limit(40)
  if (error) throw new Error(error.message)
  const done = new Set(parseIdList(await getSetting(admin, TODAY_LEADS_DONE_KEY).catch(() => null)))
  const out: TodayCard[] = []
  for (const l of (data ?? []) as Row[]) {
    const id = str(l.id)
    if (!id || done.has(id)) continue
    const sent = l.forwarded_to_ghl === true
    out.push(card('lead-reply', id, `New lead: ${str(l.name) || 'no name given'}`, facts(fact('Email', str(l.email)), fact('Phone', str(l.phone)), fact('Interested in', str(l.package)), fact('Came in', when(l.created_at)), fact('Sent to GoHighLevel', sent ? 'Yes' : 'No, it is only saved here')), (sent ? 0 : -1e13) - ms(l.created_at), { link: { label: 'Open Leads', href: '/admin/leads' } }))
  }
  return out
}

/** Hot leads still waiting for an agent, oldest first. They stay until a person assigns one (Later only hides a card for 30 minutes). */
async function hotLeadCards(admin: SupabaseClient): Promise<TodayCard[]> {
  const rows = await listUnassignedHot(admin)
  return rows.map((r) => {
    const trip = r.package || r.page_path || ''
    const asked = whatTheyAsked({ intent: r.intent, message: r.message })
    const base = card('hot-lead', r.id, `Hot lead: ${r.name || 'no name given'}`, facts(
      fact('Who', r.name),
      fact('Trip or page', trip),
      fact('Came from', r.utm_source || 'not recorded'),
      fact('What they asked', asked),
      // Phone, email and the live waiting time are shown by the card's own panel (components/admin/hot-lead-panel.tsx), from card.hot.
    ), ms(r.created_at), { link: { label: 'Open Leads', href: '/admin/leads' } })
    return { ...base, hot: { leadId: r.id, createdAt: r.created_at, name: plain(r.name || ''), email: r.email, phone: r.phone, package: r.package, pagePath: r.page_path, source: r.utm_source, asked } }
  })
}

async function promoteCards(admin: SupabaseClient): Promise<TodayCard[]> {
  const base = 'id, slug, name, destination, category, short_description, highlights, keywords, itinerary, available_from, available_to, status'
  let res = await admin.from('travel_packages').select(`${base}, recap_mode`).eq('status', 'published').limit(80)
  if (res.error && /recap_mode|column|schema cache/i.test(res.error.message)) res = (await admin.from('travel_packages').select(base).eq('status', 'published').limit(80)) as typeof res
  if (res.error) throw new Error(res.error.message)
  const last = new Map<string, string>()
  const promos = await admin.from('package_promotions').select('package_id, started_at').order('started_at', { ascending: false }).limit(300)
  if (promos.error) return [] // before migration 0039 there is nothing to compare with, so no prompt
  for (const p of (promos.data ?? []) as Row[]) if (!last.has(str(p.package_id))) last.set(str(p.package_id), str(p.started_at))
  const now = new Date()
  const out: TodayCard[] = []
  for (const p of (res.data ?? []) as unknown as (PromotionPackage & Row)[]) {
    const seen = last.get(p.id) ?? null
    if (!canPromote(p, seen, now).ok) continue
    out.push(card('promote-prompt', p.id, `Promote ${p.name}`, facts(fact('Trip', p.name), fact('Travels', p.available_from ? `${day(p.available_from)}${p.available_to ? ` to ${day(p.available_to)}` : ''}` : 'Dates not set'), fact('Last promoted', seen ? day(seen) : 'Never')), p.available_from ? ms(p.available_from) : 9e15, { link: { label: 'Open the trip', href: `/admin/packages?edit=${p.id}` } }))
  }
  return out.sort((a, b) => a.sortKey - b.sortKey).slice(0, 2)
}

/** The few biggest SEO fixes still open (failing, high impact) from the SEO playbook audit. "Do it" opens the fix page; Later hides it for 7 days. */
async function seoFixCards(admin: SupabaseClient): Promise<TodayCard[]> {
  const fixes = await readSeoFixCandidates(admin, SEO_FIX_MAX)
  return fixes.map((c) =>
    card('seo-fix', c.id, c.title, facts(fact('What to do', c.hint), fact('Why it matters', c.why)), -c.impact * 10 + c.effort, { link: { label: 'Open the fix', href: c.href } }),
  )
}

// ---------------------------------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------------------------------

export interface LastAction {
  n: number
  id: string
  title: string
  op: LogEntry['op']
  mode: LogEntry['mode']
  at: string
  undoable: boolean
}

export interface TodayQueue {
  /** Cards to decide now: snoozed ones are not here. Most urgent first. */
  cards: TodayCard[]
  total: number
  snoozedCount: number
  lastAction: LastAction | null
  issues: Issue[]
  /** Sources that could not be read (plain words), so a missing table is visible instead of silently empty. */
  problems: string[]
}

export async function readLog(admin: SupabaseClient): Promise<LogEntry[]> {
  return parseLog(await getSetting(admin, TODAY_LOG_KEY).catch(() => null))
}

export function lastActionOf(log: LogEntry[]): LastAction | null {
  const e = lastOpenEntry(log)
  return e ? { n: e.n, id: e.id, title: e.title, op: e.op, mode: e.mode, at: e.at, undoable: e.undoable } : null
}

export async function buildTodayQueue(admin: SupabaseClient, now: number = Date.now()): Promise<TodayQueue> {
  const problems: string[] = []
  let issues: Issue[] = []
  const all: TodayCard[] = []

  const sources: [string, () => Promise<TodayCard[]>][] = [
    ['Needs attention', async () => {
      issues = await collectIssues(admin)
      return cardsFromIssues(issues)
    }],
    ['Held social posts', () => heldPostCards(admin)],
    ['News drafts', () => newsDraftCards(admin)],
    ['Blog topics', () => topicCards(admin)],
    ['Guide review queue', () => guideReviewCards(admin)],
    ['Auto-heal improvements to review', () => healReviewCards(admin)],
    ['Blog drafts', () => blogDraftCards(admin)],
    ['Leads', () => leadCards(admin)],
    ['Hot leads', () => hotLeadCards(admin)],
    ['Trips to promote', () => promoteCards(admin)],
    ['SEO fixes', () => seoFixCards(admin)],
  ]
  const results = await Promise.all(sources.map(async ([name, run]) => {
    try {
      return await run()
    } catch (e) {
      problems.push(`${name} could not be read (${e instanceof Error ? e.message : 'unknown error'}).`)
      return [] as TodayCard[]
    }
  }))
  for (const list of results) all.push(...list)
  // A hot lead has its own card (with the agent picker), so the plain "new lead" card for the same lead is left out.
  const hotIds = new Set(all.filter((c) => c.kind === 'hot-lead').map((c) => c.id.slice('hot-lead:'.length)))
  if (hotIds.size > 0) for (let i = all.length - 1; i >= 0; i--) if (all[i].kind === 'lead-reply' && hotIds.has(all[i].id.slice('lead-reply:'.length))) all.splice(i, 1)

  // A draft the auto-heal improved has its own review card, so the plain draft cards for the same row are left out.
  const reviewKeys = new Set(all.filter((c) => c.kind === 'heal-review').map((c) => c.id.slice('heal-review:'.length)))
  if (reviewKeys.size > 0) {
    for (let i = all.length - 1; i >= 0; i--) {
      const c = all[i]
      if ((c.kind === 'blog-draft' && reviewKeys.has(`post-${c.id.slice('blog-draft:'.length)}`)) || (c.kind === 'guide-review' && reviewKeys.has(`guide-${c.id.slice('guide-review:'.length)}`))) all.splice(i, 1)
    }
  }

  // Never more than PER_KIND of one kind, and never the same id twice.
  const seen = new Set<string>()
  const counts = new Map<TodayKindId, number>()
  const capped: TodayCard[] = []
  for (const c of orderCards(all)) {
    if (seen.has(c.id)) continue
    const n = counts.get(c.kind) ?? 0
    if (n >= PER_KIND) continue
    counts.set(c.kind, n + 1)
    seen.add(c.id)
    capped.push(c)
  }

  const snoozed = parseSnoozed(await getSetting(admin, TODAY_SNOOZE_KEY).catch(() => null), now)
  const visible = visibleCards(capped, snoozed, now)
  const log = await readLog(admin)
  return { cards: visible, total: capped.length, snoozedCount: capped.length - visible.length, lastAction: lastActionOf(log), issues, problems }
}

// ---------------------------------------------------------------------------------------------------
// The System check strip and today's wins
// ---------------------------------------------------------------------------------------------------

export type CheckLight = 'green' | 'amber' | 'red'
export interface SystemCheckItem {
  key: 'automation' | 'heartbeat' | 'errors' | 'failed-posts' | 'watchdog'
  label: string
  light: CheckLight
  detail: string
}
export interface SystemCheck {
  overall: CheckLight
  items: SystemCheckItem[]
  link: { label: string; href: string }
}

const worst = (lights: CheckLight[]): CheckLight => (lights.includes('red') ? 'red' : lights.includes('amber') ? 'amber' : 'green')

/** Pure: the strip from facts the caller already read. */
export function buildSystemCheck(input: { paused: boolean; autopilotOn: boolean; heartbeat: ReturnType<typeof judgeCron>; errorCount: number; failedPostsToday: number | null; amberCrons: number; cronsReadable: boolean }): SystemCheck {
  const items: SystemCheckItem[] = [
    input.paused
      ? { key: 'automation', label: 'Automation', light: 'amber', detail: 'Paused. Nothing runs until you switch it back on.' }
      : input.autopilotOn
        ? { key: 'automation', label: 'Automation', light: 'green', detail: 'On' }
        : { key: 'automation', label: 'Automation', light: 'amber', detail: 'Autopilot is off' },
    { key: 'heartbeat', label: 'Autopilot heartbeat', light: input.heartbeat.light === 'green' ? 'green' : input.heartbeat.light === 'amber' ? 'red' : 'amber', detail: input.heartbeat.label },
    { key: 'errors', label: 'Errors', light: input.errorCount > 0 ? 'red' : 'green', detail: input.errorCount > 0 ? `${input.errorCount} on Needs attention` : 'None' },
    input.failedPostsToday === null
      ? { key: 'failed-posts', label: 'Failed posts today', light: 'amber', detail: 'Could not be read' }
      : { key: 'failed-posts', label: 'Failed posts today', light: input.failedPostsToday > 0 ? 'red' : 'green', detail: input.failedPostsToday > 0 ? String(input.failedPostsToday) : 'None' },
    input.cronsReadable
      ? { key: 'watchdog', label: 'Scheduled jobs', light: input.amberCrons > 0 ? 'amber' : 'green', detail: input.amberCrons > 0 ? `${input.amberCrons} gone quiet or reporting a problem` : 'All running' }
      : { key: 'watchdog', label: 'Scheduled jobs', light: 'amber', detail: 'Could not be read' },
  ]
  return { overall: worst(items.map((i) => i.light)), items, link: { label: 'Open System Health', href: '/admin/system-health' } }
}

export async function readSystemCheck(admin: SupabaseClient, issues: Issue[]): Promise<SystemCheck> {
  const [paused, autopilotOn, runs] = await Promise.all([
    isAutomationPaused(admin).catch(() => false),
    isAutopilotOn(admin).catch(() => false),
    readCronRuns(admin).then((r) => ({ ok: true as const, r })).catch(() => ({ ok: false as const, r: {} as Awaited<ReturnType<typeof readCronRuns>> })),
  ])
  let failedPostsToday: number | null = null
  try {
    const res = await admin.from('post_distribution').select('slug', { count: 'exact', head: true }).eq('stage', 'failed').gte('updated_at', startOfSiteDayIso())
    failedPostsToday = res.error ? null : res.count ?? 0
  } catch {
    failedPostsToday = null
  }
  const nowMs = Date.now()
  return buildSystemCheck({
    paused,
    autopilotOn,
    heartbeat: judgeCron('autopilot', runs.r.autopilot, nowMs),
    // "Errors" counts real problems; the setup and information items stay out of it.
    errorCount: issues.filter((i) => i.area !== 'setup').length,
    failedPostsToday,
    amberCrons: judgeAllCrons(runs.r, nowMs).filter((c) => c.light === 'amber').length,
    cronsReadable: runs.ok,
  })
}

export interface TodayWins {
  postsPublished: number | null
  socialSent: number | null
  guidesWritten: number | null
  leads: number | null
}

export async function readWins(admin: SupabaseClient): Promise<TodayWins> {
  const since = startOfSiteDayIso()
  const count = async (table: string, build: (q: ReturnType<SupabaseClient['from']>) => unknown): Promise<number | null> => {
    try {
      const res = (await build(admin.from(table))) as { count: number | null; error: unknown }
      return res.error ? null : res.count ?? 0
    } catch {
      return null
    }
  }
  const [postsPublished, socialSent, guidesWritten, leads] = await Promise.all([
    count('posts', (q) => q.select('id', { count: 'exact', head: true }).eq('status', 'published').gte('updated_at', since)),
    count('post_distribution', (q) => q.select('slug', { count: 'exact', head: true }).eq('stage', 'done').gte('updated_at', since)),
    count('guides', (q) => q.select('id', { count: 'exact', head: true }).gte('created_at', since)),
    count('leads', (q) => q.select('id', { count: 'exact', head: true }).eq('is_test', false).gte('created_at', since)),
  ])
  return { postsPublished, socialSent, guidesWritten, leads }
}

