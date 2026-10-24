// The second row of buttons under a Today card: which conditional buttons a card kind gets, what Auto-heal may do for it, and
// what "Copy for Claude" points at. Plus the small PURE state for the session-only parts (Previous and Skip) and for the
// per-day Auto-heal cache. Safe to import from the browser: no server code, no database, no clock (the date comes in).
//
// This file defines NO card kinds (lib/today-cards.ts owns those). A kind with no entry below, such as one added later by
// another builder, gets DEFAULT_CARD_ACTIONS: Previous, Later, Skip and Copy for Claude, and no Auto-heal.

import { TODAY_KIND_IDS, isKindId, type TodayCard, type TodayKindId } from '@/lib/today-cards'

/** Which existing capped repair an Auto-heal press runs. The server maps each id to its function in lib/today-heal.ts. */
export type HealId = 'retry-failed-post' | 'retry-failed-render' | 'heal-guide-draft' | 'recheck-seo-item'

export interface CopyPromptFields {
  /** Repo-relative files Claude should start from. Every one must exist (scripts/check-today-actions.ts checks). */
  files: string[]
  /** Admin or site pages worth looking at. */
  pages: string[]
}

export interface CardActionDef {
  canAutoHeal: boolean
  healFn: HealId | null
  copyPromptFields: CopyPromptFields
}

export const DEFAULT_CARD_ACTIONS: CardActionDef = {
  canAutoHeal: false,
  healFn: null,
  copyPromptFields: { files: ['lib/today-queue.ts', 'lib/today-actions.ts', 'components/admin/today-stack.tsx'], pages: ['/admin'] },
}

const heal = (healFn: HealId, copyPromptFields: CopyPromptFields): CardActionDef => ({ canAutoHeal: true, healFn, copyPromptFields })
const plainDef = (copyPromptFields: CopyPromptFields): CardActionDef => ({ canAutoHeal: false, healFn: null, copyPromptFields })

const POSTING = ['lib/distribution.ts', 'lib/auto-policies.ts', 'lib/today-actions.ts']

/** One entry per existing kind. Kinds missing from here fall back to DEFAULT_CARD_ACTIONS. */
export const CARD_ACTIONS: Partial<Record<TodayKindId, CardActionDef>> = {
  'failed-post': heal('retry-failed-post', { files: [...POSTING, 'app/admin/distribution/page.tsx'], pages: ['/admin/distribution'] }),
  'failed-render': heal('retry-failed-render', { files: ['lib/auto-policies.ts', 'lib/today-actions.ts', 'lib/pipeline.ts'], pages: ['/admin/blog'] }),
  'video-paused': plainDef({ files: ['lib/autopilot.ts', 'lib/today-actions.ts'], pages: ['/admin/autopilot'] }),
  'lead-reply': plainDef({ files: ['lib/leads.ts', 'app/api/admin/leads/route.ts'], pages: ['/admin/leads'] }),
  'agent-submission': plainDef({ files: ['lib/agent-submissions.ts', 'app/api/admin/packages/[id]/submission/route.ts'], pages: ['/admin/packages'] }),
  'news-draft': plainDef({ files: ['app/api/admin/news/feeds/route.ts', 'lib/auto-policies.ts'], pages: ['/admin/news'] }),
  'held-guide-post': plainDef({ files: [...POSTING], pages: ['/admin/distribution'] }),
  'guide-caption-held': plainDef({ files: [...POSTING], pages: ['/admin/distribution'] }),
  'held-post': plainDef({ files: [...POSTING], pages: ['/admin/distribution'] }),
  topic: plainDef({ files: ['lib/blog-topics.ts', 'lib/autoblog-run.ts'], pages: ['/admin/blog'] }),
  'guide-review': heal('heal-guide-draft', { files: ['lib/heal-drafts.ts', 'lib/guide-run.ts', 'app/api/admin/guides/[id]/route.ts'], pages: ['/admin/guides'] }),
  'blog-draft': plainDef({ files: ['lib/blog-reheal.ts', 'lib/blog-quality.ts', 'app/api/admin/blog/[id]/route.ts'], pages: ['/admin/blog'] }),
  'supplier-change': plainDef({ files: ['lib/source-watch.ts', 'lib/today-actions.ts'], pages: ['/admin/packages'] }),
  'issue-dismiss': plainDef({ files: ['lib/issues.ts', 'lib/today-issues.ts'], pages: ['/admin'] }),
  'promote-prompt': plainDef({ files: ['app/api/admin/packages/[id]/promote/route.ts'], pages: ['/admin/packages'] }),
  'recap-prompt': plainDef({ files: ['app/api/admin/packages/[id]/recap/route.ts'], pages: ['/admin/packages'] }),
  'thin-page': plainDef({ files: ['app/api/admin/packages/[id]/sources/route.ts'], pages: ['/admin/packages'] }),
  'affiliate-setup': plainDef({ files: ['app/api/admin/affiliate-partners/route.ts'], pages: ['/admin/affiliate-links'] }),
  'seo-fix': heal('recheck-seo-item', { files: ['lib/seo-playbook-view.ts', 'lib/seo-playbook-todo.ts', 'lib/site-crawl.ts'], pages: ['/admin/seo-manager'] }),
}

