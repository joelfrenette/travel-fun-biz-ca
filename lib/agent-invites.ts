import { randomBytes } from 'node:crypto'

// Agent submission links (growth loop WP13): the PURE rules. A link is a random token Joel sends to an outside
// agent. The agent opens /submit-trip/<token> without a login, starts a DRAFT (a trip name), and comes back and forth
// on that same draft: adds sources one at a time (a screenshot, a PDF, a link, text), sees which parts of the trip
// page are now filled, fixes the plain text fields by hand, and only when ready clicks "Send to Joel for review".
// Until then the draft is `in_progress`; after sending it is `submitted` and locked. Everything here is plain code
// with no database, no network and no clock of its own, so it can be checked offline (scripts/check-agent-invites.ts).
// The database side is lib/agent-submissions.ts.

export const TOKEN_LENGTH = 32
export const DEFAULT_EXPIRY_DAYS = 30
export const MAX_EXPIRY_DAYS = 90
/** New drafts one link accepts in any rolling 24 hours. */
export const MAX_DRAFTS_PER_DAY = 5
/** Sources (each costs an AI read) one link accepts in any rolling 24 hours, across all its drafts. */
export const MAX_SOURCES_PER_DAY = 10
/** Drafts one link accepts in its whole life (the default; an admin may choose less, or up to MAX_TOTAL_CAP). */
export const MAX_TOTAL = 20
export const MAX_TOTAL_CAP = 50
/** Sources on one draft in all (a draft also holds at most 5 screenshots, from the WP11 rule). */
export const MAX_SOURCES_PER_DRAFT = 8
export const DAY_MS = 86_400_000

/** Largest request body a public submission may carry. A request to the server is limited to about 4.5 MB on Vercel, and
 * the agent page has no direct-to-storage path, so one file (or a set dropped together) must stay under this in total. */
export const AGENT_FILES_MAX_BYTES = 4 * 1024 * 1024
export const AGENT_TEXT_MAX_CHARS = 160_000
export const AGENT_TEXT_MIN_CHARS = 40

/** 32 url-safe characters from 24 random bytes (192 bits). `bytes` is injectable for tests. */
export function generateToken(bytes: (n: number) => Buffer = randomBytes): string {
  return bytes(24).toString('base64url')
}

/** True only for something that could be a token we issued. Checked before any database lookup. */
export function isTokenFormat(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32}$/.test(value)
}

/** True for an id we could have issued (a uuid). Checked before any database lookup. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

export function clampDays(days: unknown): number {
  const n = typeof days === 'number' ? days : Number(days)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_EXPIRY_DAYS
  return Math.min(MAX_EXPIRY_DAYS, Math.floor(n))
}

export function clampMaxUses(max: unknown): number {
  const n = typeof max === 'number' ? max : Number(max)
  if (!Number.isFinite(n) || n < 1) return MAX_TOTAL
  return Math.min(MAX_TOTAL_CAP, Math.floor(n))
}

export function expiryFrom(now: Date, days: number): Date {
  return new Date(now.getTime() + clampDays(days) * DAY_MS)
}

export interface InviteLike {
  expires_at: string | Date
  revoked_at: string | Date | null
  uses: number
  max_uses: number
}

export type InviteBlock = 'revoked' | 'expired' | 'used-up'

/** Is this link usable right now? Revoked wins over expired, expired over used up. `uses` counts drafts started. */
export function inviteState(invite: InviteLike, now: Date): { ok: true } | { ok: false; reason: InviteBlock } {
  if (invite.revoked_at) return { ok: false, reason: 'revoked' }
  if (new Date(invite.expires_at).getTime() <= now.getTime()) return { ok: false, reason: 'expired' }
  if (invite.uses >= invite.max_uses) return { ok: false, reason: 'used-up' }
  return { ok: true }
}

/** A link that has expired or been revoked can no longer be used at all. A link that has only used up its drafts can
 * still be used to keep working on (and send) the drafts it already has: only STARTING a new draft is blocked. */
export function canWorkOnExisting(invite: InviteLike, now: Date): { ok: true } | { ok: false; reason: 'revoked' | 'expired' } {
  const s = inviteState({ ...invite, uses: 0 }, now)
  return s.ok ? s : { ok: false, reason: s.reason as 'revoked' | 'expired' }
}

