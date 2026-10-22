// The Optimizer: closes the loop between what we post and what comes back. PURE on purpose: no imports, no database, no network,
// no clock except the `now` it is given, no randomness except the `rand` it is given. lib/optimizer-run.ts does the reading and writing.
//
// What it does, in plain words:
//  1. STITCH   joins sends, visits, leads and Google impressions into one row per post, network and format. A number nobody measured
//              is null, never zero.
//  2. LEARN    keeps, per network and format, how many visits each hook style (and cover design) earned per send. A send is only
//              counted once it is SETTLE_DAYS old, so late visits are in, and each send is counted exactly once.
//  3. DECIDE   an arm (one style on one network and format) is retired only when it has MIN_ARM_SENDS sends, a clearly better arm
//              exists (the two confidence ranges do not overlap, with a wide safety margin because visits come in clumps), at least
//              MIN_ACTIVE_ARMS arms would stay, and the network has not retired anything this week. A retired arm is brought back
//              for a fresh test after UNRETIRE_AFTER_DAYS.
//  4. STEER    once a group has two arms with MIN_ARM_SENDS sends, 85 percent of choices are made by Thompson sampling (a random draw
//              from what we believe each arm earns, so better arms win more often but never always). The other 15 percent, and every
//              choice while data is thin, fall back to today's rotation. Retired arms leave the rotation.
//  5. TIMING   per network, visits per send by 4 hour window (Eastern time). A window is only proposed when it clearly beats the rest.
//
// Nothing here ever throws on bad input: a corrupt state parses to null and callers fall back to today's rotation.

// ---------------------------------------------------------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------------------------------------------------------

export const OPTIMIZER_STATE_KEY = 'optimizer_state'
/** An arm needs this many counted sends before it can be retired, and before it counts towards steering. */
export const MIN_ARM_SENDS = 20
/** Share of choices that always fall back to today's rotation once steering is on, so winners never take everything. */
export const EXPLORE_FLOOR = 0.15
/** A send is counted only once it is this old, so its visits have mostly arrived. Visits are counted for this long after the send. */
export const SETTLE_DAYS = 7
/** At most this many arms retired per network in any 7 days. */
export const MAX_RETIRE_PER_NETWORK_PER_WEEK = 1
export const RETIRE_WINDOW_DAYS = 7
/** A retired arm is put back on trial after this long. */
export const UNRETIRE_AFTER_DAYS = 28
/** Never retire if fewer than this many arms would be left in the group. */
export const MIN_ACTIVE_ARMS = 3
/** One-sided confidence for "clearly worse": 1.64 is about 95 percent. */
export const CONFIDENCE_Z = 1.64
/** Visits come in clumps (one popular post), so the plain Poisson range is too narrow. The z value is multiplied by sqrt of this. */
export const DISPERSION = 2
export const NETWORK_ALL = 'all'
/** Posting windows: 4 hours each, Eastern time. A window needs this many counted sends before it is compared. */
export const TIME_BUCKET_HOURS = 4
export const MIN_WINDOW_SENDS = 20

export const MAX_ARMS = 120
export const MAX_DECISIONS = 30
export const MAX_STATE_CHARS = 24000

export type Format = 'post' | 'carousel' | 'reel' | 'recap'
export type Dim = 'hook' | 'cover'

const DAY = 86_400_000

// ---------------------------------------------------------------------------------------------------------------------------
// 1. Funnel stitch
// ---------------------------------------------------------------------------------------------------------------------------

export interface SendRecord {
  at: string
  slug: string
  /** One network, or several joined with "/" (a carousel and a reel go out as one caption). */
  network: string
  /** The caption log's format: post, carousel, video or recap. */
  format: string
  /** The hook style, or "fallback" when there was none. */
  style: string
}
export interface VisitRecord {
  at: string
  source: string
  campaign: string
  content: string
}
export interface LeadRecord {
  at: string
  source: string
  campaign: string
  content: string
}
export interface StitchInput {
  sends: readonly SendRecord[]
  /** slug -> cover template per surface (feed, carousel, reel), from the content_variants tags. */
  covers?: Readonly<Record<string, Partial<Record<'feed' | 'carousel' | 'reel', string>>>> | null
  /** null = visits are not recorded or could not be read (every visits figure stays null). */
  visits: readonly VisitRecord[] | null
  /** null = leads could not be read. */
  leads: readonly LeadRecord[] | null
  /** slug -> Google impressions (28 day total on the newest snapshot). null/missing = unknown. */
  impressions?: Readonly<Record<string, number | null>> | null
  /** How long after a send its visits and leads still count. Default SETTLE_DAYS. */
  windowDays?: number
}
export interface FunnelRow {
  slug: string
  network: string
  format: Format
  hookStyle: string | null
  coverTemplate: string | null
  sends: number
  visits: number | null
  leads: number | null
  impressions: number | null
  /** Time of the first and last send in this row, and every send time (ISO). */
  firstAt: string
  lastAt: string
  sendTimes: string[]
}

