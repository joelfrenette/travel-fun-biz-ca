// Reel pacing rules shared by the script writer (lib/video-script.ts) and the edit builder (lib/shotstack.ts).
// Pure constants and one pure function, no imports, so both files and the offline checks can use them.
//
// A reel needs a visual change every 2 to 4 seconds. The old script had 4 to 6 beats of about 10 seconds each; now it has
// 8 to 10 beats of 3 to 4 seconds, beat 3 is a 2 second pattern interrupt, and the last beat before the end card is a
// comment-bait question.

export const REEL_MIN_BEATS = 8
export const REEL_MAX_BEATS = 10
/** The pattern interrupt is beat 3 (index 2). */
export const PATTERN_INTERRUPT_INDEX = 2
export const BEAT_MIN_SECONDS = 3
export const BEAT_MAX_SECONDS = 4
export const INTERRUPT_SECONDS = 2
/** Natural narration pace (2.5 words a second), the same figure the rest of the reel code uses. */
export const SECONDS_PER_WORD = 1 / 2.5
/** Voiceover size that fits a normal beat (about 3 to 4 seconds) and the pattern interrupt (about 2 seconds). */
export const BEAT_VO_MIN_WORDS = 6
export const BEAT_VO_MAX_WORDS = 10
export const INTERRUPT_VO_MAX_WORDS = 5
/** On-screen text on each beat: 7 words at most (the same limit lib/shotstack.ts enforces when drawing it). */
export const BEAT_TEXT_MAX_WORDS = 7

export const wordsIn = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length

/** How long beat `index` stays on screen. The narration is ONE continuous voice clip, so a beat's length follows its spoken
 * words (that keeps picture and voice in step); it is never shorter than 3 seconds (2 for the pattern interrupt). A line of
 * 6 to 10 words is 3 to 4 seconds, which is what the script prompt and the checks ask for. Rounded to a tenth of a second. */
export function reelBeatSeconds(voiceover: string, index: number): number {
  const spoken = wordsIn(voiceover) * SECONDS_PER_WORD
  const floor = index === PATTERN_INTERRUPT_INDEX ? INTERRUPT_SECONDS : BEAT_MIN_SECONDS
  return Math.round(Math.max(floor, spoken) * 10) / 10
}