/** What the agent is told. Plain, and it never says anything about Joel's data. */
export function blockMessage(reason: InviteBlock): string {
  if (reason === 'expired') return 'This link has expired. Ask Joel for a new one.'
  if (reason === 'used-up') return 'This link has reached the number of trips it can take. Ask Joel for a new one.'
  return 'This link is no longer active. Ask Joel for a new one.'
}

/** How many of these timestamps fall inside the rolling window ending at `now`. */
export function countInWindow(createdAts: (string | number | Date)[], now: Date, windowMs = DAY_MS): number {
  const from = now.getTime() - windowMs
  let n = 0
  for (const t of createdAts) {
    const ms = new Date(t).getTime()
    if (Number.isFinite(ms) && ms > from && ms <= now.getTime()) n++
  }
  return n
}

/**
 * The per-day limiter: `limit` events in any rolling 24 hours. `nextAt` is when the oldest counted event leaves the
 * window (so the agent can be told when to try again), or null when there is room.
 */
export function dailyAllowance(createdAts: (string | number | Date)[], now: Date, limit = MAX_DRAFTS_PER_DAY): { allowed: boolean; used: number; left: number; nextAt: Date | null } {
  const from = now.getTime() - DAY_MS
  const inside = createdAts.map((t) => new Date(t).getTime()).filter((ms) => Number.isFinite(ms) && ms > from && ms <= now.getTime()).sort((a, b) => a - b)
  const used = inside.length
  const left = Math.max(0, limit - used)
  const nextAt = left > 0 ? null : new Date(inside[used - limit] + DAY_MS)
  return { allowed: left > 0, used, left, nextAt }
}

export function limitMessage(what: 'drafts' | 'sources', nextAt: Date | null): string {
  const when = nextAt ? ` You can try again after ${nextAt.toUTCString().replace(/ GMT$/, ' UTC')}.` : ''
  return what === 'drafts' ? `This link has started as many trips as it can in one day.${when}` : `This link has added as many sources as it can in one day.${when}`
}

// ─── The draft's life ────────────────────────────────────────────────────────────

export type SubmissionState = 'in_progress' | 'submitted' | 'rejected' | 'approved'

/** The agent may change the draft only while it is theirs: not yet sent, or sent back. */
export function isEditableState(state: SubmissionState): boolean {
  return state === 'in_progress' || state === 'rejected'
}

/** Sending needs at least one source that was read (so Joel has something to review) and an unlocked draft. */
export function canSend(state: SubmissionState, readSources: number): { ok: true } | { ok: false; reason: string } {
  if (!isEditableState(state)) return { ok: false, reason: state === 'approved' ? 'Joel already published this trip.' : 'This trip was already sent to Joel.' }
  if (readSources < 1) return { ok: false, reason: 'Add at least one screenshot, PDF, link or text, and let it be read, before you send.' }
  return { ok: true }
}

export const STATE_LABEL: Record<SubmissionState, string> = {
  in_progress: 'Draft, still yours',
  submitted: 'Sent: Joel is reviewing',
  rejected: 'Sent back by Joel',
  approved: 'Published by Joel',
}

// ─── The forms ───────────────────────────────────────────────────────────────────

/** Trims, removes control characters and caps a free text field. Not HTML escaping: React and the admin escape on display. */
export function cleanText(value: unknown, max: number, multiline = false): string {
  if (typeof value !== 'string') return ''
  const stripped = multiline ? value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '') : value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ')
  return stripped.trim().slice(0, max)
}

/** Starting a draft needs only a trip name. */
export function validateStart(input: { tripName?: unknown; destination?: unknown; message?: unknown }): { ok: true; value: { tripName: string; destination: string; message: string } } | { ok: false; errors: string[] } {
  const tripName = cleanText(input.tripName, 120)
  const destination = cleanText(input.destination, 120)
  const message = cleanText(input.message, 1500, true)
  if (tripName.length < 3) return { ok: false, errors: ['Please type the trip name (at least 3 letters).'] }
  return { ok: true, value: { tripName, destination, message } }
}

export interface SourceInput {
  url?: unknown
  text?: unknown
  fileCount?: number
}