export const canonNetwork = (name: string | null | undefined): string => {
  const n = String(name ?? '').trim().toLowerCase()
  return n === 'twitter' ? 'x' : n
}

const SURFACE_FORMAT: Record<string, Format> = { carousel: 'carousel', video: 'reel', recap: 'recap', post: 'post', guide: 'post', trip: 'post', news: 'post' }

/** "question-video" -> { style: "question", surface: "video" }. The hook style "how-to" has a dash, so only the LAST part is the surface. */
export function parseContent(content: string | null | undefined): { style: string | null; format: Format } {
  const c = String(content ?? '').trim().toLowerCase()
  const m = /^(.*)-(post|guide|trip|news|carousel|video|recap)$/.exec(c)
  if (m) return { style: m[1] && m[1] !== 'fallback' ? m[1] : null, format: SURFACE_FORMAT[m[2]] }
  if (SURFACE_FORMAT[c]) return { style: null, format: SURFACE_FORMAT[c] }
  return { style: null, format: 'post' }
}

const formatOf = (f: string): Format => (f === 'carousel' ? 'carousel' : f === 'video' || f === 'reel' ? 'reel' : f === 'recap' ? 'recap' : 'post')
const ms = (iso: string): number => Date.parse(iso)

/** Where a visit or lead belongs: carousel and reel links carry the FORMAT as utm_source (one caption goes to all networks), the
 * rest carry the network. Returns null when the record cannot be placed. */
function placeTouch(t: { source: string; campaign: string; content: string }): { slug: string; network: string; format: Format } | null {
  const slug = String(t.campaign ?? '').trim().toLowerCase()
  const src = canonNetwork(t.source)
  if (!slug || !src) return null
  if (src === 'carousel') return { slug, network: NETWORK_ALL, format: 'carousel' }
  if (src === 'video') return { slug, network: NETWORK_ALL, format: 'reel' }
  return { slug, network: src, format: parseContent(t.content).format }
}

/** Joins sends, visits, leads and impressions into one row per (slug, network, format). Missing data is null, never zero:
 * visits and leads are null when their source is null; a row with a known source and no matching record has 0 (a real measurement). */
export function stitchFunnel(input: StitchInput): FunnelRow[] {
  const windowMs = (input.windowDays ?? SETTLE_DAYS) * DAY
  const rows = new Map<string, FunnelRow & { styles: Map<string, number> }>()
  for (const s of input.sends) {
    const t = ms(s.at)
    if (!s.slug || !Number.isFinite(t)) continue
    const format = formatOf(s.format)
    const nets = format === 'carousel' || format === 'reel' ? [NETWORK_ALL] : String(s.network ?? '').split('/').map(canonNetwork).filter(Boolean)
    for (const network of nets) {
      const key = `${s.slug.toLowerCase()}|${network}|${format}`
      let r = rows.get(key)
      if (!r) {
        r = { slug: s.slug, network, format, hookStyle: null, coverTemplate: null, sends: 0, visits: null, leads: null, impressions: null, firstAt: s.at, lastAt: s.at, sendTimes: [], styles: new Map() }
        rows.set(key, r)
      }
      r.sends++
      r.sendTimes.push(s.at)
      if (t < ms(r.firstAt)) r.firstAt = s.at
      if (t > ms(r.lastAt)) r.lastAt = s.at
      const style = String(s.style ?? '').trim().toLowerCase()
      if (style && style !== 'fallback') r.styles.set(style, (r.styles.get(style) ?? 0) + 1)
    }
  }
  const out = [...rows.values()]
  for (const r of out) {
    // The style used most often for this row (a row is normally one send, so normally just that send's style).
    let best: [string, number] | null = null
    for (const e of r.styles) if (!best || e[1] > best[1]) best = e
    r.hookStyle = best ? best[0] : null
    const surface = r.format === 'post' ? 'feed' : r.format === 'carousel' ? 'carousel' : r.format === 'reel' ? 'reel' : null
    const tpl = surface ? input.covers?.[r.slug]?.[surface] : null
    r.coverTemplate = typeof tpl === 'string' && tpl ? tpl : null
    const imp = input.impressions?.[r.slug]
    r.impressions = typeof imp === 'number' && Number.isFinite(imp) ? imp : null
    if (input.visits) r.visits = 0
    if (input.leads) r.leads = 0
  }
  const index = new Map(out.map((r) => [`${r.slug.toLowerCase()}|${r.network}|${r.format}`, r]))
  const credit = (list: readonly { at: string; source: string; campaign: string; content: string }[], field: 'visits' | 'leads') => {
    for (const t of list) {
      const p = placeTouch(t)
      const at = ms(t.at)
      if (!p || !Number.isFinite(at)) continue
      const r = index.get(`${p.slug}|${p.network}|${p.format}`)
      if (!r) continue
      if (at < ms(r.firstAt) || at > ms(r.lastAt) + windowMs) continue
      r[field] = (r[field] ?? 0) + 1
    }
  }
  if (input.visits) credit(input.visits, 'visits')
  if (input.leads) credit(input.leads, 'leads')
  return out.map(({ styles: _styles, ...row }) => row).sort((a, b) => ms(a.firstAt) - ms(b.firstAt) || a.slug.localeCompare(b.slug) || a.network.localeCompare(b.network))
}

