import { hasRecap, isPastTrip, normaliseRecapMode, todayYmd } from '@/lib/past-trip'
import type { RecapNote } from '@/lib/recap-composer'

// Recap Studio: the PURE rules. No database, no network, no clock of its own, so scripts/check-recap-studio.ts can
// prove them offline. The database side is lib/recap-store.ts; the draft writer is lib/recap-draft.ts.
//
// The promise behind all of it: never invent an experience, a quote, a name, a date or a price. A recap is built
// only from what a person typed, what a person ticked consent for, and what the trip record already says.

export const DAY_MS = 86_400_000

// ─── The five questions ─────────────────────────────────────────────────────────────────

export const QUESTION_IDS = ['best', 'meal', 'tip', 'suits', 'surprise'] as const
export type QuestionId = (typeof QUESTION_IDS)[number]
export type StudioAnswers = Partial<Record<QuestionId, string>>

export const QUESTIONS: { id: QuestionId; label: string; hint: string }[] = [
  { id: 'best', label: 'What was the best moment?', hint: 'One or two sentences is plenty.' },
  { id: 'meal', label: 'What was a favourite meal or place?', hint: 'Say what you ate or where you were.' },
  { id: 'tip', label: 'What is a tip for next time?', hint: 'Something that would help the next group.' },
  { id: 'suits', label: 'Who is this trip a good fit for?', hint: 'For example solo travellers, friends, or people who like to relax.' },
  { id: 'surprise', label: 'What was a surprise?', hint: 'Something you did not expect.' },
]

export const ANSWER_MAX = 400
export const QUOTE_MIN = 12
export const QUOTE_MAX = 400
export const NAME_MAX = 40

/** Trims, strips control characters and caps. Not HTML escaping: React escapes on display. */
export function cleanText(value: unknown, max: number, multiline = false): string {
  if (typeof value !== 'string') return ''
  const stripped = multiline ? value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '') : value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ')
  return stripped.trim().slice(0, max)
}

const PHONE_RE = /\+?\d(?:[\s().-]{0,2}\d){6,}/g
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/
const LINK_RE = /https?:\/\/|\bwww\.|\.(?:com|ca|net|org)\b/i

/** True when the text holds a phone number, an email address or a web address. Hosts' and guests' contact details never
 * go on the site (the only number on it is the site's own), so a submission with one is sent back with a plain note. */
export function containsContact(text: string): boolean {
  return phoneLike(text).length > 0 || EMAIL_RE.test(text) || LINK_RE.test(text)
}

/** Runs of 7 or more digits that look like a phone number. An ISO date (2026-05-12) is not one. */
export function phoneLike(text: string): string[] {
  return (text.match(PHONE_RE) ?? []).filter((m) => !/^\d{4}-\d{2}-\d{2}$/.test(m.trim()))
}

export const CONTACT_MESSAGE = 'Please leave out phone numbers, email addresses and web links. We add our own contact details to the page.'

/** The text with an em or en dash removed (house style has none). */
export function noDashes(text: string): string {
  return text.replace(/(?<=\w)\u2013(?=\w)/g, '-').replace(/\s*[\u2014\u2013]\s*/g, ', ').replace(/\s--\s/g, ', ')
}

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] }

/** The five answers. Unknown keys are dropped. At least one answer is needed. Contact details are refused. */
export function validateAnswers(input: unknown): Validated<StudioAnswers> {
  const src = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const out: StudioAnswers = {}
  const errors: string[] = []
  for (const q of QUESTIONS) {
    const raw = cleanText(src[q.id], ANSWER_MAX + 1, true)
    if (!raw) continue
    if (raw.length > ANSWER_MAX) {
      errors.push(`"${q.label}" is longer than ${ANSWER_MAX} characters. One or two sentences is enough.`)
      continue
    }
    if (containsContact(raw)) {
      errors.push(`"${q.label}": ${CONTACT_MESSAGE}`)
      continue
    }
    out[q.id] = noDashes(raw)
  }
  if (errors.length) return { ok: false, errors }
  if (Object.keys(out).length === 0) return { ok: false, errors: ['Please answer at least one question.'] }
  return { ok: true, value: out }
}

export const filledAnswerCount = (a: StudioAnswers | null | undefined): number => QUESTION_IDS.filter((id) => (a?.[id] ?? '').trim().length > 0).length

// ─── Quotes ─────────────────────────────────────────────────────────────────────────────

export interface Quote {
  /** What the traveller said, as they wrote it (dashes removed). */
  text: string
  /** "Sam T.": first name and one initial. Never a full surname. */
  name: string
}

