import { callAnthropic, anthropicText, parseModelJson, isAiConfigured } from '@/lib/ai-verify'
import { ungroundedNumbers, repairDashes, normaliseHashtags } from '@/lib/hook-styles'
import { isValidCoverHeadline, fallbackCoverHeadline, shortestWholePhrase, pickReelCoverTitle } from '@/lib/cover-headline'
import { templatedHookQuestion, commentBaitQuestion, isAcceptableHook, type PostIdea } from '@/lib/reel-questions'
import { repairReelScript, reelHookProblems } from '@/lib/reel-script-rules'
import { loadLearnedRules, withLearnedRules } from '@/lib/learn-loop'
import { REEL_MIN_BEATS, REEL_MAX_BEATS, PATTERN_INTERRUPT_INDEX, BEAT_VO_MIN_WORDS, BEAT_VO_MAX_WORDS, INTERRUPT_VO_MAX_WORDS, BEAT_TEXT_MAX_WORDS, wordsIn } from '@/lib/reel-beats'

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
  /** Short scroll-stopping headline for the opening cover card (3-5 words, see reelCoverTitleFor). */
  coverTitle?: string
  beats: VideoBeat[]
  title: string
  description: string
  hashtags: string[]
  /** True when no model hook passed the checks and the templated question (built from the keyword and destination) was used instead. */
  usedFallback?: boolean
  /** Pacing problems still present after the repair (too few beats, a voiceover line too long). Empty or absent means the script is clean. */
  warnings?: string[]
}

/** What the script writer may read about the post besides the title and summary. */
export interface ReelPostContext {
  /** The post body (markdown or html); only its first 600 words are used. */
  body?: string | null
  primaryKeyword?: string | null
  destination?: string | null
}

export const BODY_EXCERPT_WORDS = 600

/** The first `maxWords` words of a post body as plain text: markdown images, links, headings, html tags and code marks are
 * stripped. Pure. Empty input gives an empty string. */
