// The formats a package image actually gets shown in. Joel's complaint (2026-09-26): images
// copied straight from travelfunbiz.com are one size, then get force-fit into every other shape
// the site and social media need — blurry when the site zooms one into a wide banner, or when a
// horizontal photo gets squeezed into a square Instagram post. Fixing that is image processing
// (a smart crop per target shape), not an AI-generation problem — see lib/image-pipeline.ts.
export interface ImageFormatSpec {
  key: 'horizontal' | 'square' | 'portrait' | 'banner'
  width: number
  height: number
  label: string
}

export const IMAGE_FORMATS: ImageFormatSpec[] = [
  { key: 'horizontal', width: 1200, height: 675, label: 'Horizontal (16:9) — package cards, link previews' },
  { key: 'square', width: 1080, height: 1080, label: 'Square (1:1) — Instagram feed' },
  { key: 'portrait', width: 1080, height: 1350, label: 'Portrait (4:5) — Instagram/Facebook feed, Pinterest' },
  { key: 'banner', width: 1600, height: 500, label: 'Banner (3.2:1) — package landing-page hero' },
]

export const IMAGE_FORMAT_KEYS = IMAGE_FORMATS.map((f) => f.key)

export const imageFormatSpec = (key: string): ImageFormatSpec | undefined => IMAGE_FORMATS.find((f) => f.key === key)
