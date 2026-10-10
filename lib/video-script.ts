import { callAnthropic, anthropicText, parseModelJson, isAiConfigured } from '@/lib/ai-verify'
import { ungroundedNumbers, repairDashes } from '@/lib/hook-styles'

// Short-form video script generation (factory item 1/6, video pipeline): one model call produces
// a hook, a sequence of beats (scene description + on-screen text + the spoken voiceover line for
// that beat), a title, description, hashtags, and b-roll search terms per beat - not actual video,
// just the terms a stock-clip search would use. This file only writes the script; lib/shotstack.ts
// renders it.

export interface VideoBeat {
  /** What's on screen (for picking/describing a b-roll clip), never shown to the viewer. */
  scene: string
  /** Short text burned into the frame for this beat. */
  onScreenText: string
  /** The spoken narration line for this beat - concatenated with every other beat's line into
   * ONE continuous TTS clip (see lib/shotstack.ts), never rendered as separate audio per beat,
   * so beats can never overlap or clip each other. */
  voiceover: string
  /** Search terms for a stock b-roll clip matching this beat's scene. */
  brollSearchTerms: string[]
}

export interface VideoScript {
  hook: string
  /** Short scroll-stopping headline for the opening cover card (3-7 words). */
  coverTitle?: string
  beats: VideoBeat[]
  title: string
  description: string
  hashtags: string[]
  /** True when no model hook passed the checks and the title-based hook was used instead. */
  usedFallback?: boolean
}

const NO_FABRICATION = `Never claim personal experience, a specific past trip, a named traveler, a specific date, or a price - you are a marketing writer, not someone who has been on this trip. Write from general travel-planning knowledge and what a first-time visitor would want to know.`

// Hook formula categories a strong short-form opener usually falls into - used both to prompt for
// one and to mechanically check what came back, same "don't just trust the model" discipline as
// the numeric-grounding check elsewhere in this project.
export const HOOK_FORMULAS = ['number', 'myth', 'comparison', 'mistake', 'before/after', 'ranking', 'contrarian', 'question', 'story'] as const
export type HookFormula = (typeof HOOK_FORMULAS)[number]

// What each formula means for the hook line, and the matching look for the cover headline, so the
// opening frame and the first spoken line pull the same way. None of these may introduce a number,
// place or claim that is not in the post.
const FORMULA_NOTES: Record<HookFormula, { hook: string; cover: string }> = {
  number: { hook: 'lead with a number, but ONLY one that appears in the title or summary; if there is none, lead with a concrete detail instead', cover: 'a short promise built around a number from the title or summary, or a concrete detail if there is none' },
  myth: { hook: 'call out a common myth about the topic', cover: 'a short myth-versus-truth style headline' },
  comparison: { hook: 'set two options against each other', cover: 'a this-or-that style headline' },
  mistake: { hook: 'name a common planning mistake', cover: 'a short "stop doing this" style headline' },
  'before/after': { hook: 'contrast how the trip feels before versus after planning it well', cover: 'a short before-and-after style headline' },
  ranking: { hook: 'frame the post as a short ranked or best-of list', cover: 'a short best-of style headline' },
  contrarian: { hook: 'gently push back on what most people assume', cover: 'a short bold, against-the-grain headline' },
  question: { hook: 'open with one direct question the viewer would genuinely ask', cover: 'a short headline written as a question' },
  story: { hook: 'open with a short second-person scene ("Picture...", "You step off...") in general travel terms, never as something we did or a named traveller', cover: 'a short scene-setting headline' },
}

