import { site } from '@/lib/site'

// Ported from Nomad Escape Plan's lib/ai-verify.ts (Factory Phase 1: foundation), trimmed to the
// generic engine: dateContext/callAnthropic/anthropicText/parseModelJson/verifyRecord are subject-
// agnostic. Dropped: researchCountryFacts, researchPassportAccess, PassportFinding and the
// visa/passport constants — those are 100% Nomad's own domain (relocation/visas), not applicable
// here. A travel-specific research function (e.g. verifying a package's details against a
// supplier's page) can reuse verifyRecord below rather than needing a new one.
//
// Dormant until ANTHROPIC_API_KEY is set (decision 7: in scope from Phase 3 onward, not before).
/**
 * AI verification via the Anthropic Messages API. Compares a stored record against the current
 * text of its official source and returns proposed corrections. Returns [] when unconfigured.
 */
export interface AiFinding {
  field: string
  current: string
  proposed: string
  confidence: 'low' | 'medium' | 'high'
  note: string
  source?: string
}

export function isAiConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY
}

/** Anthropic request headers. Identity-linked (admin/org) keys require an
 * `anthropic-workspace-id`; set ANTHROPIC_WORKSPACE_ID to supply it. Plain
 * workspace-scoped keys don't need it, so it's only sent when present. */
export function anthropicHeaders(key: string): Record<string, string> {
  const h: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  }
  const ws = process.env.ANTHROPIC_WORKSPACE_ID
  if (ws) h['anthropic-workspace-id'] = ws
  return h
}

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'

/**
 * Parse JSON out of a model reply, tolerating the one thing models reliably get wrong about
 * JSON: a raw newline inside a string value. That is invalid JSON, and it happens constantly
 * whenever the JSON carries markdown (a post body, for instance). Rather than lose a whole
 * generation to it, escape the stray control characters and try again.
 *
 * Returns null when the text genuinely is not JSON, so callers keep failing loudly on real garbage.
 */
export function parseModelJson<T>(text: string): T | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  const raw = match[0]
  try {
    return JSON.parse(raw) as T
  } catch {
    /* fall through to the repair */
  }
  let out = ''
  let inString = false
  let escaped = false
  for (const ch of raw) {
    if (escaped) {
      out += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      out += ch
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      out += ch
      continue
    }
    if (inString && (ch === '\n' || ch === '\r' || ch === '\t')) {
      out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : '\\t'
      continue
    }
    out += ch
  }
  try {
    return JSON.parse(out) as T
  } catch {
    return null
  }
}

/**
 * Pull the assistant's text out of a Messages API response. `content` is an ARRAY OF BLOCKS, and
 * text is not always the first one — a model with extended thinking puts a `thinking` block in
 * front of it. Reading content[0].text would return an empty string for those models. Join every
 * text block instead, and ignore the rest.
 */
export function anthropicText(data: unknown): string {
  const blocks = (data as { content?: unknown })?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b): b is { type: string; text: string } => (b as { type?: string })?.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim()
}

// Preferred models, best-reasoning first. ANTHROPIC_MODEL overrides the list. The pipeline tries
// these in order and falls through only when a model is unavailable to the key, so it uses the
// strongest reasoning available and still works on plans without it.
const MODEL_CANDIDATES = ['claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']
let cachedModel: string | null = null

/** Smallest output budget any call gets — see callAnthropic. */
const MIN_OUTPUT_TOKENS = 4000

/** Today's date in this site's own time zone (lib/site.ts's `site.timeZone`), as YYYY-MM-DD. */
export function todayEt(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: site.timeZone })
}

/** The date line every Anthropic call carries as its system prompt. */
export function dateContext(now: Date = new Date()): string {
  const today = todayEt(now)
  const year = today.slice(0, 4)
  return `Today's date is ${today}; the current year is ${year}. Whenever a title, heading, keyword or "as of" phrase names a year, use ${year}, not an earlier year, unless you are stating a fact about the past. If a keyword you were given names an earlier year, update it to ${year}.`
}

/** Default wait for one Anthropic call. Long writers (a blog body) pass their own `timeoutMs` —
 * see callAnthropic. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Which model ids to try, honoring ANTHROPIC_MODEL and caching the first that worked this
 * process (so we don't re-probe on every call). */
