"use client"

import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import { defaultThumb, usableImageUrl, type ThumbType } from "@/lib/post-defaults"

const SIZES = {
  // 4:3 list thumbnail
  sm: { w: 64, h: 48 },
  md: { w: 96, h: 72 },
  // 1:1 crop (the default art is centred, so nothing important is cut)
  square: { w: 48, h: 48 },
} as const

export type PostThumbSize = keyof typeof SIZES

interface Props {
  /** The post's own cover / hero / image address. Blank or a broken link falls back to the default for `type`. */
  src?: string | null
  alt: string
  type: ThumbType | string
  size?: PostThumbSize
  className?: string
}

/** A small picture for a post row. Plain <img> on purpose: covers come from Pexels and Supabase and other hosts that
 * are not all allowed in next.config, which is how the rest of the site renders them too. */
export function PostThumb({ src, alt, type, size = "sm", className }: Props) {
  const own = usableImageUrl(src)
  const fallback = defaultThumb(type)
  const [current, setCurrent] = useState(own ?? fallback)
  useEffect(() => setCurrent(own ?? fallback), [own, fallback])
  const { w, h } = SIZES[size]
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={current}
      alt={alt}
      width={w}
      height={h}
      loading="lazy"
      decoding="async"
      onError={() => { if (current !== fallback) setCurrent(fallback) }}
      className={cn("shrink-0 rounded border bg-muted object-cover", className)}
      style={{ width: w, height: h }}
    />
  )
}

export default PostThumb