function scriptPrompt(postTitle: string, postSummary: string, formulaHint?: HookFormula): string {
  const formulaNote = formulaHint
    ? `Your hook formula must specifically be: ${formulaHint} (${FORMULA_NOTES[formulaHint].hook}). Write the coverTitle in the same spirit: ${FORMULA_NOTES[formulaHint].cover}.`
    : `Pick ONE of these hook formulas and use it: ${HOOK_FORMULAS.join(', ')}.`
  return `You are writing a short-form video script (under 60 seconds spoken) for a travel agency's social media, based on this blog post:

Title: ${postTitle}
Summary: ${postSummary}

${NO_FABRICATION}

The hook is the first spoken line - it has to earn the next 2 seconds of attention. ${formulaNote} A weak hook is a vague scene-setter ("Have you ever wondered about..."); a strong one states something specific and surprising in one breath.

Also write coverTitle: the headline printed big on the opening cover frame of the video, 3 to 7 words, built to stop a thumb mid-scroll (curiosity, contrast or a bold promise), plain words, no emoji, no hashtags. It may only promise what the post itself supports - never invent a price, number, date or place that is not in the title or summary above.

The final beat must be the call to action: the voiceover names one next step in under 12 words (for example: the full guide is on travelfunbiz.ca; do not mention a link in bio or in the description, we do not know one is there) and the on-screen text is travelfunbiz.ca. No urgency, no price or offer claims.

Write 4-6 beats after the hook. Each beat needs: a scene description (what b-roll footage would show, for searching stock clips - never shown to the viewer), 3-6 words of on-screen text, one spoken voiceover line (natural spoken pace, not written prose), and 2-4 English search terms for finding a matching stock video clip.

Keep the WHOLE spoken script (hook + every beat's voiceover line, read aloud, back to back) under 140 words total - real narration runs slower than reading speed, and this has to fit under 60 seconds including a title card.

Return ONLY minified JSON of this exact shape: {"hook":"...","coverTitle":"...","beats":[{"scene":"...","onScreenText":"...","voiceover":"...","brollSearchTerms":["...","..."]}],"title":"...","description":"...","hashtags":["...","..."]}`
}

