"use client"

import { ExternalLink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { track } from "@/lib/analytics-client"

export function BookNowButton({ href, label, packageName }: { href: string; label: string; packageName: string }) {
  return (
    <Button asChild size="lg" variant="outline" className="font-bold uppercase">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        onClick={() => track("book_now_click", { package_name: packageName, page_path: window.location.pathname, link_url: href })}
      >
        {label}
        <ExternalLink className="ml-2 h-4 w-4" />
      </a>
    </Button>
  )
}