/** The entry for a kind (or the safe default for one this file has never heard of). Accepts any string, so a new kind never throws. */
export function cardActionsFor(kind: string): CardActionDef {
  return (isKindId(kind) ? CARD_ACTIONS[kind] : undefined) ?? DEFAULT_CARD_ACTIONS
}

/** The page the Open button goes to: the card's own link when it has one, else the kind's main admin page from the registry (the first
 * `pages` entry), else null (no Open button). A kind the registry has never heard of has no target. Pure. */
export function openTargetFor(card: Pick<TodayCard, 'kind' | 'link'>): { href: string; external: boolean } | null {
  const href = card.link?.href || (isKindId(card.kind) ? CARD_ACTIONS[card.kind]?.copyPromptFields.pages[0] : undefined)
  if (!href || !/^(\/[A-Za-z0-9._~\-/#?=&%[\]]*|https?:\/\/\S+)$/.test(href) || href.startsWith('//')) return null
  return { href, external: /^https?:/.test(href) }
}

/** The choices on the Later menu. A plain tap on Later is the first one. */
export const SNOOZE_CHOICES: ReadonlyArray<{ days: number; label: string }> = [
  { days: 1, label: '1 day' },
  { days: 3, label: '3 days' },
  { days: 7, label: '1 week' },
]
export const DEFAULT_SNOOZE_DAYS = 1

/** Checks a snooze length that came from a browser: only a listed choice is accepted. Anything else is null. Pure. */
export function parseSnoozeDays(v: unknown): number | null {
  return typeof v === 'number' && SNOOZE_CHOICES.some((c) => c.days === v) ? v : null
}

/** Kinds whose actions are unusable (an Auto-heal flag with no repair behind it). Always empty when the table is sound. Used by the offline check. */
export function kindsWithoutActions(kinds: readonly string[] = TODAY_KIND_IDS): string[] {
  return kinds.filter((k) => {
    const a = cardActionsFor(k)
    return !a || a.canAutoHeal !== (a.healFn !== null)
  })
}

/** Which buttons show on row 2 for a card. Pure. Previous, Later and Skip are on every card; Auto-heal only where a safe repair exists. */
export interface RowTwo {
  previous: boolean
  later: boolean
  skip: boolean
  autoHeal: boolean
  copy: boolean
  open: boolean
}
export function rowTwoFor(kind: string, o: { canGoBack: boolean; readOnly: boolean; hasTarget?: boolean }): RowTwo {
  const a = cardActionsFor(kind)
  return {
    open: o.hasTarget === true,
    previous: o.canGoBack,
    later: !o.readOnly,
    skip: !o.readOnly,
    autoHeal: !o.readOnly && a.canAutoHeal,
    copy: true,
  }
}

// ---------------------------------------------------------------------------------------------------
// Session state: Previous and Skip. Lives in the browser only. Nothing here is ever sent to the server.
// ---------------------------------------------------------------------------------------------------

export type DecisionOp = 'approve' | 'reject' | 'snooze'

export interface HistoryEntry {
  id: string
  /** The card as it looked when it was shown, so it can be shown again read-only after it left the queue. */
  card: TodayCard
  /** Null while the card has not been answered in this session. */
  outcome: { op: DecisionOp; label: string } | null
}

export interface SessionState {
  /** Cards sent to the end of today's stack, oldest skip first. */
  skipped: string[]
  /** A card pulled back to the front by Previous (it was not answered, so it is still in the queue). */
  front: string | null
  history: HistoryEntry[]
  /** The answered card currently shown read-only, or null. */
  viewing: HistoryEntry | null
}

export const SESSION_MAX_HISTORY = 30
export const SESSION_MAX_SKIPPED = 100

export const emptySession = (): SessionState => ({ skipped: [], front: null, history: [], viewing: null })

export type SessionAction =
  | { type: 'shown'; card: TodayCard }
  | { type: 'answered'; id: string; op: DecisionOp; label: string }
  | { type: 'unanswered'; id: string }
  | { type: 'skip'; id: string }
  | { type: 'previous'; currentId: string | null; liveIds: readonly string[] }
  | { type: 'closeView' }

/** The server queue with this session's reordering applied: the pulled-back card first, skipped cards last. Pure; the input is not changed. */
export function applySession(cards: readonly TodayCard[], s: Pick<SessionState, 'skipped' | 'front'>): TodayCard[] {
  const skipped = new Set(s.skipped)
  const rest = cards.filter((c) => !skipped.has(c.id) && c.id !== s.front)
  const end = s.skipped.map((id) => cards.find((c) => c.id === id)).filter((c): c is TodayCard => !!c && c.id !== s.front)
  const front = s.front ? cards.find((c) => c.id === s.front) : undefined
  return [...(front ? [front] : []), ...rest, ...end]
}

/** Place of the card on screen in the history, or -1 when it is not there. */
export function historyIndex(s: SessionState, currentId: string | null): number {
  return currentId ? s.history.findIndex((h) => h.id === currentId) : -1
}

/** Previous is available when an earlier card exists in this session's history. */
export function canGoBack(s: SessionState, currentId: string | null): boolean {
  return historyIndex(s, currentId) > 0
}

/** Undo is offered on a read-only answered card only when it is the very last thing the server logged and that step can be undone. */
export function undoOffered(entry: HistoryEntry, last: { id: string; undoable: boolean } | null): boolean {
  return !!entry.outcome && !!last && last.id === entry.id && last.undoable
}

/** The reducer. Pure: same state and action in, new state out. Nothing in it reaches the server. */
export function sessionReducer(s: SessionState, a: SessionAction): SessionState {
  switch (a.type) {
    case 'shown': {
      if (s.history.some((h) => h.id === a.card.id)) {
        // Seen before: refresh its snapshot while it is unanswered, keep its place and its outcome.
        return { ...s, history: s.history.map((h) => (h.id === a.card.id && !h.outcome ? { ...h, card: a.card } : h)) }
      }
      return { ...s, history: [...s.history, { id: a.card.id, card: a.card, outcome: null }].slice(-SESSION_MAX_HISTORY) }
    }
    case 'answered':
      return {
        ...s,
        front: s.front === a.id ? null : s.front,
        skipped: s.skipped.filter((x) => x !== a.id),
        history: s.history.map((h) => (h.id === a.id ? { ...h, outcome: { op: a.op, label: a.label } } : h)),
      }
    case 'unanswered':
      // The step was undone on the server: the card is back in the queue, so bring it to the front.
      return { ...s, front: a.id, viewing: null, history: s.history.map((h) => (h.id === a.id ? { ...h, outcome: null } : h)) }
    case 'skip':
      return { ...s, skipped: [...s.skipped.filter((x) => x !== a.id), a.id].slice(-SESSION_MAX_SKIPPED), front: s.front === a.id ? null : s.front, viewing: null }
    case 'previous': {
      const at = historyIndex(s, a.currentId)
      if (at < 1) return s
      const target = s.history[at - 1]
      // Never silently re-answer: a card that was answered (or has left the queue) is only SHOWN, read-only.
      if (!target.outcome && a.liveIds.includes(target.id)) return { ...s, front: target.id, viewing: null }
      return { ...s, viewing: target }
    }
    case 'closeView':
      return { ...s, viewing: null }
  }
}

/** Reads a stored skipped list (sessionStorage text) back. Anything odd gives an empty list. Pure. */
export function parseSkipped(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length < 260).slice(-SESSION_MAX_SKIPPED) : []
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------------------------------
// Auto-heal: the result shown on the card, and the per-card, per-day cache
// ---------------------------------------------------------------------------------------------------

/** fixed = the repair did something; unchanged = it ran and changed nothing; skipped = it did not run (paused, capped, not this card's turn);
 * failed = it ran and broke. */
export type HealState = 'fixed' | 'unchanged' | 'skipped' | 'failed'

export interface CardHealResult {
  state: HealState
  /** One plain sentence for the card. */
  message: string
  at: string
  /** True when this answer came from today's cache and nothing ran. */
  cached?: boolean
}

export const TODAY_HEAL_KEY = 'today_heal'
export const HEAL_CACHE_MAX = 120

export interface HealCache {
  day: string
  results: Record<string, CardHealResult>
}

const STATES: readonly string[] = ['fixed', 'unchanged', 'skipped', 'failed']

/** Reads the stored cache for `day` (YYYY-MM-DD). A cache from another day, or a damaged one, is empty. Pure. */
export function parseHealCache(raw: string | null | undefined, day: string): HealCache {
  const empty: HealCache = { day, results: {} }
  try {
    const v = JSON.parse(raw ?? 'null') as Partial<HealCache> | null
    if (!v || v.day !== day || !v.results || typeof v.results !== 'object') return empty
    const results: Record<string, CardHealResult> = {}
    for (const [id, r] of Object.entries(v.results)) {
      const x = r as CardHealResult | null
      if (x && typeof x === 'object' && STATES.includes(x.state) && typeof x.message === 'string') results[id] = { state: x.state, message: x.message, at: typeof x.at === 'string' ? x.at : '' }
    }
    return { day, results }
  } catch {
    return empty
  }
}

/** A skipped answer is never cached: it cost nothing, and the reason (paused, capped) may be gone a minute later. Pure. */
export function cacheableHeal(r: CardHealResult): boolean {
  return r.state !== 'skipped'
}

export function putHeal(cache: HealCache, id: string, r: CardHealResult): HealCache {
  if (!cacheableHeal(r)) return cache
  const entries = Object.entries({ ...cache.results, [id]: { state: r.state, message: r.message, at: r.at } })
  return { day: cache.day, results: Object.fromEntries(entries.slice(-HEAL_CACHE_MAX)) }
}

/** The day key the cache uses (UTC date of the instant passed in). */
export const healDay = (now: Date): string => now.toISOString().slice(0, 10)