// ---------------------------------------------------------------------------------------------------------------------------
// 2. State
// ---------------------------------------------------------------------------------------------------------------------------

export interface Arm {
  network: string
  format: string
  dim: Dim
  value: string
  /** Counted sends and the visits they earned (and leads, for display only). */
  n: number
  v: number
  l: number
  status: 'active' | 'retired'
  retiredAt?: string
  /** Sends before this time are not counted (set when an arm comes back for a fresh test). */
  since?: string
  /** Set while this arm clearly beats every other arm in its group. */
  winner?: boolean
}
export interface Decision {
  at: string
  kind: 'retire' | 'unretire' | 'winner' | 'window'
  network: string
  format: string
  dim: string
  value: string
  /** Plain English, ready to show. */
  text: string
}
export interface TimeCell {
  n: number
  v: number
}
export interface WindowAdvice {
  bucket: number
  label: string
  sends: number
  visits: number
  text: string
}
export interface OptimizerState {
  v: 1
  updatedAt: string
  /** Sends settled at or before this time have been counted. */
  settledThrough: string | null
  /** Settled sends skipped because visits were not measured. */
  unmeasured: number
  arms: Record<string, Arm>
  decisions: Decision[]
  /** network -> bucket (0..5) -> counted sends and visits. */
  time: Record<string, Record<string, TimeCell>>
  advice: Record<string, WindowAdvice>
}

export const armKey = (network: string, format: string, dim: Dim, value: string): string => `${network}|${format}|${dim}|${value}`

export function emptyState(now: Date): OptimizerState {
  return { v: 1, updatedAt: now.toISOString(), settledThrough: null, unmeasured: 0, arms: {}, decisions: [], time: {}, advice: {} }
}

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.min(x, 1e9) : 0)
const str = (x: unknown, max: number): string => (typeof x === 'string' ? x.slice(0, max) : '')
const iso = (x: unknown): string | undefined => (typeof x === 'string' && Number.isFinite(Date.parse(x)) ? x : undefined)

/** Reads the stored value. Missing, empty, corrupt or wrong-shaped JSON gives null: callers then use today's rotation. */
export function parseState(raw: string | null | undefined): OptimizerState | null {
  try {
    if (!raw) return null
    const o = JSON.parse(raw) as Record<string, unknown>
    if (!o || typeof o !== 'object' || Array.isArray(o) || o.v !== 1) return null
    const armsIn = o.arms && typeof o.arms === 'object' && !Array.isArray(o.arms) ? (o.arms as Record<string, Record<string, unknown>>) : {}
    const arms: Record<string, Arm> = {}
    for (const a of Object.values(armsIn)) {
      if (!a || typeof a !== 'object') continue
      const dim = a.dim === 'cover' ? 'cover' : a.dim === 'hook' ? 'hook' : null
      const network = str(a.network, 40)
      const format = str(a.format, 20)
      const value = str(a.value, 40)
      if (!dim || !network || !format || !value) continue
      arms[armKey(network, format, dim, value)] = {
        network, format, dim, value, n: num(a.n), v: num(a.v), l: num(a.l),
        status: a.status === 'retired' ? 'retired' : 'active',
        retiredAt: iso(a.retiredAt), since: iso(a.since), winner: a.winner === true ? true : undefined,
      }
    }
    const decisions: Decision[] = Array.isArray(o.decisions)
      ? (o.decisions as Record<string, unknown>[])
          .filter((d) => d && typeof d === 'object' && iso(d.at) && typeof d.text === 'string')
          .map((d) => ({ at: d.at as string, kind: (['retire', 'unretire', 'winner', 'window'].includes(d.kind as string) ? d.kind : 'retire') as Decision['kind'], network: str(d.network, 40), format: str(d.format, 20), dim: str(d.dim, 10), value: str(d.value, 40), text: str(d.text, 300) }))
          .slice(0, MAX_DECISIONS)
      : []
    const time: OptimizerState['time'] = {}
    if (o.time && typeof o.time === 'object' && !Array.isArray(o.time)) {
      for (const [net, cells] of Object.entries(o.time as Record<string, unknown>)) {
        if (!cells || typeof cells !== 'object') continue
        const t: Record<string, TimeCell> = {}
        for (const [b, c] of Object.entries(cells as Record<string, Record<string, unknown>>)) {
          const bi = Number(b)
          if (Number.isInteger(bi) && bi >= 0 && bi < 24 / TIME_BUCKET_HOURS && c) t[String(bi)] = { n: num(c.n), v: num(c.v) }
        }
        time[str(net, 40)] = t
      }
    }
    const advice: OptimizerState['advice'] = {}
    if (o.advice && typeof o.advice === 'object' && !Array.isArray(o.advice)) {
      for (const [net, a] of Object.entries(o.advice as Record<string, Record<string, unknown>>)) {
        if (a && typeof a === 'object' && Number.isInteger(a.bucket)) advice[str(net, 40)] = { bucket: a.bucket as number, label: str(a.label, 60), sends: num(a.sends), visits: num(a.visits), text: str(a.text, 300) }
      }
    }
    return { v: 1, updatedAt: iso(o.updatedAt) ?? new Date(0).toISOString(), settledThrough: iso(o.settledThrough) ?? null, unmeasured: num(o.unmeasured), arms, decisions, time, advice }
  } catch {
    return null
  }
}

