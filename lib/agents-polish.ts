import { createHash } from 'node:crypto'
import { callAnthropic, anthropicText, isAiConfigured } from '@/lib/ai-verify'
import { ungroundedNumbers, repairDashes } from '@/lib/hook-styles'

// AI "polish my bio": rewrites ONLY the agent's own supplied text. Grounded: no new facts, no new numbers, no new names
// or credentials. Admin-triggered and cached by a hash of the input text (the same text is never polished twice).
// The model's output is checked by plain code (groundedPolishProblems) and thrown away if it adds anything.

export const POLISH_MIN_CHARS = 40
export const POLISH_MAX_CHARS = 3000

export function polishHash(text: string): string {
  return createHash('sha256').update(`agent-polish:${text.trim()}`).digest('hex')
}

const CREDENTIAL_WORDS = /\b(certified|certification|accredited|accreditation|award(?:ed|-winning)?|licensed|diploma|degree|member of|ctc|cta|cts|clia|iata)\b/gi

function wordSet(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-zÀ-ɏ0-9']+/g) ?? []))
}

/** Capitalised words in the middle of a sentence (likely names / places). */
function midSentenceCaps(text: string): string[] {
  const out: string[] = []
  const re = /(?<![.!?]\s)(?<!^)(?<=\s)([A-ZÀ-Þ][\p{L}'-]{2,})/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push(m[1])
  return out
}

/** Empty = the output only rephrases the input. Otherwise the reasons it was rejected. */
export function groundedPolishProblems(input: string, output: string): string[] {
  const problems: string[] = []
  const out = output.trim()
  if (!out) return ['empty output']
  if (out.length > Math.max(input.length * 1.3, input.length + 80)) problems.push('much longer than the original')
  const stray = ungroundedNumbers(out, input)
  if (stray.length) problems.push(`new number(s): ${stray.join(', ')}`)
  const inWords = wordSet(input)
  const newCreds = (out.match(CREDENTIAL_WORDS) ?? []).filter((w) => !inWords.has(w.toLowerCase()) && !input.toLowerCase().includes(w.toLowerCase()))
  if (newCreds.length) problems.push(`new credential wording: ${[...new Set(newCreds.map((w) => w.toLowerCase()))].join(', ')}`)
  const newNames = midSentenceCaps(out).filter((w) => !inWords.has(w.toLowerCase()))
  if (newNames.length) problems.push(`new name(s): ${[...new Set(newNames)].join(', ')}`)
  if (/[\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d\s().-]{8,}\d|https?:\/\//i.test(out) && !/[\w.+-]+@|https?:\/\//i.test(input)) problems.push('contact details or links added')
  return problems
}

export type PolishResult = { ok: true; text: string; cached: boolean } | { ok: false; error: string }

export type PolishCall = (prompt: string) => Promise<string | null>

async function defaultCall(prompt: string): Promise<string | null> {
  const r = await callAnthropic({ max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }, { feature: 'agent-bio-polish', timeoutMs: 45_000 })
  if (!r || !r.res.ok) return null
  return anthropicText(await r.res.json().catch(() => null)) || null
}

export function polishPrompt(text: string): string {
  return [
    'Rewrite the biography below so it reads smoothly in the first person or third person, whichever the original uses.',
    'Hard rules:',
    '- Use ONLY the facts that are in the text. Do not add any fact, number, year, place, company, name, award, certification, qualification or claim.',
    '- Do not mention certifications unless the text already does, and then only as the text states them.',
    '- Do not add contact details or links. Do not use long dashes.',
    '- Keep it about the same length or shorter. Plain paragraphs, no headings, no bullet points, no quotes around it.',
    'Reply with the rewritten biography only.',
    '',
    'BIOGRAPHY:',
    text.trim(),
  ].join('\n')
}

/** `cached` is looked up by the caller (it owns the database). `call` is injectable for tests. */
export async function polishBio(text: string, deps: { call?: PolishCall; configured?: boolean; cached?: string | null } = {}): Promise<PolishResult> {
  const t = (text ?? '').trim()
  if (t.length < POLISH_MIN_CHARS) return { ok: false, error: `Add at least ${POLISH_MIN_CHARS} characters of the agent's own bio first. I only rewrite what the agent supplied.` }
  if (t.length > POLISH_MAX_CHARS) return { ok: false, error: 'That bio is too long to polish.' }
  if (deps.cached) return { ok: true, text: deps.cached, cached: true }
  if (!(deps.configured ?? isAiConfigured())) return { ok: false, error: 'The AI key is not set, so polish is unavailable.' }
  const raw = await (deps.call ?? defaultCall)(polishPrompt(t))
  if (!raw) return { ok: false, error: 'The AI did not answer. Try again in a minute.' }
  const cleaned = repairDashes(raw.replace(/^["'\s]+|["'\s]+$/g, '')).trim()
  const problems = groundedPolishProblems(t, cleaned)
  if (problems.length) return { ok: false, error: `The rewrite added something that was not in the original (${problems.join('; ')}), so it was discarded.` }
  return { ok: true, text: cleaned, cached: false }
}
