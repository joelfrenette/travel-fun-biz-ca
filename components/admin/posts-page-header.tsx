"use client"

import type { ReactNode } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { statusCountCells, type StatusCounts } from "@/lib/posts-page-summary"

interface Props {
  title: string
  /** One line: what this kind of post is and what the page is for. */
  purpose: string
  counts?: StatusCounts
  /** Your own label/value cells instead of the four status counts (Guides and Trips have different statuses). A null value shows a dash. */
  cells?: { label: string; value: number | null }[]
  /** Buttons on the right (New Post, Refresh). */
  actions?: ReactNode
  loading?: boolean
}

/** The top of every "Posts: ..." page: title, one-line purpose, and counts by status. Shared so the Blog, News,
 * Guides and Trips pages look like one family. */
export default function PostsPageHeader({ title, purpose, counts, cells, actions, loading }: Props) {
  const shown: { label: string; value: number | null }[] = cells ?? (counts ? statusCountCells(counts) : [])
  return (
    <div className="border-b bg-card/30">
      <div className="container mx-auto space-y-3 px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold">{title}</h1>
            <p className="text-sm text-muted-foreground">{purpose}</p>
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-live="polite">
          {shown.map((c) => (
            <Card key={c.label}>
              <CardContent className="p-3">
                <p className="text-2xl font-bold">{loading || c.value === null ? "-" : c.value}</p>
                <p className="text-xs text-muted-foreground">{c.label}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}