/** The text to store. Bounded: at most MAX_ARMS arms (least-sampled active ones go first), MAX_DECISIONS decisions, and under
 * MAX_STATE_CHARS in total (older decisions, then more thin arms, are dropped until it fits). */
export function serializeState(state: OptimizerState): string {
  const s: OptimizerState = { ...state, arms: { ...state.arms }, decisions: state.decisions.slice(0, MAX_DECISIONS) }
  const dropThin = (keep: number) => {
    const keys = Object.keys(s.arms)
    if (keys.length <= keep) return
    const score = (k: string) => (s.arms[k].status === 'retired' ? 1e9 : 0) + s.arms[k].n
    for (const k of keys.sort((a, b) => score(a) - score(b)).slice(0, keys.length - keep)) delete s.arms[k]
  }
  dropThin(MAX_ARMS)
  let text = JSON.stringify(s)
  while (text.length > MAX_STATE_CHARS && s.decisions.length > 5) {
    s.decisions = s.decisions.slice(0, Math.max(5, Math.floor(s.decisions.length * 0.7)))
    text = JSON.stringify(s)
  }
  let keep = Object.keys(s.arms).length
  while (text.length > MAX_STATE_CHARS && keep > 10) {
    keep = Math.floor(keep * 0.8)
    dropThin(keep)
    text = JSON.stringify(s)
  }
  return text
}

// ---------------------------------------------------------------------------------------------------------------------------
// 3. Ingest (count settled sends exactly once)
// ---------------------------------------------------------------------------------------------------------------------------

/** Eastern time hour (0..23) of an ISO time. */
export function easternHour(isoTime: string): number | null {
  const d = new Date(isoTime)
  if (!Number.isFinite(d.getTime())) return null
  try {
    const h = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: 'numeric', hourCycle: 'h23' }).format(d))
    return Number.isFinite(h) ? h % 24 : null
  } catch {
    return null
  }
}

export const bucketLabel = (b: number): string => {
  const h = (x: number) => (x % 24 === 0 ? '12 am' : x % 24 < 12 ? `${x % 24} am` : x % 24 === 12 ? '12 pm' : `${(x % 24) - 12} pm`)
  return `${h(b * TIME_BUCKET_HOURS)} to ${h((b + 1) * TIME_BUCKET_HOURS)} Eastern`
}

/** Adds every row whose last send is settled (older than SETTLE_DAYS) and not counted before. A row whose visits are null
 * (not measured) is NOT counted, so unmeasured is never mistaken for zero. Returns a new state; the input is not changed. */
