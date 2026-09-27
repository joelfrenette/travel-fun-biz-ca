// A trip recap's video can be a YouTube/Vimeo link (the common case an admin pastes) or a direct
// file URL (something uploaded to Supabase storage). Pure so the URL-matching is covered by a
// real assertion; the caller (components/trip-video.tsx) decides how to render each case.
export interface VideoEmbed {
  provider: 'youtube' | 'vimeo'
  embedUrl: string
}

const YOUTUBE_PATTERNS = [
  /(?:youtube\.com\/watch\?v=|youtube\.com\/embed\/|youtube\.com\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{6,})/,
]
const VIMEO_PATTERN = /vimeo\.com\/(?:video\/)?(\d+)/

/** Recognizes a YouTube or Vimeo link and returns its embeddable iframe URL. Returns null for
 * anything else (a direct video file, or not a URL at all) — the caller then renders a native
 * <video> tag pointing straight at the original URL instead. */
export function videoEmbed(url: string | null | undefined): VideoEmbed | null {
  const trimmed = (url ?? '').trim()
  if (!trimmed) return null

  for (const pattern of YOUTUBE_PATTERNS) {
    const m = trimmed.match(pattern)
    if (m) return { provider: 'youtube', embedUrl: `https://www.youtube.com/embed/${m[1]}` }
  }

  const vimeoMatch = trimmed.match(VIMEO_PATTERN)
  if (vimeoMatch) return { provider: 'vimeo', embedUrl: `https://player.vimeo.com/video/${vimeoMatch[1]}` }

  return null
}
