// "Copy for Claude" for ONE Today card: a ready prompt Joel pastes into Claude Code. Pure: no database, no network, no clock (the date
// comes in), so scripts/check-today-actions.ts tests it offline. Same style as lib/system-check-prompt.ts. It only restates what the
// card shows, with personal details and anything that looks like a secret masked, so the text is safe to paste.

import { TODAY_KINDS, type TodayCard } from '@/lib/today-cards'
import { cardActionsFor } from '@/lib/today-card-actions'

export interface CardPromptInput {
  now: Date
  card: TodayCard
  /** Auto-heal's answer for this card today, if it was pressed. */
  heal?: { state: string; message: string } | null
  siteUrl?: string
}

const SECRET_WORD = /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{12,}|\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}|\b[A-Fa-f0-9]{32,}\b|\b[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9])/g
const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g
const PHONE = /(?<![\w-])\+?\d[\d\s().-]{8,}\d(?![\w-])/g
const KEY_VALUE_SECRET = /\b(api[_ -]?key|secret|token|password|passwd|authorization)\b\s*[:=]\s*\S+/gi

/** Masks secrets, email addresses and phone numbers. Pure. */
export function maskSensitive(text: string): string {
  return text
    .replace(KEY_VALUE_SECRET, '$1: [removed]')
    .replace(SECRET_WORD, '[removed]')
    .replace(EMAIL, '$1***@$2')
    .replace(PHONE, (m) => {
      const digits = m.replace(/\D/g, '')
      // Dates and short numbers are not phone numbers.
      return digits.length >= 10 ? `***${digits.slice(-2)}` : m
    })
}

const oneLine = (s: string) => maskSensitive(s.replace(/\s+/g, ' ').trim()).slice(0, 600)

export function buildCardPrompt(i: CardPromptInput): string {
  const def = TODAY_KINDS[i.card.kind]
  const fields = cardActionsFor(i.card.kind).copyPromptFields
  const day = i.now.toISOString().slice(0, 10)
  const lines: string[] = []
  lines.push(`You are working on TravelFunBiz.ca (${i.siteUrl ?? 'https://travelfunbiz.ca'}): a Next.js 14 (App Router) + Supabase lead-gen site for a travel agency, with an admin at /admin. Today is ${day}.`)
  lines.push('')
  lines.push('Read CLAUDE.md in the repo root first and follow it. The short version of the repo rules:')
  lines.push('- Admin data lives in Supabase; admin tables are RLS-on with no policies, so only the service role (getSupabaseAdmin()) reads or writes them.')
  lines.push('- Every admin API route checks isAuthorized(request) from lib/admin-auth.ts first.')
  lines.push('- Never invent data (no default prices or categories). Every credit-costing call is admin-triggered and cached.')
  lines.push('- New env vars go in .env.example in the same change. No em dashes in copy. Use plain English.')
  lines.push('')
  lines.push('One card on the admin Today page needs fixing. Only this card is in scope.')
  lines.push('')
  lines.push(`Card: ${oneLine(i.card.title)}`)
  lines.push(`Kind: ${def ? def.badge : i.card.kind} (${i.card.kind})`)
  lines.push(`Card id: ${oneLine(i.card.id)}`)
  lines.push(`What the card says: ${oneLine(i.card.why)}`)
  if (i.card.facts.length) {
    lines.push('Facts on the card:')
    for (const f of i.card.facts) lines.push(`- ${oneLine(f.label)}: ${oneLine(f.value)}`)
  }
  if (def) {
    lines.push(`The two buttons today: yes = "${def.primary.label}" (${def.primary.hint})${def.secondary ? `; no = "${def.secondary.label}" (${def.secondary.hint})` : ''}.`)
    lines.push(`They are wired through: ${def.routes.primary}${def.routes.secondary ? `; ${def.routes.secondary}` : ''}.`)
  }
  lines.push('')
  lines.push('Where to look:')
  if (i.card.link) lines.push(`- Page the card links to: ${oneLine(i.card.link.href)} (${oneLine(i.card.link.label)})`)
  for (const p of fields.pages) lines.push(`- Admin or site page: ${p}`)
  const files = [...new Set([...fields.files, ...(def?.routeFiles ?? [])])]
  lines.push(`- Code to start from: ${files.join(', ')}`)
  lines.push('')
  if (i.heal) {
    lines.push(`Auto-heal was already pressed on this card today: ${i.heal.state}. ${oneLine(i.heal.message)} Do not redo what it did.`)
    lines.push('')
  }
  lines.push('Safety rules (these are firm):')
  lines.push('- Do not print, copy or commit any secret, API key, token or customer data. Personal details in this prompt are masked on purpose.')
  lines.push('- Make no change to live settings, the live database or production unless I ask for that specific change. Reading is fine.')
  lines.push('- Develop on a branch. Do not touch other cards, other kinds or unrelated files.')
  lines.push('- Commit and push only when I ask. Never force-push.')
  lines.push('- If a fix needs something only I can do (an account, a key, an approval), say so plainly instead of guessing.')
  lines.push('')
  lines.push('Fix it, then verify: `pnpm exec tsc --noEmit -p tsconfig.json`, the relevant scripts/check-*.ts via `pnpm dlx tsx`, and `next build` (never while `next dev` is running). Report: the real cause, what you changed, how you checked it, and anything I must do myself.')
  return lines.join('\n')
}