export function ingest(state: OptimizerState, rows: readonly FunnelRow[], now: Date): { state: OptimizerState; counted: number; skipped: number } {
  const cutoff = now.getTime() - SETTLE_DAYS * DAY
  const from = state.settledThrough ? ms(state.settledThrough) : -Infinity
  const next: OptimizerState = { ...state, arms: Object.fromEntries(Object.entries(state.arms).map(([k, a]) => [k, { ...a }])), time: JSON.parse(JSON.stringify(state.time)) as OptimizerState['time'], decisions: [...state.decisions], advice: { ...state.advice } }
  let counted = 0
  let skipped = 0
  const bump = (network: string, format: string, dim: Dim, value: string, r: FunnelRow) => {
    const k = armKey(network, format, dim, value)
    const arm = next.arms[k] ?? { network, format, dim, value, n: 0, v: 0, l: 0, status: 'active' as const }
    if (arm.since && ms(r.lastAt) < ms(arm.since)) return
    arm.n += r.sends
    arm.v += r.visits ?? 0
    arm.l += r.leads ?? 0
    next.arms[k] = arm
  }
  for (const r of rows) {
    const last = ms(r.lastAt)
    if (!Number.isFinite(last) || last > cutoff || last <= from) continue
    if (r.visits === null) {
      skipped++
      continue
    }
    counted++
    if (r.format === 'recap') continue
    if (r.hookStyle) bump(r.network, r.format, 'hook', r.hookStyle, r)
    if (r.coverTemplate) bump(r.network, r.format, 'cover', r.coverTemplate, r)
    // Posting time: only per real network and only for photo posts. Visits are shared evenly between the row's sends.
    if (r.format === 'post' && r.network !== NETWORK_ALL && r.sends > 0) {
      const perSend = r.visits / r.sends
      const cells = (next.time[r.network] ??= {})
      for (const t of r.sendTimes) {
        const h = easternHour(t)
        if (h === null) continue
        const b = String(Math.floor(h / TIME_BUCKET_HOURS))
        const c = (cells[b] ??= { n: 0, v: 0 })
        c.n += 1
        c.v += perSend
      }
    }
  }
  next.settledThrough = new Date(Math.max(cutoff, from === -Infinity ? cutoff : from)).toISOString()
  next.unmeasured = state.unmeasured + skipped
  return { state: next, counted, skipped }
}

// ---------------------------------------------------------------------------------------------------------------------------
// 4. Statistics, decisions
// ---------------------------------------------------------------------------------------------------------------------------

/** Confidence range for visits per send (Poisson, square root method, widened for clumpy visits). */
export function rateBounds(v: number, n: number, z: number = CONFIDENCE_Z): { lower: number; upper: number; rate: number } {
  if (!(n > 0)) return { lower: 0, upper: Infinity, rate: 0 }
  const zz = z * Math.sqrt(DISPERSION)
  const r = Math.sqrt(Math.max(0, v) + 0.375)
  const lower = Math.max(0, (Math.max(0, r - zz / 2) ** 2 - 0.375) / n)
  const upper = Math.max(0, ((r + zz / 2) ** 2 - 0.375) / n)
  return { lower, upper, rate: v / n }
}

const groupKey = (a: { network: string; format: string; dim: string }) => `${a.network}|${a.format}|${a.dim}`

/** Plain-English reason shown on the card. */
const where = (a: { network: string; format: string }) => (a.network === NETWORK_ALL ? `shared ${a.format}s` : `${a.network.charAt(0).toUpperCase()}${a.network.slice(1)}${a.format === 'post' ? '' : ` ${a.format}s`}`)
const kindName = (a: { dim: string }) => (a.dim === 'cover' ? 'picture design' : 'style')
const retireText = (a: Arm) => `Retired the ${a.value} ${kindName(a)} on ${where(a)}: ${a.n} sends, ${fmtNum(a.v)} ${a.v === 1 ? 'visit' : 'visits'}; will retest in ${UNRETIRE_AFTER_DAYS / 7} weeks.`
function fmtNum(x: number): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(1)
}

export interface DecideResult {
  state: OptimizerState
  decisions: Decision[]
}

/** Runs the weekly rules on the counted data: bring back old retirees, retire at most one arm per network per week, mark clear
 * winners, and propose posting windows. Returns a new state; the input is not changed. */
