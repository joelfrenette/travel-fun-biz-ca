"use client"

import { useEffect } from "react"
import { usePathname } from "next/navigation"

// Verified with a real Playwright check (2026-09-27): clicking a normal <Link> to a shorter page
// left window.scrollY exactly where it was on the previous page instead of resetting to the top -
// Next's own scroll-restoration does not reliably do this on every route change. One line, mounted
// once at the root, fixes every page (public and admin) rather than each admin page individually.
export function ScrollToTop() {
  const pathname = usePathname()

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])

  return null
}
