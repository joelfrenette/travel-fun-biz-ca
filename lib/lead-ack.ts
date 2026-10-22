import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { parseDayCount, notifyTo } from '@/lib/alerts'
import { LEAD_ACK_SUBJECT, LEAD_ACK_PARAGRAPHS, LEAD_ACK_SIGNOFF, leadAckFooterLines } from '@/lib/lead-ack-copy'

// Instant lead reply: a short "we got your message" email to the lead, sent through Resend right after the lead
// is saved. OFF by default (setting `lead_ack_email` must be exactly 'true'). The wording lives in
// lib/lead-ack-copy.ts and is a DRAFT pending Joel's CASL review. Never throws: the lead response never depends on it.
export const LEAD_ACK_SETTING_KEY = 'lead_ack_email'
const SENT_PREFIX = 'lead_ack_sent_'
export const LEAD_ACK_WINDOW_MS = 24 * 60 * 60 * 1000

export const LEAD_ACK_DAILY_CAP = 50
const LEAD_ACK_DAY_KEY = 'lead_ack_day'

export type LeadAckResult = 'cap' | 'sent' | 'off' | 'test' | 'invalid-email' | 'rate-limited' | 'not-configured' | 'failed'

export interface LeadAckInput {
  email: string
  name?: string | null
  isTest?: boolean
}

export interface LeadAckDeps {
  admin?: SupabaseClient
  fetchImpl?: typeof fetch
  get?: (key: string) => Promise<string | null>
  set?: (key: string, value: string) => Promise<unknown>
  now?: () => Date
}

/** Pure: a single plain address, no header injection characters, sane length. */
export function isValidAckEmail(email: string | null | undefined): boolean {
  const e = (email ?? '').trim()
  if (!e || e.length > 254 || /[\s,;<>"\r\n]/.test(e)) return false
  return /^[^@]+@[^@]+\.[^@.]{2,}$/.test(e)
}

/** Pure: the first name when it looks like one, otherwise "there". */
export function ackFirstName(name: string | null | undefined): string {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? ''
  return /^[\p{L}][\p{L}'-]{0,29}$/u.test(first) ? first : 'there'
}

/** Pure: the settings key that holds the last send time for this address. A hash, so no address is stored. */
export function ackSentKey(email: string): string {
  return SENT_PREFIX + createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 24)
}

/** Pure: at most one per address per 24 hours. */
export function isRateLimited(lastSentIso: string | null, now: Date): boolean {
  const last = Date.parse(lastSentIso ?? '')
  return Number.isFinite(last) && now.getTime() - last < LEAD_ACK_WINDOW_MS
}

/** Pure: subject and plain text body built from the copy file. */
export function buildLeadAckEmail(name: string | null | undefined): { subject: string; text: string } {
  const paragraphs = LEAD_ACK_PARAGRAPHS.map((p) => p.replace('{firstName}', ackFirstName(name)))
  const text = [...paragraphs.flatMap((p) => [p, '']), LEAD_ACK_SIGNOFF, '', '--', ...leadAckFooterLines()].join('\n')
  return { subject: LEAD_ACK_SUBJECT, text }
}

export async function isLeadAckOn(admin: SupabaseClient): Promise<boolean> {
  return (await getSetting(admin, LEAD_ACK_SETTING_KEY)) === 'true'
}

export async function setLeadAckOn(admin: SupabaseClient, on: boolean): Promise<{ error?: string }> {
  return setSetting(admin, LEAD_ACK_SETTING_KEY, on ? 'true' : 'false')
}

/** Sends the acknowledgement if the setting is on. Never throws; returns what happened. */
export async function sendLeadAck(input: LeadAckInput, deps: LeadAckDeps = {}): Promise<LeadAckResult> {
  try {
    if (input.isTest) return 'test'
    const email = (input.email ?? '').trim()
    if (!isValidAckEmail(email)) return 'invalid-email'
    const client = async () => deps.admin ?? (await import('@/lib/supabase-admin')).getSupabaseAdmin()
    const get = deps.get ?? (async (k: string) => getSetting(await client(), k))
    const set = deps.set ?? (async (k: string, v: string) => setSetting(await client(), k, v))
    if ((await get(LEAD_ACK_SETTING_KEY)) !== 'true') return 'off'
    // Needs its own verified-domain sender: Resend's onboarding@resend.dev can only reach the account owner.
    const key = process.env.RESEND_API_KEY?.trim()
    const from = process.env.LEAD_ACK_FROM_EMAIL?.trim()
    if (!key || !from) return 'not-configured'
    const now = deps.now?.() ?? new Date()
    const sentKey = ackSentKey(email)
    if (isRateLimited(await get(sentKey), now)) return 'rate-limited'
    // Global daily cap: over it, skip silently.
    const today = now.toISOString().slice(0, 10)
    const sentToday = parseDayCount(await get(LEAD_ACK_DAY_KEY), today)
    if (sentToday >= LEAD_ACK_DAILY_CAP) return 'cap'
    // Claim first: a retry or a double submit can never send two.
    await set(sentKey, now.toISOString())
    await set(LEAD_ACK_DAY_KEY, `${today}:${sentToday + 1}`)
    const replyTo = process.env.LEAD_ACK_REPLY_TO?.trim() || notifyTo()
    const mail = buildLeadAckEmail(input.name)
    const res = await (deps.fetchImpl ?? fetch)('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [email], subject: mail.subject, text: mail.text, ...(replyTo ? { reply_to: replyTo } : {}) }),
      signal: AbortSignal.timeout(5_000),
    })
    return res.ok ? 'sent' : 'failed'
  } catch {
    return 'failed'
  }
}