export function decide(state: OptimizerState, now: Date): DecideResult {
  const next: OptimizerState = { ...state, arms: Object.fromEntries(Object.entries(state.arms).map(([k, a]) => [k, { ...a }])), decisions: [...state.decisions], advice: { ...state.advice } }
  const made: Decision[] = []
  const nowIso = now.toISOString()
  const push = (d: Omit<Decision, 'at'>) => made.push({ at: nowIso, ...d })

  // (a) bring back arms retired long enough ago, as a fresh trial
  for (const a of Object.values(next.arms)) {
    if (a.status === 'retired' && a.retiredAt && now.getTime() - ms(a.retiredAt) >= UNRETIRE_AFTER_DAYS * DAY) {
      a.status = 'active'
      a.retiredAt = undefined
      a.since = nowIso
      a.n = 0
      a.v = 0
      a.l = 0
      a.winner = undefined
      push({ kind: 'unretire', network: a.network, format: a.format, dim: a.dim, value: a.value, text: `Brought back the ${a.value} ${kindName(a)} on ${where(a)} for a fresh test (it was retired ${UNRETIRE_AFTER_DAYS / 7} weeks ago).` })
    }
  }

  // (b) retire: at most one per network per week
  const groups = new Map<string, Arm[]>()
  for (const a of Object.values(next.arms)) {
    const k = groupKey(a)
    groups.set(k, [...(groups.get(k) ?? []), a])
  }
  const networks = [...new Set(Object.values(next.arms).map((a) => a.network))].sort()
  for (const net of networks) {
    const recent = Object.values(next.arms).filter((a) => a.network === net && a.retiredAt && now.getTime() - ms(a.retiredAt) < RETIRE_WINDOW_DAYS * DAY).length
    if (recent >= MAX_RETIRE_PER_NETWORK_PER_WEEK) continue
    let best: { arm: Arm; gap: number } | null = null
    for (const [k, arms] of [...groups].sort((x, y) => x[0].localeCompare(y[0]))) {
      if (!k.startsWith(`${net}|`)) continue
      const active = arms.filter((a) => a.status === 'active')
      if (active.length < MIN_ACTIVE_ARMS + 1) continue
      const solid = active.filter((a) => a.n >= MIN_ARM_SENDS)
      if (solid.length < 2) continue
      const top = [...solid].sort((a, b) => b.v / b.n - a.v / a.n || b.n - a.n)[0]
      const worst = [...solid].sort((a, b) => a.v / a.n - b.v / b.n || b.n - a.n)[0]
      if (top === worst) continue
      const gap = rateBounds(top.v, top.n).lower - rateBounds(worst.v, worst.n).upper
      if (gap > 0 && (!best || gap > best.gap)) best = { arm: worst, gap }
    }
    if (best) {
      best.arm.status = 'retired'
      best.arm.retiredAt = nowIso
      best.arm.winner = undefined
      push({ kind: 'retire', network: best.arm.network, format: best.arm.format, dim: best.arm.dim, value: best.arm.value, text: retireText(best.arm) })
    }
  }

  // (c) winners: one arm whose lower bound beats the upper bound of every other counted arm
  for (const [, arms] of groups) {
    const solid = arms.filter((a) => a.status === 'active' && a.n >= MIN_ARM_SENDS)
    for (const a of arms) {
      const was = a.winner === true
      const others = solid.filter((o) => o !== a)
      const wins = solid.includes(a) && others.length >= 1 && others.every((o) => rateBounds(a.v, a.n).lower > rateBounds(o.v, o.n).upper)
      a.winner = wins ? true : undefined
      if (wins && !was) push({ kind: 'winner', network: a.network, format: a.format, dim: a.dim, value: a.value, text: `The ${a.value} ${kindName(a)} is a clear winner on ${where(a)}: ${a.n} sends, ${fmtNum(a.v)} ${a.v === 1 ? 'visit' : 'visits'}. It is chosen more often, but never every time.` })
    }
  }

  // (d) posting windows: recommendation only
  for (const [net, cells] of Object.entries(next.time)) {
    const adv = bestWindow(cells)
    const before = next.advice[net]
    if (adv) {
      next.advice[net] = adv
      if (!before || before.bucket !== adv.bucket) push({ kind: 'window', network: net, format: 'post', dim: 'time', value: String(adv.bucket), text: adv.text })
    } else if (before) delete next.advice[net]
  }

  next.decisions = [...made, ...next.decisions].slice(0, MAX_DECISIONS)
  next.updatedAt = nowIso
  return { state: next, decisions: made }
}

/** The posting window that clearly beats all the others on one network, or null. Needs two windows with enough sends. */
export function bestWindow(cells: Readonly<Record<string, TimeCell>>): WindowAdvice | null {
  const solid = Object.entries(cells).filter(([, c]) => c.n >= MIN_WINDOW_SENDS)
  if (solid.length < 2) return null
  const [bk, bc] = [...solid].sort((a, b) => b[1].v / b[1].n - a[1].v / a[1].n)[0]
  const rest = Object.entries(cells).filter(([k]) => k !== bk).reduce((s, [, c]) => ({ n: s.n + c.n, v: s.v + c.v }), { n: 0, v: 0 })
  if (rest.n < MIN_WINDOW_SENDS) return null
  if (!(rateBounds(bc.v, bc.n).lower > rateBounds(rest.v, rest.n).upper)) return null
  const bucket = Number(bk)
  const label = bucketLabel(bucket)
  return { bucket, label, sends: bc.n, visits: Math.round(bc.v * 10) / 10, text: `Best posting window so far: ${label} (${bc.n} sends, ${fmtNum(Math.round(bc.v * 10) / 10)} visits, clearly ahead of the other times). Shown only; posts still go out when they are ready.` }
}

