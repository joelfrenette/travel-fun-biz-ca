"use client"

import { useEffect } from "react"
import { CookieBanner } from "@/components/cookie-banner"
import type { Language } from "@/lib/preferences"

// Everything that used to need the visitor's language in the ROOT layout, moved next to the page content so the root
// layout can stay free of cookies (which is what lets the default pages be cached; see lib/cache-routing.ts).
//  - The consent banner is drawn here, in the page's own language.
//  - <html lang> is set to that language. The root layout always sends lang="en" in the HTML; for a visitor who chose
//    French or Spanish this corrects it right after the page loads (before any interaction).
export function LocaleEffects({ language }: { language: Language }) {
  useEffect(() => {
    if (document.documentElement.lang !== language) document.documentElement.lang = language
  }, [language])
  return <CookieBanner language={language} />
}
