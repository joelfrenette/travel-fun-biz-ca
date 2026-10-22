import { socialCoverUrl, COVER_ALT_MAX, type SocialCoverKind } from '@/lib/social-cover'
import { gateRenderedUrl, gateSummary, type GateKind } from '@/lib/visual-gate'
import type { GateSurface } from '@/lib/visual-gate-stats'

// Runs the visual quality gate (lib/visual-gate.ts) over the composed single-image Instagram cover and walks the
// retries: the plain cover, then ?alt=1 (next photo, headline cut to 4 words), then ?alt=2 (the next photo again,
// 3 words). Pure orchestration with an injectable fetch, so scripts/check-visual-gate.ts can test it offline.

/** Cover design names stored in the variant tags so engagement can be compared per template. */
export type CoverTemplate = 'red-block-v1' | 'teal-fact' | 'news-card' | 'reel-red-v1'

export interface CoverGateOutcome {
  /** pass: send `url`. skip: every try failed its checks, do not post. deferred: the check could not run (fetch or decode
   * failed), try again next tick. budget: out of time before a verdict, try again next tick. */
  status: 'pass' | 'skip' | 'deferred' | 'budget'
  /** The address that passed (status pass only). */
  url?: string
  /** 0 for the plain cover, 1 or 2 for a retry that passed or was the last tried. */
  attempt: number
  /** Retries actually rendered (for the counters). */
  retries: number
  reasons: string[]
  photoId: string | null
  template: CoverTemplate
}

export interface CoverGateInput {
  base: string
  kind: SocialCoverKind
  slug: string
  /** True while there is time for another render. Checked before every try. */
  hasTime: () => boolean
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export const templateForKind = (kind: SocialCoverKind): CoverTemplate => (kind === 'news' ? 'news-card' : 'red-block-v1')

export async function gateComposedCover(input: CoverGateInput): Promise<CoverGateOutcome> {
  const gateKind: GateKind = input.kind === 'news' ? 'news' : 'cover'
  let template = templateForKind(input.kind)
  let lastReasons: string[] = []
  let lastPhoto: string | null = null
  let retries = 0
  for (let alt = 0; alt <= COVER_ALT_MAX; alt++) {
    if (!input.hasTime()) return { status: 'budget', attempt: alt, retries, reasons: lastReasons, photoId: lastPhoto, template }
    if (alt > 0) retries++
    const url = socialCoverUrl(input.base, input.kind, input.slug, alt)
    const r = await gateRenderedUrl(url, gateKind, input.fetchImpl, input.timeoutMs)
    if (r.infra) return { status: 'deferred', attempt: alt, retries, reasons: r.reasons, photoId: lastPhoto, template }
    const header = r.template
    if (header === 'red-block-v1' || header === 'news-card') template = header
    lastPhoto = r.photoId ?? lastPhoto
    if (r.ok) return { status: 'pass', url, attempt: alt, retries, reasons: [], photoId: r.photoId ?? null, template }
    lastReasons = r.reasons
  }
  return { status: 'skip', attempt: COVER_ALT_MAX, retries, reasons: lastReasons, photoId: lastPhoto, template }
}

/** The variant tags for one gated visual: which design, how the gate went, which photo. `surface` keeps feed, carousel and
 * reel from overwriting each other; the un-suffixed keys hold the latest. */
export function visualTags(surface: GateSurface, template: CoverTemplate, result: { ok: boolean; reasons: string[]; retries?: number }, photoId?: string | null): Record<string, unknown> {
  const gate = result.ok ? (result.retries ? `pass-after-${result.retries}-retry` : 'pass') : gateSummary(result)
  return {
    cover_template: template,
    [`cover_template:${surface}`]: template,
    gate_result: gate,
    [`gate_result:${surface}`]: gate,
    ...(photoId ? { photo_id: photoId, [`photo_id:${surface}`]: photoId } : {}),
  }
}
