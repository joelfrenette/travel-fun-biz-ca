// Dry run, pure part (no database, no network, no node-only imports, so the System check and the admin page can import it).
// Ported from TravelFun.ai's dry-run pattern (lib/marketing/dry-run*.ts). The idea: one switch turns the whole autopilot pass into
// a rehearsal that says what it WOULD do and does none of it. lib/dry-run.ts holds the gate, lib/dry-run-plan.ts the rehearsal.

/** app_settings key. 'on' = dry run. Anything else, or no row, = off (the default). */
export const DRY_RUN_KEY = 'autopilot_dry_run'
/** When the switch was turned on (ISO time). Cleared when it is turned off. Drives the "more than 24 hours" System check line. */
export const DRY_RUN_SINCE_KEY = 'autopilot_dry_run_since'
/** The last few dry passes, newest last, as JSON. */
export const DRY_RUN_LOG_KEY = 'autopilot_dry_run_log'
/** How many passes the log keeps. */
export const DRY_LOG_MAX = 5
/** Most intents kept per pass, and the longest text of one. A dry pass must never grow the settings table. */
export const DRY_INTENTS_MAX = 40
export const DRY_DETAIL_MAX = 200
/** After this many hours in dry run the System check turns amber. */
export const DRY_RUN_AMBER_HOURS = 24

/** Every kind of outside effect the autopilot has. Each one goes through the one gate in lib/dry-run.ts. */
export type EffectKind = 'publish-post' | 'social-post' | 'email' | 'heal-write' | 'apply-decision' | 'topic-status' | 'counter' | 'ai-call'

export const EFFECT_LABELS: Record<EffectKind, string> = {
  'publish-post': 'Publish a post',
  'social-post': 'Send to social',
  email: 'Send an email',
  'heal-write': 'Apply a repair',
  'apply-decision': 'Take an automatic decision',
  'topic-status': 'Change a topic',
  counter: 'Move a counter',
  'ai-call': 'Call the AI',
}

export interface DryIntent {
  kind: EffectKind
  /** The pipeline step it belongs to. */
  step: string
  /** What it would have done, in plain words. */
  detail: string
}

export interface DryCeiling {
  /** Estimated dollars spent in the last 24 hours, or null when it could not be read (never shown as 0). */
  spendUsd: number | null
  ceilingUsd: number
  /** Rough dollars the AI calls in this pass would add. An estimate, not a bill. */
  plannedUsd: number
  /** True when spend plus planned is above the ceiling. null when the spend could not be read. */
  wouldExceed: boolean | null
}

export interface DryStepNote {
  step: string
  note: string
}

export interface DryPass {
  at: string
  trigger: 'schedule' | 'button'
  steps: DryStepNote[]
  intents: DryIntent[]
  /** Number of AI calls this pass would make (none were made). */
  aiCalls: number
  ceiling: DryCeiling
}

export const isDryRunOn = (raw: string | null | undefined): boolean => raw === 'on'

/** Rough planning cost of one AI-backed step, in dollars. These are guesses for the "would exceed" line only; the real meter is lib/ai-meter.ts. */
export const PLANNED_AI_USD: Record<string, number> = {
  write: 0.35,
  guides: 0.3,
  copy: 0.1,
  news: 0.15,
  'heal-content': 0.2,
  keywords: 0.05,
}

/** Pure: does spend plus planned go over the ceiling? null when the spend is unknown. */
export function judgeCeiling(spendUsd: number | null, ceilingUsd: number, plannedUsd: number): DryCeiling {
  const planned = Math.round(Math.max(0, plannedUsd) * 100) / 100
  const wouldExceed = spendUsd === null || !Number.isFinite(spendUsd) ? null : spendUsd + planned > ceilingUsd
  return { spendUsd: spendUsd === null || !Number.isFinite(spendUsd) ? null : spendUsd, ceilingUsd, plannedUsd: planned, wouldExceed }
}

const money = (n: number) => `$${n.toFixed(2)}`

/** Pure: the ceiling line for the report, in plain words. */
export function ceilingSentence(c: DryCeiling): string {
  if (c.wouldExceed === null) return `The AI spend could not be read. The daily limit of ${money(c.ceilingUsd)} was not checked.`
  const spent = c.spendUsd ?? 0
  const facts = `About ${money(spent)} was spent in 24 hours. About ${money(c.plannedUsd)} more is planned. The limit is ${money(c.ceilingUsd)}.`
  if (c.wouldExceed) return `Would exceed the daily limit. ${facts}`
  return `Within the limit. ${facts}`
}

/** Pure: whole hours between the switch being turned on and now, or null when unknown. Never negative. */
export function dryRunHours(sinceIso: string | null | undefined, now: Date): number | null {
  const t = Date.parse(sinceIso ?? '')
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.floor((now.getTime() - t) / 3_600_000))
}

/** Pure: the System check sentence. Short plain words (grade 6 or lower), no long dashes. */
export function dryRunSentence(hours: number): string {
  return `Autopilot is in dry run. Nothing is going live. It has been this way for ${hours} hour${hours === 1 ? '' : 's'}.`
}

/** The big banner on the Autopilot page, while the switch is on. */
export const DRY_RUN_BANNER_TITLE = 'DRY RUN IS ON. Nothing goes live.'
export const DRY_RUN_BANNER_BODY =
  'Autopilot still checks all its work. It says what it would do, but it does not do it. It posts nothing. It sends no email. It makes no repairs. It makes no AI calls. Turn dry run off when you want Autopilot to work again.'
export const DRY_RUN_EXPLAINER =
  'This is a rehearsal. When it is on, each pass only notes what Autopilot would do. It lists the topic it would write. It lists the post it would publish. It lists what it would send to social. It lists the repairs it would make. Then it does none of it. Use it after a change, to see what Autopilot will do before you let it.'

/** Pure: reads the stored log. Anything junk gives an empty list; at most DRY_LOG_MAX passes. */
export function parseDryLog(raw: string | null | undefined): DryPass[] {
  try {
    const v = JSON.parse(raw ?? '[]') as unknown
    if (!Array.isArray(v)) return []
    return v
      .filter((p): p is DryPass => !!p && typeof p === 'object' && typeof (p as DryPass).at === 'string' && Array.isArray((p as DryPass).steps) && Array.isArray((p as DryPass).intents) && !!(p as DryPass).ceiling)
      .slice(-DRY_LOG_MAX)
  } catch {
    return []
  }
}

/** Pure: adds a pass to the log, keeping the newest DRY_LOG_MAX, with every list and text bounded. */
export function appendDryPass(log: DryPass[], pass: DryPass): DryPass[] {
  const bounded: DryPass = {
    ...pass,
    steps: pass.steps.slice(0, 30).map((s) => ({ step: s.step, note: s.note.slice(0, 400) })),
    intents: pass.intents.slice(0, DRY_INTENTS_MAX).map((i) => ({ ...i, detail: i.detail.slice(0, DRY_DETAIL_MAX) })),
  }
  return [...log, bounded].slice(-DRY_LOG_MAX)
}
