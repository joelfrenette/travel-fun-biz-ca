import { callAnthropic, anthropicText, parseModelJson, isAiConfigured } from '@/lib/ai-verify'

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
}

const NO_FABRICATION = `Never claim personal experience, a specific past trip, a named traveler, a specific date, or a price - you are a marketing writer, not someone who has been on this trip. Write from general travel-planning knowledge and what a first-time visitor would want to know.`

// Hook formula categories a strong short-form opener usually falls into - used both to prompt for
// one and to mechanically check what came back, same "don't just trust the model" discipline as
// the numeric-grounding check elsewhere in this project.
const HOOK_FORMULAS = ['number', 'myth', 'comparison', 'mistake', 'before/after', 'ranking', 'contrarian'] as const
export type HookFormula = (typeof HOOK_FORMULAS)[number]

function scriptPrompt(postTitle: string, postSummary: string, formulaHint?: HookFormula): string {
  const formulaNote = formulaHint
    ? `Your hook formula must specifically be: ${formulaHint}.`
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

export function detectHookFormula(hook: string): HookFormula | null {
  const h = hook.toLowerCase()
  if (/\b\d+\b/.test(h)) return 'number'
  if (/\bmyth\b|\bwrong\b|\bactually\b|\bnot true\b/.test(h)) return 'myth'
  if (/\bvs\.?\b|\bversus\b|\bcompared to\b/.test(h)) return 'comparison'
  if (/\bmistake\b|\bdon'?t\b.*\bthis\b|\bnever\b/.test(h)) return 'mistake'
  if (/\bbefore\b.*\bafter\b/.test(h)) return 'before/after'
  if (/\btop \d+\b|\bbest\b|\bworst\b|\branked\b/.test(h)) return 'ranking'
  if (/\bhot take\b|\bunpopular\b|\beveryone says\b.*\bwrong\b/.test(h)) return 'contrarian'
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
  return {
    hook: parsed.hook,
    coverTitle,
    beats,
    title: typeof parsed.title === 'string' ? parsed.title : postTitle,
    description: typeof parsed.description === 'string' ? parsed.description : '',
    hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.filter((h): h is string => typeof h === 'string') : [],
  }
}

/** Generates a video script grounded in a real post's title/summary. The hook gets ONE rewrite
 * attempt if it doesn't match a real formula category; after that, a safe hook built from the
 * post's own title is used instead of looping forever on "perfect." Returns null only when AI is
 * unconfigured or every attempt fails outright (not just a weak hook) - never blocks on this. */
export async function generateVideoScript(postTitle: string, postSummary: string): Promise<VideoScript | null> {
  if (!isAiConfigured()) return null

  const first = await runScriptStep(postTitle, postSummary)
  if (!first) return null
  if (detectHookFormula(first.hook)) return first

  const formula = HOOK_FORMULAS[Math.floor(Math.random() * HOOK_FORMULAS.length)]
  const retry = await runScriptStep(postTitle, postSummary, formula)
  if (retry && detectHookFormula(retry.hook)) return retry

  // Neither attempt produced a hook matching a known formula - use the better-structured attempt
  // (prefer the retry's beats if it succeeded at all) but swap in the safe title-derived hook
  // rather than shipping a weak, unclassifiable opener.
  const best = retry ?? first
  return { ...best, hook: fallbackHook(postTitle) }
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
