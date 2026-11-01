import { DESK_LIST_MAX, isDeskEmail, parseDeskEmails } from '@/lib/lead-desk'

// Who gets the hot lead alert email. The addresses stay in lead_desk_alert_emails (a JSON list, read by the lead desk
// and the Needs attention list). The names live in their own key and are labels for the admin screen only.
export const DESK_NAMES_KEY = 'lead_desk_alert_names'
export const NAME_MAX = 40

export interface AlertRecipient {
  name: string
  email: string
}

/** Pure: a label, trimmed, one line, capped. */
export function cleanName(raw: unknown): string {
  return (typeof raw === 'string' ? raw : '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
}

/** Pure: the stored names (a JSON object of email to label). Anything unreadable is an empty map. */
export function parseDeskNames(raw: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const v = JSON.parse((raw ?? '').trim() || '{}') as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const e = k.trim().toLowerCase()
        const n = cleanName(val)
        if (isDeskEmail(e) && n) out[e] = n
      }
    }
  } catch {
    // an unreadable value is no names
  }
  return out
}

/** Pure: the rows the card shows, one per stored address, with its label if there is one. */
export function buildRecipientRows(emailsRaw: string | null | undefined, namesRaw: string | null | undefined): AlertRecipient[] {
  const names = parseDeskNames(namesRaw)
  return parseDeskEmails(emailsRaw).map((email) => ({ name: names[email] ?? '', email }))
}

/** Pure: check what the page sent. Blank rows are skipped. A bad address or a duplicate is an error, never silently dropped. */
export function validateRecipients(input: unknown): { ok: true; rows: AlertRecipient[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'Send a list of recipients.' }
  const rows: AlertRecipient[] = []
  for (const item of input) {
    const o = (item && typeof item === 'object' ? item : {}) as { name?: unknown; email?: unknown }
    const email = (typeof o.email === 'string' ? o.email : '').trim().toLowerCase()
    const name = cleanName(o.name)
    if (!email) continue
    if (!isDeskEmail(email)) return { ok: false, error: `"${email.slice(0, 80)}" is not a valid email address.` }
    if (rows.some((r) => r.email === email)) return { ok: false, error: `${email} is in the list twice.` }
    rows.push({ name, email })
  }
  if (rows.length > DESK_LIST_MAX) return { ok: false, error: `Use at most ${DESK_LIST_MAX} addresses.` }
  return { ok: true, rows }
}

/** Pure: the two values to save. The email list keeps the existing format (a JSON list of lower-case addresses). */
export function serializeRecipients(rows: AlertRecipient[]): { emails: string; names: string } {
  const names: Record<string, string> = {}
  for (const r of rows) if (r.name) names[r.email] = r.name
  return { emails: JSON.stringify(rows.map((r) => r.email)), names: JSON.stringify(names) }
}