// ---------------------------------------------------------------------------------------------------------------------------
// 5. Steering (choosing a style)
// ---------------------------------------------------------------------------------------------------------------------------

/** One draw from Gamma(shape, 1) (Marsaglia and Tsang). Deterministic for a given `rand`. */
export function gammaSample(shape: number, rand: () => number): number {
  if (!(shape > 0)) return 0
  if (shape < 1) return gammaSample(shape + 1, rand) * Math.pow(Math.max(rand(), 1e-12), 1 / shape)
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (let i = 0; i < 100; i++) {
    const u1 = Math.max(rand(), 1e-12)
    const u2 = rand()
    const x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    const v = (1 + c * x) ** 3
    if (v <= 0) continue
    const u = Math.max(rand(), 1e-12)
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v
  }
  return d
}

const armFor = (state: OptimizerState, network: string, format: string, dim: Dim, value: string): Arm | undefined => state.arms[armKey(canonNetwork(network), format, dim, value)]

/** The values still allowed in the rotation: retired ones are left out. If that would leave nothing, the full list is returned. */
export function allowedValues<T extends string>(state: OptimizerState | null, network: string, format: string, dim: Dim, candidates: readonly T[]): T[] {
  if (!state) return [...candidates]
  const kept = candidates.filter((c) => armFor(state, network, format, dim, c)?.status !== 'retired')
  return kept.length ? kept : [...candidates]
}

/** A learned pick from `candidates`, or null meaning "use today's rotation". Steers only when two or more of the allowed values have
 * MIN_ARM_SENDS counted sends; then EXPLORE_FLOOR of the time it returns null on purpose. Thompson sampling: each value's visits per
 * send is drawn from Gamma(visits + prior, sends + prior sends), and the highest draw wins. */
export function steerPick<T extends string>(state: OptimizerState | null, network: string, format: string, dim: Dim, candidates: readonly T[], rand: () => number = Math.random): T | null {
  if (!state) return null
  const allowed = allowedValues(state, network, format, dim, candidates)
  if (allowed.length < 2) return null
  const arms = allowed.map((c) => ({ c, a: armFor(state, network, format, dim, c) }))
  if (arms.filter((x) => (x.a?.n ?? 0) >= MIN_ARM_SENDS).length < 2) return null
  if (rand() < EXPLORE_FLOOR) return null
  const totalN = arms.reduce((s, x) => s + (x.a?.n ?? 0), 0)
  const totalV = arms.reduce((s, x) => s + (x.a?.v ?? 0), 0)
  const pooled = totalN > 0 ? totalV / totalN : 0.05
  const priorN = 2
  const priorV = Math.max(pooled * priorN, 0.1)
  let best: T | null = null
  let bestDraw = -1
  for (const { c, a } of arms) {
    const draw = gammaSample(priorV + (a?.v ?? 0), rand) / (priorN + (a?.n ?? 0))
    if (draw > bestDraw) {
      bestDraw = draw
      best = c
    }
  }
  return best
}