const HOOK_PATTERNS: Array<[HookFormula, RegExp]> = [
  ['number', /\b\d+\b/],
  ['myth', /\bmyth\b|\bwrong\b|\bactually\b|\bnot true\b/],
  ['comparison', /\bvs\.?\b|\bversus\b|\bcompared to\b/],
  ['mistake', /\bmistake\b|\bdon'?t\b.*\bthis\b|\bnever\b/],
  ['before/after', /\bbefore\b.*\bafter\b/],
  ['ranking', /\btop \d+\b|\bbest\b|\bworst\b|\branked\b/],
  ['contrarian', /\bhot take\b|\bunpopular\b|\beveryone says\b.*\bwrong\b/],
  // A real question (the weak "have you ever wondered" scene-setters have no question mark and stay unclassified).
  ['question', /\?/],
  // A second-person scene opener or an imagine-style opener.
  ['story', /^(?:picture|imagine|close your eyes|you(?:'re| are| step| wake| walk| arrive| land| turn)|it'?s (?:early|late|\d)|the (?:first|last) time)\b|\b(?:one (?:morning|evening|afternoon|night))\b/],
]

/** Which formula a hook line follows, or null if none. When `prefer` is given and that formula's
 * pattern matches, it wins over the fixed order below (so a question hook that also has a digit is
 * recorded as the question hook it was asked to be). */
export function detectHookFormula(hook: string, prefer?: HookFormula): HookFormula | null {
  const h = hook.trim().toLowerCase()
  if (prefer) {
    const hit = HOOK_PATTERNS.find(([f]) => f === prefer)
    if (hit && hit[1].test(h)) return prefer
  }
  for (const [formula, re] of HOOK_PATTERNS) if (re.test(h)) return formula
  return null
}

/** A hook built straight from the post's own real title - never invents anything, so there's
 * always a safe fallback and video generation can never get stuck waiting on a "perfect" hook. */
function fallbackHook(postTitle: string): string {
  return postTitle.replace(/[.!?]+$/, '') + '.'
}

async function runScriptStep(postTitle: string, postSummary: string, formulaHint?: HookFormula): Promise<VideoScript | null> {
  const r = await callAnthropic({ max_tokens: 2000, messages: [{ role: 'user', content: scriptPrompt(postTitle, postSummary, formulaHint) }] }, { timeoutMs: 40_000 })
  if (!r || !r.res.ok) return null
  const parsed = parseModelJson<Partial<VideoScript>>(anthropicText(await r.res.json()))
  if (!parsed || typeof parsed.hook !== 'string' || !Array.isArray(parsed.beats) || parsed.beats.length === 0) return null
  const beats = parsed.beats
    .filter((b): b is VideoBeat => !!b && typeof b.scene === 'string' && typeof b.onScreenText === 'string' && typeof b.voiceover === 'string')
    .map((b) => ({ ...b, brollSearchTerms: Array.isArray(b.brollSearchTerms) ? b.brollSearchTerms.filter((t): t is string => typeof t === 'string') : [] }))
  if (beats.length === 0) return null
  // The cover headline is public text on the first frame: any number in it must come from the post.
  const knownNumbers = new Set(`${postTitle} ${postSummary}`.match(/\d+/g) ?? [])
  const rawCover = typeof parsed.coverTitle === 'string' ? parsed.coverTitle.trim().replace(/\s+/g, ' ') : ''
  const coverTitle = rawCover && rawCover.length <= 60 && (rawCover.match(/\d+/g) ?? []).every((n) => knownNumbers.has(n)) ? rawCover : undefined
  // No em dashes in anything the viewer sees or hears: a comma says the same thing.
  const noDash = repairDashes
  return {
    hook: noDash(parsed.hook),
    coverTitle: coverTitle ? noDash(coverTitle) : undefined,
    beats: beats.map((b) => ({ ...b, onScreenText: noDash(b.onScreenText), voiceover: noDash(b.voiceover) })),
    title: noDash(typeof parsed.title === 'string' ? parsed.title : postTitle),
    description: noDash(typeof parsed.description === 'string' ? parsed.description : ''),
    hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.filter((h): h is string => typeof h === 'string') : [],
  }
}

/** Generates a video script grounded in a real post's title/summary. The hook gets ONE rewrite
 * attempt if it doesn't match a real formula category; after that, a safe hook built from the
 * post's own title is used instead of looping forever on "perfect." Returns null only when AI is
 * unconfigured or every attempt fails outright (not just a weak hook) - never blocks on this. */
export async function generateVideoScript(postTitle: string, postSummary: string, preferredFormula?: HookFormula): Promise<VideoScript | null> {
  if (!isAiConfigured()) return null

  // A hook with a number that is not in the post is never kept (same rule the cover headline has).
  // Spelled-out numbers (two..twelve, dozen, hundred, thousand) count too.
  const hookOk = (s: VideoScript) => ungroundedNumbers(s.hook, `${postTitle} ${postSummary}`).length === 0 && !!detectHookFormula(s.hook, preferredFormula)

  const first = await runScriptStep(postTitle, postSummary, preferredFormula)
  if (!first) return null
  if (hookOk(first)) return first

  // The retry keeps the rotation's choice when there is one; otherwise it picks a formula at random as before.
  const formula = preferredFormula ?? HOOK_FORMULAS[Math.floor(Math.random() * HOOK_FORMULAS.length)]
  const retry = await runScriptStep(postTitle, postSummary, formula)
  if (retry && hookOk(retry)) return retry

  // Neither attempt produced a hook matching a known formula - use the better-structured attempt
  // (prefer the retry's beats if it succeeded at all) but swap in the safe title-derived hook
  // rather than shipping a weak, unclassifiable opener.
  const best = retry ?? first
  return { ...best, hook: fallbackHook(postTitle), usedFallback: true }
}

// Real narration runs slower than reading speed - 2.5 words/second is the working estimate
// (same figure the spec this was ported from uses, a reasonable natural-pace number, not
// invented). A ~3s title card runs before the narration starts, so the spoken budget has to leave
// room for that too.
const WORDS_PER_SECOND = 2.5
const TITLE_CARD_SECONDS = 3
const MAX_DURATION_SECONDS = 58 // margin under most platforms' real 60s hard cap

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

export function estimatedSpokenSeconds(script: VideoScript): number {
  const words = wordCount(script.hook) + script.beats.reduce((sum, b) => sum + wordCount(b.voiceover), 0)
  return TITLE_CARD_SECONDS + words / WORDS_PER_SECOND
}

/** If the script runs over the real duration ceiling, trims MIDDLE beats first - the hook (first)
 * and the last beat (the call-to-action position) are never cut, so a trimmed video never loses
 * its opener or its close, only some of the middle detail. */
export function capScriptDuration(script: VideoScript, maxSeconds = MAX_DURATION_SECONDS): VideoScript {
  if (estimatedSpokenSeconds(script) <= maxSeconds || script.beats.length <= 2) return script
  const beats = [...script.beats]
  // Remove from the middle outward (index 1, then second-to-last, etc.) until it fits or only
  // the first and last beat remain - never touch index 0 (right after the hook) or the last index.
  while (beats.length > 2 && estimatedSpokenSeconds({ ...script, beats }) > maxSeconds) {
    const middleIndex = Math.floor(beats.length / 2)
    const removeAt = middleIndex === 0 || middleIndex === beats.length - 1 ? 1 : middleIndex
    beats.splice(removeAt, 1)
  }
  return { ...script, beats }
}

/** The cover card headline: the model's, or a short cut of the post's own title when it gave none
 * (or one with an unsupported number). Never invents anything. */
export function coverTitleFor(script: VideoScript, postTitle: string): string {
  if (script.coverTitle) return script.coverTitle
  const words = postTitle.replace(/[.!?]+$/, '').split(/\s+/).filter(Boolean)
  return words.slice(0, 7).join(' ')
}