export function anthropicModels(): string[] {
  if (process.env.ANTHROPIC_MODEL) return [process.env.ANTHROPIC_MODEL]
  if (cachedModel) return [cachedModel]
  return MODEL_CANDIDATES
}

/** A message body: plain text, or content blocks when an image goes along with the words. */
export type AnthropicContent =
  | string
  | (
      | { type: 'text'; text: string }
      | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/webp'; data: string } }
    )[]

/** POST to Anthropic, trying preferred models in order; falls through only when the model itself
 * is unavailable (404 / "model" error) — auth and quota errors are terminal. */
export async function callAnthropic(
  payload: {
    max_tokens: number
    messages: { role: 'user' | 'assistant'; content: AnthropicContent }[]
  },
  opts: { timeoutMs?: number } = {},
): Promise<{ res: Response; model: string } | null> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return null
  // Current models reason before they answer, and that reasoning spends the same max_tokens
  // budget. With a low cap the reply is cut off mid-JSON; only generated tokens are billed, so a
  // floor costs nothing when the answer is short. Every call is told today's date as a system
  // prompt, so no caller can forget it and write last year in a title.
  const request = { ...payload, max_tokens: Math.max(payload.max_tokens, MIN_OUTPUT_TOKENS), system: dateContext() }
  const models = anthropicModels()
  let last: { res: Response; model: string } | null = null
  for (const model of models) {
    let res: Response
    try {
      // Generation can legitimately take a while, but a hung request must still give up instead
      // of holding the whole cron/request open. A long writer must pass its own timeoutMs — Nomad
      // measured a full blog body at 69s and a flat 30s cap silently stopped its autoblog for 4
      // days (PARITY-SPEC §16, owner rules).
      res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: anthropicHeaders(key),
        body: JSON.stringify({ model, ...request }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      })
    } catch (e) {
      // A timeout means the model was working, not unavailable — trying the next candidate would
      // only spend the same wait again. Give up.
      if (e instanceof Error && e.name === 'TimeoutError') return null
      continue
    }
    if (res.ok) {
      cachedModel = model
      return { res, model }
    }
    const body = await res.clone().text().catch(() => '')
    if (res.status === 404 || /model/i.test(body)) {
      last = { res, model }
      continue
    }
    return { res, model }
  }
  return last
}

/** Minimal round-trip to confirm the key + a model actually work. */
export async function pingAi(): Promise<boolean> {
  try {
    const r = await callAnthropic({ max_tokens: 8, messages: [{ role: 'user', content: 'Reply with the two letters OK.' }] })
    return !!r?.res.ok
  } catch {
    return false
  }
}

/** Compare a stored record against the current text of its official source page and propose
 * corrections. Generic: works for any record shape and field list. */
export async function verifyRecord(
  pageText: string,
  record: Record<string, unknown>,
  fields: string[],
): Promise<AiFinding[]> {
  if (!process.env.ANTHROPIC_API_KEY || !pageText) return []

  const prompt = `You verify stored data against the CURRENT text of its official source page.

STORED RECORD (JSON):
${JSON.stringify(record, null, 2)}

FIELDS TO CHECK: ${fields.join(', ')}

SOURCE PAGE (markdown, may be truncated):
"""
${pageText}
"""

For each checked field where the source page clearly shows the stored value is now OUTDATED or INCORRECT, produce a finding with the corrected value. Only report a field when the page gives clear evidence; do not guess.

Return ONLY minified JSON of this exact shape, nothing else:
{"findings":[{"field":"<field>","current":"<stored value as string>","proposed":"<corrected value as string>","confidence":"low|medium|high","note":"<short reason, <120 chars>"}]}
Return {"findings":[]} if everything checks out.`

  try {
    const r = await callAnthropic({ max_tokens: 1024, messages: [{ role: 'user', content: prompt }] })
    if (!r || !r.res.ok) return []
    const data = await r.res.json()
    const text: string = anthropicText(data)
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return []
    const parsed = JSON.parse(match[0])
    const findings: AiFinding[] = Array.isArray(parsed?.findings) ? parsed.findings : []
    // Model output is untrusted: drop any element that is not a well-formed finding.
    return findings.filter(
      (f) => typeof f?.field === 'string' && typeof f?.proposed === 'string' && f.proposed && fields.includes(f.field),
    )
  } catch {
    return []
  }
}
