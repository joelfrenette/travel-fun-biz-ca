// Smaller copies of blog cover photos (speed loop). A post cover is uploaded once at full size to the Supabase
// "post-images" bucket (about 900 KB for a 1200px photo). The page shows it at 300 to 740 CSS pixels wide, so phones
// were downloading far more than they draw. Next's own image address (/_next/image) already allows this host
// (next.config.mjs remotePatterns) and returns a resized WebP or AVIF, so one stored address gives the browser a small,
// a medium and a large file to choose from. Only our own post-images bucket is rewritten; any other address (a
// /og/... generated card, a Pexels photo, a site path) is left exactly as it is, with no srcset. Pure; no network.

const SUPABASE_HOST = 'ldwmbwsxrktpcisqaxrb.supabase.co'
const POST_IMAGES_PATH = '/storage/v1/object/public/post-images/'
/** Widths must be in Next's default image size lists (deviceSizes), or /_next/image answers 400. */
export const POST_IMAGE_WIDTHS = [640, 828, 1080, 1200] as const

export const POST_IMAGE_SIZES = {
  /** The big picture at the top of a blog post (article column is 768px wide with 16px padding each side). */
  hero: '(min-width: 768px) 736px, 100vw',
  /** A card in the blog list: three, two or one across. */
  card: '(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw',
} as const

export function isPostImageUrl(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname === SUPABASE_HOST && u.pathname.startsWith(POST_IMAGES_PATH) && !/\.(svg|gif)$/i.test(u.pathname)
  } catch {
    return false
  }
}

/** `srcset` text for a post-images address, or undefined when the address is not one (so the caller omits the attribute). */
export function postImageSrcSet(url: string | null | undefined, widths: readonly number[] = POST_IMAGE_WIDTHS): string | undefined {
  if (!url || !isPostImageUrl(url)) return undefined
  return widths.map((w) => `/_next/image?url=${encodeURIComponent(url)}&w=${w}&q=75 ${w}w`).join(', ')
}
