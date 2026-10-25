import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'

// Self-learning loop for generated content (captions, reels, covers, social posts). One lifecycle for every repeated failure:
//
//   OBSERVE   a failure is fingerprinted (numbers, ids and slugs stripped) and counted in a ledger (app_settings, no migration);
//   PROPOSE   a known fix is looked up in REMEDIES, a catalogue written in code and reviewed by a person: a model never writes a rule;
//   APPLY     once the same failure has happened twice, the fix goes live as a TRIAL rule that the next generation prompts include;
//   MONITOR   for MONITOR_DAYS the loop counts how often the same failure still happens;
//   LEARN     no repeat: the trial becomes a permanent RULE. A repeat: the rule is withdrawn and the failure is marked
//             'needs-code-fix', with its fingerprint, so the real root cause can be fixed in code (a rule only treats the symptom).
//
// A failure with no catalogued fix is counted and, after three hits, marked 'needs-code-fix' too. Temporary errors (rate limits, a
// busy service) are left to the retry ladder in lib/auto-policies.ts and never become rules. Everything here is pure except the
// ledger read and write at the bottom, so scripts/check-learn-loop.ts can test it offline.

export type RuleTarget = 'caption' | 'reel'
export type FailureSurface = 'post' | 'caption' | 'carousel' | 'video' | 'cover' | 'reel'
export type EntryStatus = 'open' | 'trial' | 'rule' | 'needs-code-fix' | 'transient' | 'disabled'

export const LEDGER_KEY = 'learn_ledger'
export const MONITOR_DAYS = 3
export const APPLY_AFTER_HITS = 2
export const NO_REMEDY_ESCALATE_HITS = 3
export const MAX_ENTRIES = 80
export const MAX_HITS = 40
export const MAX_RULES_PER_PROMPT = 6
const DAY_MS = 86_400_000

export interface Remedy {
  id: string
  /** Matches the normalised (lower-case) failure text. */
  match: RegExp
  /** The line added to the generation prompt. Plain, fixed wording: it can only tighten what the writer may do. */
  rule: string
  injectInto: readonly RuleTarget[]
  /** Where the real fix belongs when the rule alone does not stop it. */
  rootCause: string
}

/** The catalogue. Order matters: the first match wins. A new entry needs a person to add it here. */
export const REMEDIES: readonly Remedy[] = [
  { id: 'reel-length', match: /(reel|video|duration|runtime|spoken).*(too long|over|exceed|seconds)/, rule: 'Keep the whole reel under 30 seconds of speech: six short beats at most, one idea per beat.', injectInto: ['reel'], rootCause: 'lib/video-script.ts capScriptDuration / MAX_DURATION_SECONDS' },
  { id: 'long-dash', match: /(em|long) dash/, rule: 'Never use a long dash character; use a comma or a full stop.', injectInto: ['caption', 'reel'], rootCause: 'repairDashes should run on this output path' },
  { id: 'cta-link', match: /call to action is missing|link is missing/, rule: 'End with exactly one call to action line, then the link on its own line, copied exactly as given.', injectInto: ['caption'], rootCause: 'lib/social-captions.ts repairCaptionCta' },
  { id: 'caption-length', match: /too long|character limit|over the limit|exceed/, rule: 'Stay well under each platform limit: aim for 80 percent of it.', injectInto: ['caption'], rootCause: 'lib/social-captions.ts fitCaption / PLATFORM_CHAR_LIMITS' },
  { id: 'ungrounded-number', match: /number.*(not in|isn't in|unsupported|ungrounded)|(ungrounded|unsupported) number/, rule: 'Write no number that does not appear word for word in the title, summary or facts.', injectInto: ['caption', 'reel'], rootCause: 'lib/video-script.ts knownNumbers / caption grounding check' },
  { id: 'weak-opener', match: /weak opener|brochure|starts with the (blog )?title/, rule: 'Open with a question or a contrast. Never open with Discover, Explore, Welcome or the post title.', injectInto: ['caption', 'reel'], rootCause: 'lib/hook-rules.ts WEAK_OPENERS' },
  { id: 'scene-setter', match: /scene.?setter|picture\/imagine|imagine opener/, rule: 'Never start a sentence with Picture, Imagine, Envision or Close your eyes.', injectInto: ['caption', 'reel'], rootCause: 'lib/reel-script-rules.ts stripSceneSetters' },
  { id: 'emoji-hashtag', match: /emoji|hashtag/, rule: 'Use at most two emoji and no more than ten hashtags.', injectInto: ['caption'], rootCause: 'lib/hook-rules.ts CAPTION_MAX_EMOJIS / CAPTION_MAX_HASHTAGS' },
]

export interface LedgerEntry {
  sig: string
  surface: FailureSurface
  sample: string
  first: string
  last: string
  /** Times (ISO) this failure was seen; the newest MAX_HITS. */
  hits: string[]
  count: number
  status: EntryStatus
  remedyId?: string
  appliedAt?: string
  confirmedAt?: string
  note?: string
}

export interface Observation {
  surface: FailureSurface
  text: string
  at: string
}

export interface LedgerEvent {
  sig: string
  action: 'applied' | 'learned' | 'withdrawn' | 'escalated'
  reason: string
}

// ---------------------------------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------------------------------

/** The failure text with everything that varies per post removed, so the same problem on different posts is one fingerprint. Pure. */
export function normalizeFailure(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/\b[a-z0-9]+(?:-[a-z0-9]+){2,}\b/g, '<slug>')
    .replace(/"[^"]{3,}"/g, '"<text>"')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 110)
}

export const signatureOf = (surface: FailureSurface, text: string): string => `${surface}|${normalizeFailure(text)}`

export function remedyFor(normalized: string): Remedy | null {
  return REMEDIES.find((r) => r.match.test(normalized)) ?? null
}

/** Retry-ladder territory: a busy service or a dropped connection says nothing about the content. */
const TRANSIENT = /\b(429|502|503)\b|rate.?limit|too many requests|temporar|try again|service unavailable|bad gateway|econnreset|econnrefused|enotfound|socket hang up|fetch failed|timed? ?out|unreachable|overloaded/i
export const isTransient = (text: string): boolean => TRANSIENT.test(text)

// ---------------------------------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------------------------------

export function parseLedger(raw: string | null | undefined): LedgerEntry[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v)) return []
    return v.filter((e): e is LedgerEntry => !!e && typeof e === 'object' && typeof (e as LedgerEntry).sig === 'string' && Array.isArray((e as LedgerEntry).hits)).slice(0, MAX_ENTRIES)
  } catch {
    return []
  }
}