/** One source per request: a file (or a set of screenshots dropped together), OR a link, OR pasted text. */
export function validateSource(input: SourceInput): { ok: true; value: { kind: 'file' | 'url' | 'text'; url: string; text: string } } | { ok: false; errors: string[] } {
  const url = cleanText(input.url, 2000)
  const text = cleanText(input.text, AGENT_TEXT_MAX_CHARS, true)
  const files = input.fileCount ?? 0
  const given = [files > 0, !!url, !!text].filter(Boolean).length
  if (given === 0) return { ok: false, errors: ['Add a screenshot or PDF, a link, or some pasted text.'] }
  if (given > 1) return { ok: false, errors: ['Add one thing at a time: a file, a link, or some text. You can add more afterwards.'] }
  if (url) {
    let parsed: URL | null = null
    try {
      parsed = new URL(url)
    } catch {
      parsed = null
    }
    if (!parsed || parsed.protocol !== 'https:') return { ok: false, errors: ['The link must be a full web address that starts with https://'] }
    return { ok: true, value: { kind: 'url', url, text: '' } }
  }
  if (text) {
    if (text.length < AGENT_TEXT_MIN_CHARS) return { ok: false, errors: ['Please paste a few more words about the trip.'] }
    return { ok: true, value: { kind: 'text', url: '', text } }
  }
  return { ok: true, value: { kind: 'file', url: '', text: '' } }
}

/** The text fields an agent may edit by hand, and how each is stored. Everything else (prices, links, slug, status...) is Joel's. */
export const EDITABLE_FIELDS = ['name', 'destination', 'short_description', 'highlights', 'price_includes', 'dates_note'] as const
export type EditableField = (typeof EDITABLE_FIELDS)[number]

export interface DraftEdits {
  /** Columns of the trip page to write. */
  columns: { name?: string; destination?: string; short_description?: string; highlights?: string[]; price_includes?: string }
  /** The free-text dates note, kept on the submission (not a structured date: only Joel's grounded flow sets those). */
  datesNote?: string
}

function lines(value: unknown, maxItems: number, maxLen: number): string[] {
  const raw = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : typeof value === 'string' ? value.split('\n') : []
  return raw.map((l) => cleanText(l, maxLen)).filter(Boolean).slice(0, maxItems)
}

/** Whitelists and cleans the agent's edits. Unknown keys are ignored; a name must keep 3+ letters. */
export function cleanDraftEdits(input: Record<string, unknown>): { ok: true; value: DraftEdits } | { ok: false; errors: string[] } {
  const columns: DraftEdits['columns'] = {}
  const out: DraftEdits = { columns }
  if ('name' in input) {
    const name = cleanText(input.name, 120)
    if (name.length < 3) return { ok: false, errors: ['The trip name needs at least 3 letters.'] }
    columns.name = name
  }
  if ('destination' in input) columns.destination = cleanText(input.destination, 120)
  if ('short_description' in input) columns.short_description = cleanText(input.short_description, 600, true)
  if ('highlights' in input) columns.highlights = lines(input.highlights, 12, 160)
  if ('price_includes' in input) columns.price_includes = lines(input.price_includes, 20, 160).join('\n')
  if ('dates_note' in input) out.datesNote = cleanText(input.dates_note, 120)
  return { ok: true, value: out }
}

// ─── What the agent sees of the draft ───────────────────────────────────────────

/** Fields whose VALUES the agent never sees back (the agent can see that a price was found, not what it is). */
export const HIDDEN_VALUE_FIELDS = new Set(['price_display', 'price_value', 'currency', 'price_on_request'])

/** Plain names for the parts of a trip page the agent's view lists. A field not listed here is never shown to an agent. */
export const AGENT_FIELD_LABELS: Record<string, string> = {
  name: 'Trip name',
  destination: 'Destination',
  country: 'Country',
  region: 'Region',
  duration: 'Length of the trip',
  duration_days: 'Length of the trip',
  price_display: 'Price',
  price_value: 'Price',
  price_on_request: 'Price',
  currency: 'Price',
  available_from: 'First date',
  available_to: 'Last date',
  departure_dates: 'Departure dates',
  price_includes: 'What is included',
  not_included: 'What is not included',
  max_people: 'Group size',
  min_people: 'Group size',
  booking_url: 'Booking link',
  more_info_url: 'More info link',
  category: 'Category',
  itinerary: 'Day by day plan',
  full_description: 'Trip description',
  short_description: 'Short description',
  highlights: 'Highlights',
  ai_faqs: 'Questions and answers',
  gallery_urls: 'Photos',
  image_url: 'Cover photo',
  meta_title: 'Search title',
  meta_description: 'Search description',
  keywords: 'Keywords',
}

