// Pure, deterministic text fitting for the Instagram carousel slides (no database, no network, no
// fonts loaded here). Satori has no reliable auto-shrink, so the route asks these functions for the
// font size and the exact lines, then draws every line as its own non-wrapping row. The word-wrap
// itself is wrapTitle from lib/og-path.ts (the share-image route uses the same idea in fitTitle).
import { wrapTitle } from '@/lib/og-path'

export interface FitResult {
  lines: string[]
  fontSize: number
  truncated: boolean
}

export interface FitOptions {
  /** Width of the text area in pixels (the box minus its padding). */
  boxWidth: number
  /** Candidate font sizes, biggest first. The first one whose wrap fits wins. */
  sizes: readonly number[]
  maxLines: number
  /** Average glyph width as a share of the font size; kept a little wide so lines never overflow. */
  glyphWidth: number
  /** Optional: the lines together (lines x size x lineHeight) may not be taller than this. */
  maxHeight?: number
  lineHeight?: number
}

function descending(from: number, to: number, step: number): number[] {
  const out: number[] = []
  for (let s = from; s >= to; s -= step) out.push(s)
  if (out[out.length - 1] !== to) out.push(to)
  return out
}

/** Biggest size in `opts.sizes` where the text wraps into `maxLines` lines without cutting or splitting a word. */
export function fitText(text: string, opts: FitOptions): FitResult {
  const clean = text.replace(/\s+/g, ' ').trim()
  const longest = clean.split(' ').reduce((m, w) => Math.max(m, w.length), 0)
  for (const size of opts.sizes) {
    const maxChars = Math.floor(opts.boxWidth / (size * opts.glyphWidth))
    if (maxChars < 1 || longest > maxChars) continue
    const wrapped = wrapTitle(clean, maxChars, opts.maxLines)
    const tooTall = opts.maxHeight !== undefined && wrapped.lines.length * size * (opts.lineHeight ?? 1.1) > opts.maxHeight
    if (!wrapped.truncated && !tooTall) return { lines: wrapped.lines, fontSize: size, truncated: false }
  }
  // Nothing fits: smallest size, cut with an ellipsis (wrapTitle also splits a word that is wider than a line).
  const size = opts.sizes[opts.sizes.length - 1]
  const wrapped = wrapTitle(clean, Math.max(1, Math.floor(opts.boxWidth / (size * opts.glyphWidth))), opts.maxLines)
  return { lines: wrapped.lines, fontSize: size, truncated: wrapped.truncated }
}

// ---- Cover headline (slide 1) --------------------------------------------------------------------

export const COVER_W = 1080
export const COVER_H = 1350
export const COVER_MAX_BLOCK_WIDTH = 880
export const COVER_PAD_X = 40
export const COVER_PAD_Y = 28
export const COVER_MAX_FONT = 120
export const COVER_MIN_FONT = 72
export const COVER_MAX_LINES = 3
export const COVER_LINE_HEIGHT = 1.05
/** Inter 800 in capitals is wide; 0.70 of the font size per glyph is deliberately on the safe side. */
export const COVER_GLYPH_WIDTH = 0.7

/** Headline font size (120 down to 72 in steps of 4) and exact lines, 3 lines at most. Upper-cases the text first. */
export function fitCoverHeadline(headline: string): FitResult {
  return fitText(headline.toUpperCase(), {
    boxWidth: COVER_MAX_BLOCK_WIDTH - COVER_PAD_X * 2,
    sizes: descending(COVER_MAX_FONT, COVER_MIN_FONT, 4),
    maxLines: COVER_MAX_LINES,
    glyphWidth: COVER_GLYPH_WIDTH,
  })
}

/** Height in pixels of the red block for a fit result (lines plus vertical padding). */
export function coverBlockHeight(fit: FitResult): number {
  return Math.ceil(fit.lines.length * fit.fontSize * COVER_LINE_HEIGHT + COVER_PAD_Y * 2)
}

// ---- Teal fact card (inner slide) ------------------------------------------------------------------

export const FACT_MAX_WORDS = 14
export const FACT_MAX_FONT = 140
export const FACT_MIN_FONT = 96
export const FACT_BOX_WIDTH = 880
export const FACT_MAX_LINES = 7
export const FACT_LINE_HEIGHT = 1.12
/** Room for the claim: the card minus 200px top and bottom (brand tag above, dots below). */
export const FACT_MAX_HEIGHT = 950

/** Claim font size (140 down to 96) and exact lines for a fact card. Mixed case, so narrower glyphs than the cover. */
export function fitFactClaim(claim: string): FitResult {
  return fitText(claim, {
    boxWidth: FACT_BOX_WIDTH,
    sizes: descending(FACT_MAX_FONT, FACT_MIN_FONT, 4),
    maxLines: FACT_MAX_LINES,
    glyphWidth: 0.6,
    maxHeight: FACT_MAX_HEIGHT,
    lineHeight: FACT_LINE_HEIGHT,
  })
}

// ---- Photo slide text panel (inner slide) ----------------------------------------------------------

export const PANEL_BODY_MIN_FONT = 48
export const PANEL_BOX_WIDTH = 800

export function fitPanelHeadline(headline: string): FitResult {
  return fitText(headline, { boxWidth: PANEL_BOX_WIDTH, sizes: [68, 64, 60, 56, 52], maxLines: 3, glyphWidth: 0.6 })
}

/** Body text on the solid panel: 52px, or 48px (never smaller), at most 7 lines. */
export function fitPanelBody(body: string): FitResult {
  return fitText(body, { boxWidth: PANEL_BOX_WIDTH, sizes: [52, PANEL_BODY_MIN_FONT], maxLines: 7, glyphWidth: 0.55 })
}

/** "travelfunbiz.ca" style host from a site URL, upper-cased for the brand strip. Falls back to the input. */
export function brandDomain(siteUrl: string): string {
  try {
    return new URL(siteUrl).hostname.replace(/^www\./i, '').toUpperCase()
  } catch {
    return siteUrl.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '').toUpperCase()
  }
}
