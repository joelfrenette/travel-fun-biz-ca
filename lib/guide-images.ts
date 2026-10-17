// Image sizes for guide pages (growth loop WP16, part 5). A guide's hero photo is a stock photo from Pexels. Pexels'
// image address takes a width in the query string, so one stored address gives the browser a small, a medium and a
// large file to choose from (a srcset) instead of one big one. Only Pexels addresses are rewritten; any other
// address (a photo someone added by hand) is left exactly as it is, with no srcset, because we cannot know it would
// honour a width. Pure; no network.

export const HERO_WIDTHS = [480, 800, 1200, 1600] as const

/** The sizes attribute to pair with the srcset: how wide the picture is drawn at each screen width. */
export const HERO_SIZES = {
  /** The big picture at the top of a guide page (the article column is 896px wide at most). */
  page: '(min-width: 896px) 896px, 100vw',
  /** The picture in the right-hand feature card of a guide header (22rem wide on desktop, full width on mobile). */
  header: '(min-width: 1024px) 352px, 100vw',
  /** A card in a grid of three, two or one. */
  card: '(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw',
} as const

/** `srcset` text for a Pexels photo address, or null when the address is not one (so the caller omits the attribute). */
export function heroSrcSet(url: string | null | undefined): string | null {
  if (!url) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'images.pexels.com') return null
  return HERO_WIDTHS.map((w) => {
    const u = new URL(parsed.toString())
    u.searchParams.delete('h')
    u.searchParams.delete('dpr')
    u.searchParams.set('auto', 'compress')
    u.searchParams.set('cs', 'tinysrgb')
    u.searchParams.set('w', String(w))
    return `${u.toString()} ${w}w`
  }).join(', ')
}