/** Adds observations to the ledger (new fingerprints are created; repeats add a hit). A hit already recorded (same time) is not added twice. Pure. */
export function observe(ledger: readonly LedgerEntry[], obs: readonly Observation[]): LedgerEntry[] {
  const map = new Map(ledger.map((e) => [e.sig, { ...e, hits: [...e.hits] }]))
  for (const o of obs) {
    if (!o.text.trim() || !Number.isFinite(Date.parse(o.at))) continue
    const sig = signatureOf(o.surface, o.text)
    let e = map.get(sig)
    if (!e) {
      e = { sig, surface: o.surface, sample: o.text.slice(0, 160), first: o.at, last: o.at, hits: [], count: 0, status: 'open' }
      map.set(sig, e)
    }
    if (e.hits.includes(o.at)) continue
    e.hits = [...e.hits, o.at].sort().slice(-MAX_HITS)
    e.count += 1
    if (o.at > e.last) e.last = o.at
  }
  return [...map.values()].sort((a, b) => b.last.localeCompare(a.last)).slice(0, MAX_ENTRIES)
}

const hitsAfter = (e: LedgerEntry, iso: string): number => e.hits.filter((h) => h > iso).length

/** Moves one entry along the lifecycle. Returns the new entry and, when something happened, the event to log. Pure. */
export function evolve(entry: LedgerEntry, now: Date): { entry: LedgerEntry; event?: LedgerEvent } {
  const e = { ...entry }
  const normalized = e.sig.slice(e.sig.indexOf('|') + 1)
  const nowIso = now.toISOString()
  if (e.status === 'open' || e.status === 'transient') {
    const remedy = remedyFor(normalized)
    if (remedy) {
      if (e.count < APPLY_AFTER_HITS) return { entry: e }
      return { entry: { ...e, status: 'trial', remedyId: remedy.id, appliedAt: nowIso }, event: { sig: e.sig, action: 'applied', reason: `seen ${e.count} times; trial rule "${remedy.rule}" is now in the ${remedy.injectInto.join(' and ')} prompt` } }
    }
    if (isTransient(e.sample)) return { entry: { ...e, status: 'transient' } }
    if (e.status === 'open' && e.count >= NO_REMEDY_ESCALATE_HITS) {
      return { entry: { ...e, status: 'needs-code-fix', note: 'no catalogued rule fits; a person or Claude must fix the cause in code' }, event: { sig: e.sig, action: 'escalated', reason: `seen ${e.count} times and no catalogued rule fits: needs a code fix` } }
    }
    return { entry: e }
  }
  if (e.status === 'trial' && e.appliedAt) {
    const repeats = hitsAfter(e, e.appliedAt)
    const age = now.getTime() - Date.parse(e.appliedAt)
    const remedy = REMEDIES.find((r) => r.id === e.remedyId)
    if (repeats >= 2 || (repeats === 1 && age >= 2 * MONITOR_DAYS * DAY_MS)) {
      return { entry: { ...e, status: 'needs-code-fix', note: `the rule did not stop it (${repeats} repeats); root cause: ${remedy?.rootCause ?? 'unknown'}` }, event: { sig: e.sig, action: 'withdrawn', reason: `trial rule did not work (${repeats} repeat${repeats === 1 ? '' : 's'}); withdrawn, fix the cause in ${remedy?.rootCause ?? 'code'}` } }
    }
    if (repeats === 0 && age >= MONITOR_DAYS * DAY_MS) {
      return { entry: { ...e, status: 'rule', confirmedAt: nowIso }, event: { sig: e.sig, action: 'learned', reason: `no repeat in ${MONITOR_DAYS} days; "${remedy?.rule ?? e.remedyId}" is now a permanent rule` } }
    }
    return { entry: e }
  }
  if (e.status === 'rule' && e.confirmedAt) {
    const repeats = hitsAfter(e, e.confirmedAt)
    if (repeats >= 3) {
      const remedy = REMEDIES.find((r) => r.id === e.remedyId)
      return { entry: { ...e, status: 'needs-code-fix', note: `the rule stopped working (${repeats} repeats); root cause: ${remedy?.rootCause ?? 'unknown'}` }, event: { sig: e.sig, action: 'withdrawn', reason: `permanent rule failed ${repeats} times since it was confirmed; withdrawn` } }
    }
  }
  return { entry: e }
}