export function bodyExcerpt(body: string | null | undefined, maxWords = BODY_EXCERPT_WORDS): string {
  if (!body) return ''
  const text = body
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_`>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.split(' ').filter(Boolean).slice(0, maxWords).join(' ')
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
  story: { hook: 'open with a short second-person question ("Would you step off a ship into a new town every day?") in general travel terms, never as something we did or a named traveller', cover: 'a short scene-setting headline' },
}

export function scriptPrompt(postTitle: string, postSummary: string, formulaHint?: HookFormula, facts?: string, ctx?: ReelPostContext): string {
  const factsBlock = facts && facts.trim() ? `
Facts you may use (from the post's stored key takeaways and FAQ answers):
${facts.trim()}
Nothing outside the Title, Summary and Facts may be asserted.
` : ''
  const excerpt = bodyExcerpt(ctx?.body)
  const keyword = (ctx?.primaryKeyword ?? '').trim()
  // The post's own opening text, so the beats can name real details instead of generic travel lines. It is context, not a
  // licence to add anything: every claim must still be in the post.
  const excerptBlock = excerpt
    ? `
${keyword ? `Primary keyword: ${keyword}\n` : ''}The first part of the post itself (use its real details; do not assert anything that is not in the post):
${excerpt}
`
    : keyword
      ? `\nPrimary keyword: ${keyword}\n`
      : ''
  const formulaNote = formulaHint
    ? `Your hook formula must specifically be: ${formulaHint} (${FORMULA_NOTES[formulaHint].hook}). Write the coverTitle in the same spirit: ${FORMULA_NOTES[formulaHint].cover}.`
    : `Pick ONE of these hook formulas and use it: ${HOOK_FORMULAS.join(', ')}.`
  return `You are writing a short-form video script (under 60 seconds spoken) for a travel agency's social media, based on this blog post:

Title: ${postTitle}
Summary: ${postSummary}
${factsBlock}${excerptBlock}
${NO_FABRICATION}

The hook is the first spoken line - it has to earn the next 2 seconds of attention. ${formulaNote} A weak hook is a vague scene-setter ("Have you ever wondered about..."); a strong one states something specific and surprising in one breath. The hook MUST be a question of 3 to 12 words ("Rhine or Croatia: which one are you?", "Are you packing the wrong shoes?"). Never start the hook, or any beat, with the post title, and never use a "Picture..." or "Imagine..." scene-setter anywhere in the script.

Also write coverTitle: the headline printed big on the opening cover frame of the video, 3 to 5 words and at most 36 characters, built to stop a thumb mid-scroll (curiosity, contrast or a bold promise), plain words, no emoji, no hashtags, no colon or dash, never ending on and, the, to, of, in, a, for, with, or, at or on. It may only promise what the post itself supports - never invent a price, number, date or place that is not in the title or summary above.

Pacing: a reel needs a new picture every 3 to 4 seconds. Write ${REEL_MIN_BEATS} to ${REEL_MAX_BEATS} beats after the hook. Each beat needs: a scene description (what b-roll footage would show, for searching stock clips - never shown to the viewer; a different scene every beat), on-screen text of at most ${BEAT_TEXT_MAX_WORDS} words (every beat has some), one spoken voiceover line of ${BEAT_VO_MIN_WORDS} to ${BEAT_VO_MAX_WORDS} words (natural spoken pace, not written prose, one idea), and 2-4 English search terms for finding a matching stock video clip.

Beat 3 is a pattern interrupt: a 2 second jolt of at most ${INTERRUPT_VO_MAX_WORDS} words that breaks the rhythm (a blunt claim or a surprising contrast taken from the post), with its own short on-screen text.

The LAST beat is the comment-bait question: one short question that comes from the post and that a viewer wants to answer in the comments (for example "Boat or boots: which one are you?" for a post comparing two travel styles). Its voiceover ends with a question mark. Do not write a call-to-action beat and do not mention a link, a bio or the website: an end card with the site name and the call to action is added automatically after your last beat. No urgency, no price or offer claims.

Keep the WHOLE spoken script (hook + every beat's voiceover line, read aloud, back to back) under 120 words total.

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
  ['story', /^(?:close your eyes|you(?:'re| are| step| wake| walk| arrive| land| turn)|it'?s (?:early|late|\d)|the (?:first|last) time)\b|\b(?:one (?:morning|evening|afternoon|night))\b/],
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
  // The loosened classifier (lib/reel-questions.ts) also accepts a contrast "X or Y" and a short second-person opener.
  if (/\S+\s+(?:or|vs\.?|versus)\s+\S+/.test(h) && isAcceptableHook(hook)) return 'comparison'
  if (isAcceptableHook(hook)) return 'story'
  return null
}

const ideaOf = (postTitle: string, ctx?: ReelPostContext): PostIdea => ({ title: postTitle, keyword: ctx?.primaryKeyword, destination: ctx?.destination })

/** Pacing problems in a list of beats (empty when fine): 8 to 10 beats, on-screen text of 1 to 7 words on every beat, a voiceover
 * line of 6 to 10 words (at most 5 on beat 3, the pattern interrupt), and the last beat is a question. Pure. */
export function beatProblems(beats: ReadonlyArray<VideoBeat>): string[] {
  const problems: string[] = []
  if (beats.length < REEL_MIN_BEATS) problems.push(`only ${beats.length} beats (need ${REEL_MIN_BEATS} to ${REEL_MAX_BEATS})`)
  if (beats.length > REEL_MAX_BEATS) problems.push(`${beats.length} beats (at most ${REEL_MAX_BEATS})`)
  beats.forEach((b, i) => {
    const n = i + 1
    const text = wordsIn(b.onScreenText)
    if (text < 1) problems.push(`beat ${n} has no on-screen text`)
    if (text > BEAT_TEXT_MAX_WORDS) problems.push(`beat ${n} on-screen text is over ${BEAT_TEXT_MAX_WORDS} words`)
    const vo = wordsIn(b.voiceover)
    if (i === PATTERN_INTERRUPT_INDEX) {
      if (vo > INTERRUPT_VO_MAX_WORDS) problems.push(`beat ${n} (pattern interrupt) voiceover is over ${INTERRUPT_VO_MAX_WORDS} words`)
    } else if (i === beats.length - 1) {
      // The closing question is short on purpose; only the upper limit applies.
      if (vo > BEAT_VO_MAX_WORDS + 2) problems.push(`beat ${n} voiceover is too long`)
    } else if (vo > BEAT_VO_MAX_WORDS) problems.push(`beat ${n} voiceover is over ${BEAT_VO_MAX_WORDS} words`)
    else if (vo < BEAT_VO_MIN_WORDS) problems.push(`beat ${n} voiceover is under ${BEAT_VO_MIN_WORDS} words`)
  })
  const last = beats[beats.length - 1]
  if (last && !last.voiceover.trim().endsWith('?')) problems.push('the last beat is not a question')
  return problems
}

const limitWords = (text: string, max: number) => text.trim().split(/\s+/).filter(Boolean).slice(0, max).join(' ').replace(/[,:;\-\s]+$/, '')

/** Shapes a model script to the reel rules without a second model call: on-screen text is cut to 7 words, beats beyond 10 are dropped
 * from the middle (never the opener, beat 3 or the last), and when the last beat is not a question the comment-bait question built
 * from the post replaces it (or is added when there is room). Any problem that is left is listed in `warnings`. Pure. */
export function shapeBeats(rawScript: VideoScript, idea: PostIdea): VideoScript {
  // Rules first: no hook that starts with the blog title or is not a question, no "Picture..." scene-setters (lib/reel-script-rules.ts).
  const script = repairReelScript(rawScript, idea)
  let beats: VideoBeat[] = script.beats.map((b) => ({ ...b, onScreenText: limitWords(b.onScreenText, BEAT_TEXT_MAX_WORDS) }))
  while (beats.length > REEL_MAX_BEATS) beats.splice(Math.max(PATTERN_INTERRUPT_INDEX + 1, Math.floor(beats.length / 2)), 1)
  const last = beats[beats.length - 1]
  if (!last || !last.voiceover.trim().endsWith('?')) {
    const bait = commentBaitQuestion(idea)
    const closing: VideoBeat = { scene: 'a wide scenic shot to close on', onScreenText: bait.onScreen, voiceover: bait.voiceover, brollSearchTerms: last?.brollSearchTerms?.length ? last.brollSearchTerms : ['travel scenic'] }
    beats = beats.length < REEL_MAX_BEATS ? [...beats, closing] : [...beats.slice(0, -1), closing]
  }
  const warnings = beatProblems(beats)
  return { ...script, beats, warnings: warnings.length ? warnings : undefined }
}

async function runScriptStep(postTitle: string, postSummary: string, formulaHint?: HookFormula, facts?: string, ctx?: ReelPostContext): Promise<VideoScript | null> {
  const r = await callAnthropic({ max_tokens: 2500, messages: [{ role: 'user', content: withLearnedRules(scriptPrompt(postTitle, postSummary, formulaHint, facts, ctx), await loadLearnedRules('reel')) }] }, { timeoutMs: 40_000, feature: 'video-script' })
  if (!r || !r.res.ok) return null
  const parsed = parseModelJson<Partial<VideoScript>>(anthropicText(await r.res.json()))
  if (!parsed || typeof parsed.hook !== 'string' || !Array.isArray(parsed.beats) || parsed.beats.length === 0) return null
  const beats = parsed.beats
    .filter((b): b is VideoBeat => !!b && typeof b.scene === 'string' && typeof b.onScreenText === 'string' && typeof b.voiceover === 'string')
    .map((b) => ({ ...b, brollSearchTerms: Array.isArray(b.brollSearchTerms) ? b.brollSearchTerms.filter((t): t is string => typeof t === 'string') : [] }))
  if (beats.length === 0) return null
  // The cover headline is public text on the first frame: any number in it must come from the post.
  const knownNumbers = new Set(`${postTitle} ${postSummary} ${facts ?? ''}`.match(/\d+/g) ?? [])
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
    hashtags: Array.isArray(parsed.hashtags) ? normaliseHashtags(parsed.hashtags) : [],
  }
}

/** The two checks a model script has to pass, as one pure function so the offline checks can run it without a model:
 * the hook is acceptable (a question, an "X or Y" contrast or a short second-person line) and has no number that is not in the
 * post, and the beats follow the pacing rules. `groundingText` is everything the post may be quoted on (title, summary, facts, excerpt). */
export function scriptChecks(script: VideoScript, groundingText: string, postTitle?: string): { hookOk: boolean; beatProblems: string[] } {
  return {
    hookOk:
      ungroundedNumbers(script.hook, groundingText).length === 0 &&
      isAcceptableHook(script.hook) &&
      (postTitle === undefined || reelHookProblems(script.hook, postTitle).length === 0),
    beatProblems: beatProblems(script.beats),
  }
}

/** Generates a video script grounded in a real post's title, summary, facts and the first 600 words of its body. One rewrite
 * attempt is made when the hook fails the loosened check or the beats break the pacing rules (8 to 10 beats); after that the
 * better attempt is shaped in code (shapeBeats) and, when the hook is still no good, a templated question built from the primary
 * keyword and destination is used (never the raw blog title). Returns null only when AI is unconfigured or every attempt fails
 * outright - never blocks on a "perfect" script. */
export async function generateVideoScript(postTitle: string, postSummary: string, preferredFormula?: HookFormula, facts?: string, ctx?: ReelPostContext): Promise<VideoScript | null> {
  if (!isAiConfigured()) return null

  const idea = ideaOf(postTitle, ctx)
  // A hook with a number that is not in the post is never kept (same rule the cover headline has).
  // Spelled-out numbers (two..twelve, dozen, hundred, thousand) count too. The post's own first 600 words count as the post.
  const grounding = `${postTitle} ${postSummary} ${facts ?? ''} ${bodyExcerpt(ctx?.body)}`
  const okAll = (s: VideoScript) => {
    const c = scriptChecks(s, grounding, postTitle)
    return c.hookOk && c.beatProblems.length === 0
  }

  const first = await runScriptStep(postTitle, postSummary, preferredFormula, facts, ctx)
  if (!first) return null
  const firstShaped = shapeBeats(first, idea)
  // The raw model hook is checked too (shapeBeats may already have swapped a bad hook for the templated question): a bad raw hook earns one rewrite.
  const rawOk = (s: VideoScript) => {
    const c = scriptChecks(s, grounding, postTitle)
    return c.hookOk && c.beatProblems.length === 0
  }
  if (okAll(firstShaped) && rawOk(first)) return firstShaped

  // The retry keeps the rotation's choice when there is one; otherwise it picks a formula at random as before.
  const formula = preferredFormula ?? HOOK_FORMULAS[Math.floor(Math.random() * HOOK_FORMULAS.length)]
  const retry = await runScriptStep(postTitle, postSummary, formula, facts, ctx)
  const retryShaped = retry ? shapeBeats(retry, idea) : null
  if (retryShaped && okAll(retryShaped) && rawOk(retry as VideoScript)) return retryShaped

  // Neither attempt was clean: take the one with fewer pacing problems and the better hook, shaped in code; a hook that still
  // fails is replaced by the templated question (the raw blog title is never used as the hook).
  const candidates = [firstShaped, retryShaped].filter((s): s is VideoScript => !!s)
  const score = (s: VideoScript) => (scriptChecks(s, grounding, postTitle).hookOk ? 0 : 100) + (s.warnings?.length ?? 0)
  const best = candidates.reduce((a, b) => (score(b) < score(a) ? b : a))
  if (scriptChecks(best, grounding, postTitle).hookOk) return best
  return { ...best, hook: templatedHookQuestion(idea), usedFallback: true }
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

/** The cover card headline: the model's when it passes the cover headline rules (lib/cover-headline.ts),
 * else a whole short phrase of the post's own title (never a word-count slice, which made fragments
 * such as "ERTO PLATA TRIP AND"). If no phrase of the title works, the model's own whole headline is
 * kept as it was, and failing that the shortest whole title phrase. Never invents anything. */
/** The reel cover headline (frame 0): the model's coverTitle when it passes the cover rules and the 5 word reel limit,
 * else the post title's own whole phrases (see pickReelCoverTitle). `ok` false means nothing valid exists: do not render. */
export function reelCoverTitleFor(script: VideoScript, postTitle: string, preferred?: string | null): { title: string; ok: boolean; reasons: string[]; usedFallback: boolean } {
  return pickReelCoverTitle([preferred, script.coverTitle, coverTitleFor(script, postTitle)], postTitle, `${postTitle} ${script.title ?? ''}`)
}

export function coverTitleFor(script: VideoScript, postTitle: string): string {
  if (script.coverTitle && isValidCoverHeadline(script.coverTitle, `${postTitle} ${script.title ?? ''}`)) return script.coverTitle
  const fallback = fallbackCoverHeadline(postTitle)
  if (fallback) return fallback
  if (script.coverTitle) return script.coverTitle
  return shortestWholePhrase(postTitle)
}
