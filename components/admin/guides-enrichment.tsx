"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

// Safe pages: short pages the heal built only from stored facts when it could not make a full page pass the checks. They are live but kept
// out of search (noindex, no sitemap entry) until the daily heal step upgrades them to full pages. This card lists them and how many
// upgrade tries each has used. Read only; the upgrade runs by itself (one page a day, three tries per page, two days apart).

interface SafePage {
  kind: string
  slug: string
  name: string
  path: string
  attempts: number
  maxAttempts: number
  lastAt: string | null
  last: string
  state: "ready" | "waiting" | "used-up" | "left-alone"
  text: string
}

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

export function GuidesEnrichmentCard() {
  const [pages, setPages] = useState<SafePage[] | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    fetch("/api/admin/guides/enrichment", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || "Could not load the safe pages")
        setPages(body.pages ?? [])
        setError(body.warning ? String(body.warning) : "")
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the safe pages"))
  }, [])

  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">Safe pages</h2>
          {pages && <Badge variant="secondary">{pages.length}</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">
          A safe page is a short page built only from stored facts, kept out of search until the site upgrades it to a full page. The upgrade runs by itself in the daily heal: one page a day, three tries per page, at least two days apart. If it fails, the safe page stays as it is.
        </p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {pages && pages.length === 0 && !error && <p className="text-sm text-muted-foreground">No safe pages right now.</p>}
        {pages && pages.length > 0 && (
          <ul className="divide-y text-sm">
            {pages.map((p) => (
              <li key={`${p.kind}/${p.slug}`} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <span>
                  <Link href={p.path} className="font-medium hover:underline" target="_blank" rel="noopener noreferrer">{p.name}</Link>
                  <span className="ml-2 text-xs text-muted-foreground">{p.path}</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {p.text}
                  {p.last && p.last !== "started" ? ` (last result: ${p.last})` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
