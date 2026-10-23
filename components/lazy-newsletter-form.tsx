"use client"

import dynamic from "next/dynamic"
import { useEffect, useRef, useState } from "react"
import type { Language } from "@/lib/preferences"

// The footer newsletter form pulls in react-hook-form, zod and the resolver (a large share of the JavaScript every
// public page used to download up front). The form sits at the very bottom of the page, so its code now loads only
// when the footer is about to scroll into view (1200px early, so it is ready before anyone sees it). The form itself
// is unchanged; this wrapper only decides when its code arrives. The placeholder holds the form's height so nothing
// jumps when it appears.
const NewsletterForm = dynamic(() => import("@/components/newsletter-form").then((m) => m.NewsletterForm), { ssr: false })

export function LazyNewsletterForm({ className, language }: { className?: string; language: Language }) {
  const ref = useRef<HTMLDivElement>(null)
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (show) return
    const el = ref.current
    if (!el || typeof IntersectionObserver === "undefined") {
      setShow(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShow(true)
          io.disconnect()
        }
      },
      { rootMargin: "1200px 0px" },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [show])

  return (
    <div ref={ref} className={show ? undefined : "min-h-[26rem]"}>
      {show ? <NewsletterForm className={className} language={language} /> : null}
    </div>
  )
}