export function evolveAll(ledger: readonly LedgerEntry[], now: Date, maxEvents = 6): { ledger: LedgerEntry[]; events: LedgerEvent[] } {
  const events: LedgerEvent[] = []
  const out = ledger.map((e) => {
    if (events.length >= maxEvents) return e
    const r = evolve(e, now)
    if (r.event) events.push(r.event)
    return r.entry
  })
  return { ledger: out, events }
}

/** The prompt lines for one target: trial and permanent rules, newest first, at most MAX_RULES_PER_PROMPT, no duplicates. Pure. */
export function activeRules(ledger: readonly LedgerEntry[], target: RuleTarget): string[] {
  const lines: string[] = []
  for (const e of ledger) {
    if (e.status !== 'trial' && e.status !== 'rule') continue
    const r = REMEDIES.find((x) => x.id === e.remedyId)
    if (r && r.injectInto.includes(target) && !lines.includes(r.rule)) lines.push(r.rule)
  }
  return lines.slice(0, MAX_RULES_PER_PROMPT)
}

/** Appends the learned rules to a finished prompt. Returns the prompt unchanged when there are none. Pure. */
export function withLearnedRules(prompt: string, rules: readonly string[]): string {
  if (rules.length === 0) return prompt
  return `${prompt}\n\nRULES LEARNED FROM EARLIER FAILURES (each one fixed a real problem; follow all of them):\n${rules.map((r) => `- ${r}`).join('\n')}`
}

// ---------------------------------------------------------------------------------------------------
// Storage (fails open: a ledger problem never blocks a post)
// ---------------------------------------------------------------------------------------------------

export async function readLedger(admin: SupabaseClient): Promise<LedgerEntry[]> {
  try {
    return parseLedger(await getSetting(admin, LEDGER_KEY))
  } catch {
    return []
  }
}

export async function writeLedger(admin: SupabaseClient, ledger: readonly LedgerEntry[]): Promise<{ error?: string }> {
  try {
    return await setSetting(admin, LEDGER_KEY, JSON.stringify(ledger))
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'could not write the ledger' }
  }
}

/** The learned rules for a prompt, or [] when the ledger cannot be read. Used by the caption and reel writers. */
export async function loadLearnedRules(target: RuleTarget): Promise<string[]> {
  try {
    const { getSupabaseAdmin } = await import('@/lib/supabase-admin')
    return activeRules(await readLedger(getSupabaseAdmin()), target)
  } catch {
    return []
  }
}