/** The unique, plain names for the fields that were filled in. Unknown fields are dropped. */
export function filledLabels(fields: string[]): string[] {
  const out: string[] = []
  for (const f of fields) {
    const label = AGENT_FIELD_LABELS[f]
    if (label && !out.includes(label)) out.push(label)
  }
  return out
}

export interface AgentFieldView {
  key: string
  label: string
  filled: boolean
  /** Null when empty or when the value is hidden from the agent (prices). */
  value: string | null
  hidden?: boolean
}

/** The fields shown on the agent's page, in order. Values come from the agent's OWN draft row; prices show only "found". */
export const AGENT_VIEW_FIELDS = ['name', 'destination', 'short_description', 'highlights', 'price_includes', 'not_included', 'duration', 'available_from', 'available_to', 'price_display', 'full_description', 'itinerary', 'image_url', 'gallery_urls'] as const

function asText(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) {
    const parts = v
      .map((x) => {
        if (x && typeof x === 'object') {
          const o = x as { day?: number | null; title?: string; description?: string }
          return `${o.day != null ? `Day ${o.day}: ` : ''}${o.title ?? ''}${o.description ? `. ${o.description}` : ''}`.trim()
        }
        return String(x)
      })
      .filter(Boolean)
    return parts.length ? parts.join('\n') : null
  }
  return null
}

/** Builds the agent's view of its draft from the trip row. Other trips and admin-only columns can never appear: only these keys are read. */
export function agentFieldViews(row: Record<string, unknown>): AgentFieldView[] {
  return AGENT_VIEW_FIELDS.map((key) => {
    // "Price on request" counts as the price being found (the agent still never sees a value).
    const text = asText(row[key]) ?? (key === 'price_display' && row.price_on_request === true ? 'on request' : null)
    const hidden = HIDDEN_VALUE_FIELDS.has(key)
    // Photos are shown as "found", not as addresses.
    const isMedia = key === 'image_url' || key === 'gallery_urls'
    return { key, label: AGENT_FIELD_LABELS[key] ?? key, filled: !!text, value: hidden || isMedia ? null : text, ...(hidden || isMedia ? { hidden: true } : {}) }
  })
}

// ─── Fix round 1 rules (pure) ───────────────────────────────────────────────────────

/** An agent may write to a trip only while the trip itself is still a draft. Once it is published (or archived) every
 * agent write is refused, whatever the submission row says. Null = allowed. */
export function agentWriteBlock(packageStatus: unknown): string | null {
  return packageStatus === 'draft' ? null : 'Joel already published this trip, so it cannot be changed from this page.'
}

/** Which of Joel's decisions are allowed from a submission state. Reject only before a decision; approve unless done. */
export function decisionAllowed(state: SubmissionState, action: 'approve' | 'reject'): { ok: true } | { ok: false; reason: string } {
  if (action === 'reject') return state === 'submitted' || state === 'in_progress' ? { ok: true } : { ok: false, reason: state === 'approved' ? 'This trip is already published, so it cannot be sent back.' : 'This trip was already sent back.' }
  return state === 'approved' ? { ok: false, reason: 'This trip is already published.' } : { ok: true }
}

/** Rows the site writes for its own bookkeeping (automatic FAQs, own photos, the recap log). They are not things the
 * agent added, so they never count against the agent's limits and never show on their page. */
export function isHelperSource(fileName: string | null | undefined): boolean {
  return /^(Automatic FAQs|Photos added|Recap log)/i.test(fileName ?? '')
}

export const GALLERY_MAX = 12
export const PHOTOS_PER_CALL = 6
/** Per-link daily ceiling on photos stored. */
export const MAX_PHOTOS_PER_DAY = 20

/** How many of `valid` uploads will fit: the gallery room, and the per-call limit. Zero means refuse before any work. */
export function photoRoom(galleryCount: number, valid: number): number {
  return Math.max(0, Math.min(valid, PHOTOS_PER_CALL, GALLERY_MAX - galleryCount))
}
