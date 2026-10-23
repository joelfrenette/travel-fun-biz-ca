import { pickPostImage, type SocialCoverKind } from '@/lib/social-cover'
import { gateComposedCover, type CoverGateOutcome } from '@/lib/cover-gate'
import type { PostingTarget } from '@/lib/social-provider'
import type { UploadPostSendResult } from '@/lib/upload-post'

// The single place that decides what picture a social post goes out with. Owner's rule (2026-10-22): EVERY post on EVERY network carries
// an image, a carousel, a reel or a video. There is no text-and-link-only post. A row that cannot get a checked image is closed as done
// with NO_IMAGE_NOTE (a silent, counted skip), never failed and never sent as text.
//
// Why: a "You asked: ... Read the full guide: <link>" recap went to Bluesky as text only. The recap had no image by design, and a blog
// post with no cover photo, or a news card that could not be composed, fell back to text too.

export const NO_IMAGE_NOTE = 'Skipped: no image (not posted as text)'

/** After this long into a pass, no new cover verification starts (the cron function limit is 60 seconds and each verify can take up to VERIFY_TIMEOUT_MS). */
export const VERIFY_BUDGET_MS = 35_000

export type ImageOutcome =
  /** Send this address. `gate` is null when the cover already passed on this warm instance and was not re-checked. */
  | { status: 'send'; url: string; gate: CoverGateOutcome | null }
  /** The card could not even be composed (no title or an unusable slug). Close the row with NO_IMAGE_NOTE. */
  | { status: 'no-image'; reason: string }
  /** The card was rendered and failed its checks after every retry. Close the row with NO_IMAGE_NOTE and the reason. */
  | { status: 'gate-skip'; gate: CoverGateOutcome }
  /** The check itself could not run. Try again next tick. */
  | { status: 'deferred'; gate: CoverGateOutcome }
  /** Out of time. Leave the row queued for the next tick. `gate` is set when it ran out mid-check (its retries still count). */
  | { status: 'budget'; gate: CoverGateOutcome | null }

export interface ResolveImageInput {
  base: string
  kind: SocialCoverKind
  slug: string
  title: string | null | undefined
  coverUrl: string | null | undefined
  /** Date.now() at the start of the pass. */
  passStart: number
  /** Composed cover URLs that already verified OK on this warm instance. */
  verified: Set<string>
  now?: () => number
  budgetMs?: number
  /** Injectable for the offline check. */
  gate?: typeof gateComposedCover
}

/** Composes the row's card and runs it through the visual gate. Never returns a bare photo and never "no media". */
export async function resolveRowImage(i: ResolveImageInput): Promise<ImageOutcome> {
  const now = i.now ?? Date.now
  const budget = i.budgetMs ?? VERIFY_BUDGET_MS
  const gate = i.gate ?? gateComposedCover
  const picked = pickPostImage({ base: i.base, kind: i.kind, slug: i.slug, title: i.title, coverUrl: i.coverUrl })
  if (!picked.composed || !picked.url) return { status: 'no-image', reason: 'the card could not be composed (no usable title or slug)' }
  const overBudget = now() - i.passStart > budget
  if (overBudget && !i.verified.has(picked.url)) return { status: 'budget', gate: null }
  if (overBudget) return { status: 'send', url: picked.url, gate: null } // already passed the gate on this warm instance
  const gated = await gate({ base: i.base, kind: i.kind, slug: i.slug, hasTime: () => now() - i.passStart <= budget })
  if (gated.status === 'budget') return { status: 'budget', gate: gated }
  if (gated.status === 'deferred') return { status: 'deferred', gate: gated }
  if (gated.status === 'skip') return { status: 'gate-skip', gate: gated }
  i.verified.add(gated.url as string)
  return { status: 'send', url: gated.url as string, gate: gated }
}

/** The ledger note for a row closed because it has no checked image. */
export function noImageNote(reason: string, retries = 0): string {
  return `${NO_IMAGE_NOTE}: ${retries ? `the image failed the quality check after ${retries} retries (${reason})` : reason}`.slice(0, 300)
}

/** The one send function for a post. It always sends the image; with no image it refuses before any provider is called. */
export function sendWithMedia(target: Pick<PostingTarget, 'sendPhotos'>, imageUrl: string | null | undefined): (platforms: string[], text: string) => Promise<UploadPostSendResult> {
  const image = (imageUrl ?? '').trim()
  if (!image) throw new Error(NO_IMAGE_NOTE)
  return (platforms, text) => target.sendPhotos(platforms, text, [image])
}