/** "Sam" + "Turner" -> "Sam T."; no last name -> "Sam". Letters, spaces, apostrophes and hyphens only. */
export function displayName(first: unknown, last: unknown): string | null {
  const f = cleanText(first, NAME_MAX).replace(/[^\p{L}'’ -]/gu, '').trim()
  if (f.length < 1) return null
  const firstOnly = f.split(/\s+/)[0]
  const l = cleanText(last, NAME_MAX).replace(/[^\p{L}]/gu, '')
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  return l ? `${cap(firstOnly)} ${l.charAt(0).toUpperCase()}.` : cap(firstOnly)
}

export interface QuoteInput {
  text?: unknown
  firstName?: unknown
  lastName?: unknown
  /** The "I have this person's permission" (or, on the traveller's own page, "you may show this") tick. Must be exactly true. */
  consent?: unknown
}

/** A quote needs the consent tick, a first name, and 12 to 400 characters with no contact details. */
export function validateQuote(input: QuoteInput): Validated<Quote & { consent: true }> {
  const errors: string[] = []
  if (input.consent !== true) errors.push('Please tick the box to confirm you have this person\'s permission to show their words.')
  const name = displayName(input.firstName, input.lastName)
  if (!name) errors.push('Please add a first name.')
  const text = noDashes(cleanText(input.text, QUOTE_MAX + 1, true).replace(/^["“”']+|["“”']+$/g, '').trim())
  if (text.length < QUOTE_MIN) errors.push(`The quote needs at least ${QUOTE_MIN} characters.`)
  else if (text.length > QUOTE_MAX) errors.push(`The quote is longer than ${QUOTE_MAX} characters. A short one works best.`)
  else if (containsContact(text)) errors.push(CONTACT_MESSAGE)
  if (errors.length || !name) return { ok: false, errors }
  return { ok: true, value: { text, name, consent: true } }
}

// ─── Photos ─────────────────────────────────────────────────────────────────────────────

export const PHOTO_MAX_BYTES = 12 * 1024 * 1024
export const PHOTOS_MAX = 20
export const GALLERY_PICK = 12

export type ImageKind = { mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic'; ext: 'jpg' | 'png' | 'webp' | 'heic' }

/** Real image type from the first bytes, never from the file name or the type the browser claims. */
export function detectImage(buf: Buffer): ImageKind | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return { mime: 'image/png', ext: 'png' }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' }
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' }
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp' && /^(?:heic|heix|hevc|hevx|mif1|msf1|heim|heis)$/.test(buf.toString('latin1', 8, 12))) return { mime: 'image/heic', ext: 'heic' }
  return null
}

/** Checks the claims made BEFORE an upload (name, size). The real type check is detectImage on the stored bytes. */
export function validatePhotoClaim(input: { name?: unknown; size?: unknown }, alreadyHave: number): Validated<{ name: string; size: number }> {
  const name = cleanText(input.name, 120)
  const size = typeof input.size === 'number' ? input.size : Number(input.size)
  if (!/\.(?:jpe?g|png|webp|heic|heif)$/i.test(name)) return { ok: false, errors: ['Only JPG, PNG, WebP and HEIC photos can be sent.'] }
  if (!Number.isFinite(size) || size <= 0) return { ok: false, errors: ['That photo looks empty.'] }
  if (size > PHOTO_MAX_BYTES) return { ok: false, errors: ['That photo is over 12 MB. Please send a smaller copy.'] }
  if (alreadyHave >= PHOTOS_MAX) return { ok: false, errors: [`You can send up to ${PHOTOS_MAX} photos in all.`] }
  return { ok: true, value: { name, size } }
}

/** Alt text that names only what the record says (the trip and its place), never what is in the picture. */
export function altTextFor(tripName: string, destination: string | null | undefined, index: number): string {
  const place = (destination ?? '').trim()
  return `Photo ${index + 1} from the ${tripName.trim()} trip${place ? ` in ${place}` : ''}`
}

/** Variance of a Laplacian over a grey image (row-major, 0 to 255): higher is sharper. The browser draws the photo small on
 * a canvas, turns it grey and calls this. Pure so it can be checked offline. */
export function laplacianVariance(gray: ArrayLike<number>, w: number, h: number): number {
  if (w < 3 || h < 3 || gray.length < w * h) return 0
  let sum = 0
  let sumSq = 0
  let n = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w]
      sum += v
      sumSq += v * v
      n++
    }
  }
  if (n === 0) return 0
  const mean = sum / n
  return sumSq / n - mean * mean
}

export interface PhotoFacts {
  id: string
  bytes: number
  width: number | null
  height: number | null
  /** laplacianVariance of a small grey copy; null when it could not be measured. */
  sharpness: number | null
}

/** 0 to 1. Size counts for half (up to 3 MB), sharpness for half (a variance of 400 counts as fully sharp). A tiny picture scores 0. */
export function photoScore(p: PhotoFacts): number {
  const px = p.width && p.height ? p.width * p.height : null
  if (px !== null && px < 300_000) return 0
  const size = Math.min(1, p.bytes / (3 * 1024 * 1024))
  const sharp = p.sharpness === null ? 0.5 : Math.min(1, p.sharpness / 400)
  return Math.round((size * 0.5 + sharp * 0.5) * 1000) / 1000
}

/** The best `n` photos (default 12) by photoScore, shown in their original order. Drops exact repeats (same size and shape). */
export function pickBestPhotos(photos: PhotoFacts[], n = GALLERY_PICK): string[] {
  const seen = new Set<string>()
  const unique = photos.filter((p) => {
    const key = `${p.bytes}:${p.width}x${p.height}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const best = unique
    .map((p, order) => ({ p, order, score: photoScore(p) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, n)
  return best.sort((a, b) => a.order - b.order).map((x) => x.p.id)
}

/** Puts `coverId` first and keeps the rest in order; an id not in the list is ignored. */
export function orderWithCover(ids: string[], coverId: string | null | undefined): string[] {
  if (!coverId || !ids.includes(coverId)) return ids
  return [coverId, ...ids.filter((i) => i !== coverId)]
}

// ─── Notes for the writer ───────────────────────────────────────────────────────────────

/** The answers as notes the recap writer already understands (RecapNote). They carry no date: nothing is guessed. */
export function answersToNotes(answers: StudioAnswers | null | undefined): RecapNote[] {
  return QUESTIONS.filter((q) => (answers?.[q.id] ?? '').trim()).map((q) => ({ date: '', title: q.label.replace(/\?$/, ''), body: (answers?.[q.id] ?? '').trim() }))
}

/** The first sentence of the recap: the "Quick answer" an assistant or a search box can lift. */
export function firstSentence(summary: string): string {
  const flat = summary.replace(/\s+/g, ' ').trim()
  const m = /^(.+?[.!?])(?:\s|$)/.exec(flat)
  return (m ? m[1] : flat).trim()
}

// ─── The score ──────────────────────────────────────────────────────────────────────────

export interface RecapScoreInput {
  photoCount: number
  hasCover: boolean
  answersFilled: number
  hasSummary: boolean
  faqCount: number
  approvedQuotes: number
}

export interface ChecklistItem {
  id: string
  label: string
  done: boolean
  points: number
}

export const RECAP_THIN_BELOW = 60

/** The Recap score, 0 to 100, with the checklist behind it. Photos 25 (3+ is 15, 8+ adds 10), a cover 5, answers 4 each (20), the
 * written recap 25, 6 FAQs 15 (3+ is 8), one approved quote 10. */
export function recapChecklist(i: RecapScoreInput): { score: number; thin: boolean; items: ChecklistItem[] } {
  const items: ChecklistItem[] = [
    { id: 'photos3', label: 'At least 3 photos', done: i.photoCount >= 3, points: 15 },
    { id: 'photos8', label: '8 or more photos', done: i.photoCount >= 8, points: 10 },
    { id: 'cover', label: 'A cover photo is chosen', done: i.hasCover, points: 5 },
    { id: 'answers', label: `Questions answered (${Math.min(5, i.answersFilled)} of 5)`, done: i.answersFilled >= 5, points: Math.min(5, i.answersFilled) * 4 },
    { id: 'summary', label: 'The recap is written and live', done: i.hasSummary, points: 25 },
    { id: 'faqs', label: '6 questions and answers (FAQ)', done: i.faqCount >= 6, points: i.faqCount >= 6 ? 15 : i.faqCount >= 3 ? 8 : 0 },
    { id: 'quote', label: 'A traveller quote with permission', done: i.approvedQuotes >= 1, points: 10 },
  ]
  const score = Math.min(100, items.reduce((n, x) => n + (x.done || x.id === 'answers' || x.id === 'faqs' ? x.points : 0), 0))
  return { score, thin: score < RECAP_THIN_BELOW, items }
}

export const recapScore = (i: RecapScoreInput): number => recapChecklist(i).score

// ─── The daily prompt ───────────────────────────────────────────────────────────────────

export const SNOOZE_DAYS = 7
export const recapSnoozeKey = (packageId: string) => `recap_snooze:${packageId}`

export interface DueRow {
  id: string
  slug: string
  name: string
  status: string
  available_to: string | null
  recap_mode?: string | null
  recap_summary?: string | null
  gallery_urls?: string[] | null
  ai_faqs?: unknown
}

export type DueReason = 'no-recap' | 'thin'

export interface DueTrip {
  id: string
  slug: string
  name: string
  available_to: string | null
  reason: DueReason
  /** The plain words for why it is on the list. */
  why: string
  /** The Recap Studio page for this trip (a site path). */
  href: string
}

export const studioPath = (packageId: string) => `/admin/packages/${packageId}/recap`

const faqsIn = (faqs: unknown): number => (Array.isArray(faqs) ? faqs.filter((f) => f && typeof f === 'object' && typeof (f as { question?: unknown }).question === 'string' && typeof (f as { answer?: unknown }).answer === 'string').length : 0)

/** Why a past trip still needs the Studio, or null when it is in good shape. A trip with no recap always needs it; one with a recap
 * is "thin" when it has fewer than 3 gallery photos or fewer than 3 FAQs. */
export function recapThinReason(row: DueRow): { reason: DueReason; why: string } | null {
  if (!hasRecap(row)) return { reason: 'no-recap', why: 'no recap yet' }
  const gallery = (row.gallery_urls ?? []).filter((u) => typeof u === 'string' && u.trim()).length
  const faqs = faqsIn(row.ai_faqs)
  const gaps = [gallery < 3 ? `only ${gallery} photo${gallery === 1 ? '' : 's'}` : '', faqs < 3 ? `${faqs === 0 ? 'no' : `only ${faqs}`} FAQ${faqs === 1 ? '' : 's'}` : ''].filter(Boolean)
  return gaps.length ? { reason: 'thin', why: `the recap is thin (${gaps.join(' and ')})` } : null
}

/**
 * The trips to prompt Joel about today. A published trip whose last date has passed (the shared rule, so recap_mode is
 * respected: 'live' is never prompted, 'recap' always counts as past) that has no recap or a thin one, and is not snoozed.
 * Most recently finished first, because the memories are freshest. Nothing here unpublishes anything.
 */
export function selectRecapDue(rows: DueRow[], snoozedUntil: Record<string, string | null | undefined>, now: Date = new Date()): DueTrip[] {
  const today = todayYmd(now)
  return rows
    .filter((r) => r.status === 'published' && isPastTrip({ available_to: r.available_to, recap_mode: normaliseRecapMode(r.recap_mode) }, today))
    .filter((r) => {
      const until = Date.parse(snoozedUntil[r.id] ?? '')
      return !(Number.isFinite(until) && until > now.getTime())
    })
    .flatMap((r) => {
      const t = recapThinReason(r)
      return t ? [{ id: r.id, slug: r.slug, name: r.name, available_to: r.available_to, reason: t.reason, why: t.why, href: studioPath(r.id) }] : []
    })
    .sort((a, b) => (b.available_to ?? '').localeCompare(a.available_to ?? '') || a.name.localeCompare(b.name))
}

export const snoozeUntil = (now: Date = new Date(), days = SNOOZE_DAYS): string => new Date(now.getTime() + days * DAY_MS).toISOString()

export const dueTitle = (n: number): string => `${n} past trip${n === 1 ? ' needs' : 's need'} a recap`

// ─── Share links ────────────────────────────────────────────────────────────────────────

export const SHARE_DAYS = 14
export const SHARE_TOKEN_BYTES = 32
export const SHARES_PER_TRIP_MAX = 10

export type ShareKind = 'agent' | 'testimonial'

// Token creation and hashing use node:crypto, so they live in lib/recap-token.ts (this file is also imported by browser code).

/** True only for something that could be a token we issued (43 url-safe characters). Checked before any database lookup. */
export const isShareTokenFormat = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v)

export const shareExpiry = (now: Date = new Date(), days = SHARE_DAYS): Date => new Date(now.getTime() + days * DAY_MS)

export interface ShareLike {
  expires_at: string | Date
  revoked_at: string | Date | null
}

export type ShareBlock = 'revoked' | 'expired'

export function shareState(share: ShareLike, now: Date): { ok: true } | { ok: false; reason: ShareBlock } {
  if (share.revoked_at) return { ok: false, reason: 'revoked' }
  if (new Date(share.expires_at).getTime() <= now.getTime()) return { ok: false, reason: 'expired' }
  return { ok: true }
}

export function shareBlockMessage(reason: ShareBlock): string {
  return reason === 'expired' ? 'This link has expired. Please ask Joel for a new one.' : 'This link is no longer active. Please ask Joel for a new one.'
}

export const SHARE_UNKNOWN_MESSAGE = 'This link is not valid. Please check that you copied all of it, or ask Joel for a new one.'

/** Per-token and per-IP limits for the public routes (requests in a window). The abuse guard counts them. */
export const SHARE_LIMITS = { perIp: { limit: 60, windowSeconds: 600 }, perToken: { limit: 120, windowSeconds: 3600 }, submitsPerToken: { limit: 12, windowSeconds: 3600 } }

export const sharePath = (token: string): string => `/recap/${token}`

/** The short, friendly message that goes with a link. No personal data, no dashes. */
export function shareMessage(kind: ShareKind, tripName: string, url: string, agentName?: string | null): string {
  const hi = agentName ? `Hi ${agentName.trim().split(/\s+/)[0]}!` : 'Hi!'
  return kind === 'agent'
    ? `${hi} Could you share a few photos and notes from ${tripName}? It takes about 5 minutes and works on your phone: ${url}`
    : `${hi} Would you share a sentence or two about your time on ${tripName}? Here is a quick page: ${url}`
}

/** sms: link with the message filled in. The "?&body=" form opens the Messages app on iPhone and Android. */
export const smsHref = (message: string): string => `sms:?&body=${encodeURIComponent(message)}`
/** WhatsApp link with the message (and so the link) filled in. */
export const whatsappHref = (message: string): string => `https://wa.me/?text=${encodeURIComponent(message)}`

// ─── Email to Joel ──────────────────────────────────────────────────────────────────────

/** The email for a new submission. It names the trip and what arrived, and carries NO personal data (no name, no words
 * from the notes, no contact details). */
export function buildRecapEmail(tripName: string, counts: { answers: number; quotes: number; photos: number }, adminUrl: string): { subject: string; text: string } {
  const parts = [counts.photos ? `${counts.photos} photo${counts.photos === 1 ? '' : 's'}` : '', counts.answers ? `${counts.answers} answer${counts.answers === 1 ? '' : 's'}` : '', counts.quotes ? `${counts.quotes} quote${counts.quotes === 1 ? '' : 's'}` : ''].filter(Boolean)
  const trip = tripName.replace(/@/g, ' ').replace(/\d{7,}/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'a trip'
  return { subject: 'Something to review for a trip recap', text: ['Something new came in for a trip recap.', `Trip: ${trip}`, `Waiting for you: ${parts.join(', ') || 'a submission'}`, 'Nothing is on the site until you approve it.', `Open: ${adminUrl}`].join('\n') }
}

// ─── What the public sees ───────────────────────────────────────────────────────────────

/** The one page-ready bundle a published recap keeps (app_settings key recap_bundle:<id>). Everything in it is already
 * approved and safe to show; the trip page reads nothing else of the Studio. */
export interface RecapBundle {
  quickAnswer: string
  takeaways: string[]
  quotes: Quote[]
  metaTitle: string
  metaDescription: string
  publishedAt: string
}

export const recapBundleKey = (packageId: string) => `recap_bundle:${packageId}`
export const studioKey = (packageId: string) => `recap_studio:${packageId}`

/** Reads a stored bundle defensively: anything that is not shaped right is treated as no bundle. Only quotes with text and a name survive. */
export function parseBundle(raw: string | null | undefined): RecapBundle | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Partial<RecapBundle> | null
    if (!o || typeof o !== 'object' || typeof o.quickAnswer !== 'string') return null
    const quotes = (Array.isArray(o.quotes) ? o.quotes : []).filter((q): q is Quote => !!q && typeof q.text === 'string' && typeof q.name === 'string' && q.text.trim() !== '' && q.name.trim() !== '')
    return {
      quickAnswer: o.quickAnswer,
      takeaways: (Array.isArray(o.takeaways) ? o.takeaways : []).filter((t): t is string => typeof t === 'string' && t.trim() !== ''),
      quotes,
      metaTitle: typeof o.metaTitle === 'string' ? o.metaTitle : '',
      metaDescription: typeof o.metaDescription === 'string' ? o.metaDescription : '',
      publishedAt: typeof o.publishedAt === 'string' ? o.publishedAt : '',
    }
  } catch {
    return null
  }
}