/** The hooks object assignHookStyles (lib/caption-plan.ts) accepts. Both calls fail open: any error means "use the rotation". */
export function makeHookSteer(state: OptimizerState | null, format: string, rand: () => number = Math.random) {
  if (!state) return undefined
  return {
    allowed: <T extends string>(network: string, styles: readonly T[]): readonly T[] => {
      try {
        return allowedValues(state, network, format, 'hook', styles)
      } catch {
        return styles
      }
    },
    pick: <T extends string>(network: string, free: readonly T[]): T | null => {
      try {
        return steerPick(state, network, format, 'hook', free, rand)
      } catch {
        return null
      }
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// 6. Summary for the admin card and the digest
// ---------------------------------------------------------------------------------------------------------------------------

export interface ArmView {
  network: string
  format: string
  dim: Dim
  value: string
  sends: number
  visits: number
  perSend: number | null
  status: 'active' | 'retired' | 'exploring'
  winner: boolean
  retestOn: string | null
}
export interface OptimizerSummary {
  arms: ArmView[]
  decisions: Decision[]
  advice: { network: string; text: string }[]
  retired: number
  winners: number
  /** true when no group has two values with MIN_ARM_SENDS sends yet, so nothing is steered or retired. */
  needMoreData: boolean
  minSends: number
  unmeasured: number
  updatedAt: string | null
}

export function summarize(state: OptimizerState | null): OptimizerSummary {
  if (!state) return { arms: [], decisions: [], advice: [], retired: 0, winners: 0, needMoreData: true, minSends: MIN_ARM_SENDS, unmeasured: 0, updatedAt: null }
  const arms: ArmView[] = Object.values(state.arms)
    .map((a) => ({
      network: a.network, format: a.format, dim: a.dim, value: a.value, sends: a.n, visits: Math.round(a.v * 10) / 10,
      perSend: a.n > 0 ? Math.round((a.v / a.n) * 100) / 100 : null,
      status: (a.status === 'retired' ? 'retired' : a.n < MIN_ARM_SENDS ? 'exploring' : 'active') as ArmView['status'],
      winner: a.winner === true,
      retestOn: a.status === 'retired' && a.retiredAt ? new Date(ms(a.retiredAt) + UNRETIRE_AFTER_DAYS * DAY).toISOString().slice(0, 10) : null,
    }))
    .sort((x, y) => x.network.localeCompare(y.network) || x.format.localeCompare(y.format) || x.dim.localeCompare(y.dim) || y.sends - x.sends || x.value.localeCompare(y.value))
  const solidPerGroup = new Map<string, number>()
  for (const a of Object.values(state.arms)) if (a.status === 'active' && a.n >= MIN_ARM_SENDS) solidPerGroup.set(groupKey(a), (solidPerGroup.get(groupKey(a)) ?? 0) + 1)
  return {
    arms,
    decisions: state.decisions.slice(0, 10),
    advice: Object.entries(state.advice).map(([network, a]) => ({ network, text: a.text })),
    retired: arms.filter((a) => a.status === 'retired').length,
    winners: arms.filter((a) => a.winner).length,
    needMoreData: ![...solidPerGroup.values()].some((c) => c >= 2),
    minSends: MIN_ARM_SENDS,
    unmeasured: state.unmeasured,
    updatedAt: state.updatedAt,
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// 7. Title and meta candidates (feeds the existing click-rate loop; see lib/ctr-loop.ts)
// ---------------------------------------------------------------------------------------------------------------------------

/** Pages need at least this many Google impressions before their click rate is judged. */
export const TITLE_MIN_IMPRESSIONS = 100
/** The site median is only trusted when at least this many pages have enough impressions. */
export const TITLE_MIN_PAGES = 8
/** A page is a candidate only when its click rate is below this share of the site median... */
export const TITLE_BELOW_MEDIAN = 0.75
/** ...and at the median rate it would have earned at least this many more clicks than it got. */
export const TITLE_MIN_LOST_CLICKS = 2

export interface CtrCandidate {
  path: string
  clicks: number
  impressions: number
  position: number
  ctr: number
  expected: number
  ratio: number
  lostClicks: number
}

/** Pages with at least 100 impressions and a click rate clearly below the site median, biggest gap first. Returns [] when fewer than
 * TITLE_MIN_PAGES pages have enough impressions (no reliable median). Missing numbers (null) skip the page, never count as zero.
 * `maxPosition`: a title cannot rescue a page that ranks far down, so those are left out (default 15, same as the click-rate loop). */
export function belowMedianCtr(rows: readonly { path: string; clicks: number | null; impressions: number | null; position: number | null }[], opts: { maxPosition?: number } = {}): CtrCandidate[] {
  const maxPos = opts.maxPosition ?? 15
  const seen = new Set<string>()
  const ok: CtrCandidate[] = []
  for (const r of rows) {
    if (r.clicks === null || r.impressions === null || r.clicks === undefined || r.impressions === undefined) continue
    const clicks = Number(r.clicks)
    const impressions = Number(r.impressions)
    if (!r.path || seen.has(r.path) || !Number.isFinite(clicks) || !Number.isFinite(impressions) || impressions < TITLE_MIN_IMPRESSIONS) continue
    seen.add(r.path)
    const position = r.position === null || r.position === undefined ? NaN : Number(r.position)
    ok.push({ path: r.path, clicks, impressions, position, ctr: clicks / impressions, expected: 0, ratio: 0, lostClicks: 0 })
  }
  if (ok.length < TITLE_MIN_PAGES) return []
  const sorted = ok.map((r) => r.ctr).sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  if (!(median > 0)) return []
  return ok
    .filter((r) => Number.isFinite(r.position) && r.position >= 1 && r.position <= maxPos && r.ctr < median * TITLE_BELOW_MEDIAN && median * r.impressions - r.clicks >= TITLE_MIN_LOST_CLICKS)
    .map((r) => ({ ...r, expected: median, ratio: r.ctr / median, lostClicks: median * r.impressions - r.clicks }))
    .sort((a, b) => b.lostClicks - a.lostClicks)
}
