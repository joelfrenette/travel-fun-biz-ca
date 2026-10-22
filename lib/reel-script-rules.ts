import { bannedPhraseHits } from '@/lib/blog-quality'
import { templatedHookQuestion, type PostIdea } from '@/lib/reel-questions'
import type { VideoScript } from '@/lib/video-script'

// Rules for what a reel SAYS and SHOWS as text, kept in one pure place (no network, no model) so the script writer, the edit
// builder and the offline checks agree. Found in the real 21 Oct reel: the voiceover and the burned captions began with the raw
// blog title and a summary line ("Viking River Cruise Germany A Rhine guide for solo travelers Picture a floating hotel ..."),
// which is a brochure line, not a hook.
//
//   1. The first spoken line is the hook, and the hook is a question. It never starts with the blog title.
//   2. No "Picture..." / "Imagine..." scene-setters anywhere (same banned list the blog quality gate uses).

const words = (s: string): string[] => s.toLowerCase().replace(/[^\p{L}\p{N}\s'’]/gu, ' ').split(/\s+/).filter(Boolean)

/** How many leading title words a line has to repeat before it counts as "starts with the blog title". A short title such as
 * "Rhine or Croatia" is also a fine contrast hook, so it only counts when the line is the bare title, not a question. */
const TITLE_PREFIX_WORDS = 6

/** True when `text` begins with the blog title (its first 6 words, or the whole title for a short one that is not turned into a question). */
export function startsWithTitle(text: string, postTitle: string): boolean {
  const t = words(text)
  const title = words(postTitle)
  if (title.length === 0 || t.length === 0) return false
  if (title.length >= TITLE_PREFIX_WORDS) return title.slice(0, TITLE_PREFIX_WORDS).every((w, i) => t[i] === w)
  const same = title.every((w, i) => t[i] === w)
  return same && !text.includes('?')
}

/** The hook is a question: it carries a question mark. */
export function hookIsQuestion(hook: string): boolean {
  return /\?/.test(hook)
}

const SCENE_SETTER_ID = 'picture/imagine opener'

/** A "Picture..." / "Imagine..." scene-setter at the start of the text or of any sentence in it (the blog quality gate's own rule). */
export function hasSceneSetter(text: string): boolean {
  return bannedPhraseHits(text).includes(SCENE_SETTER_ID) || /(?:^|[.!?]\s+)(?:close your eyes|envision|visuali[sz]e)\b/i.test(text)
}

const capitaliseFirst = (s: string) => s.replace(/^(\s*)(\p{L})/u, (_m, sp: string, c: string) => sp + c.toUpperCase())

/** Drops the scene-setter verb from the start of every sentence: "Picture a floating hotel that docks in town." becomes
 * "A floating hotel that docks in town." Pure. A line that is only the verb is left empty. */
export function stripSceneSetters(text: string): string {
  return text
    .replace(/(^|[.!?]\s+)(?:picture|imagine|envision|visuali[sz]e)\b(?:\s+(?:this|that|yourself))?[\s,:;-]*/gi, (_m, lead: string) => lead)
    .replace(/(^|[.!?]\s+)(?:close your eyes)\b[\s,:;.-]*/gi, (_m, lead: string) => lead)
    .split(/(?<=[.!?])\s+/)
    .map(capitaliseFirst)
    .join(' ')
    .trim()
}

/** The words the voice reads, in order: the hook first, then each beat's line. The blog title is never part of it. */
export function reelNarration(script: Pick<VideoScript, 'hook' | 'beats'>): { hook: string; beats: string; all: string } {
  const hook = script.hook.trim()
  const beats = script.beats.map((b) => b.voiceover.trim()).filter(Boolean).join(' ')
  return { hook, beats, all: [hook, beats].filter(Boolean).join(' ') }
}

/** Problems with the hook alone (empty when fine): the title as the hook, not a question, a scene-setter. Pure. */
export function reelHookProblems(hook: string, postTitle: string): string[] {
  const problems: string[] = []
  if (startsWithTitle(hook, postTitle)) problems.push('the hook starts with the blog title')
  if (!hookIsQuestion(hook)) problems.push('the first spoken line is not a question')
  if (hasSceneSetter(hook)) problems.push('the hook is a "Picture/Imagine" scene-setter')
  return problems
}

/** Problems with what the reel says and burns in (empty when fine). Pure. */
export function reelScriptProblems(script: Pick<VideoScript, 'hook' | 'beats'>, postTitle: string): string[] {
  const problems = reelHookProblems(script.hook, postTitle)
  const narration = reelNarration(script).all
  if (startsWithTitle(narration, postTitle)) problems.push('the spoken script starts with the blog title')
  script.beats.forEach((b, i) => {
    if (hasSceneSetter(b.voiceover) || hasSceneSetter(b.onScreenText)) problems.push(`beat ${i + 1} is a "Picture/Imagine" scene-setter`)
  })
  return problems
}

/** Repairs a script without a model call: a hook that starts with the title, is not a question or is a scene-setter is replaced
 * by the templated question built from the post's keyword and destination; scene-setter verbs are stripped from every beat.
 * Pure. */
export function repairReelScript(script: VideoScript, idea: PostIdea): VideoScript {
  const hookBad = startsWithTitle(script.hook, idea.title) || !hookIsQuestion(script.hook) || hasSceneSetter(script.hook)
  const beats = script.beats.map((b) => ({ ...b, voiceover: stripSceneSetters(b.voiceover), onScreenText: stripSceneSetters(b.onScreenText) }))
  return hookBad ? { ...script, beats, hook: templatedHookQuestion(idea), usedFallback: true } : { ...script, beats }
}
