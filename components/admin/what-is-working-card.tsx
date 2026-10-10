"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { styleKeyLabel, SCORE_BASIS, NO_CLICKS_TEXT } from "@/lib/style-choice"

interface Score {
  value: string
  posts: number
  measuredPosts: number
  clicksPerPost: number
  leadsPerPost: number
  sample: "thin" | "ok"
}
interface Result {
  ready: boolean
  day: string | null
  tables: { key: string; scores: Score[]; youngPosts: number; clicksMeasured: boolean }[]
  note?: string
}

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

const labelOf = styleKeyLabel

export function WhatIsWorkingCard() {
  const [data, setData] = useState<Result | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    fetch("/api/admin/performance", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || "Could not load")
        setData(body)
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
  }, [])

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div>
          <h2 className="font-semibold">What is working</h2>
          <p className="text-xs text-muted-foreground">The writer leans toward the best style 70% of the time once a style has 3 or more posts. The rest of the time it rotates, so new styles still get a fair try.</p>
        </div>
        {error ? (
          <p className="text-sm text-muted-foreground">Could not load this yet: {error}</p>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : !data.ready ? (
          <p className="text-sm text-muted-foreground">{data.note?.startsWith("not set up") ? `Not set up yet: run migration 0029 (supabase/migrations/0029_content_performance.sql).` : `Could not read the numbers: ${data.note ?? "unknown problem"}`}</p>
        ) : !data.day ? (
          <p className="text-sm text-muted-foreground">No snapshot yet. The first one is taken on the next pipeline pass.</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">Last snapshot: {data.day}. Numbers are {SCORE_BASIS}. Only posts at least 28 days old are judged.</p>
            {data.tables.length === 0 ? (
              <p className="text-sm text-muted-foreground">No styled posts to compare yet. Styles are recorded as new posts are written.</p>
            ) : (
              data.tables.map((t) => (
                <div key={t.key} className="space-y-1">
                  <p className="text-sm font-medium">
                    {labelOf(t.key)}
                    {t.youngPosts > 0 && <span className="ml-2 text-xs font-normal text-muted-foreground">{t.youngPosts} too new to judge</span>}
                  </p>
                  {!t.clicksMeasured && <p className="text-xs text-muted-foreground">{NO_CLICKS_TEXT}</p>}
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-muted-foreground">
                          <th className="py-1 pr-3 font-normal">Style</th>
                          <th className="py-1 pr-3 text-right font-normal">Posts</th>
                          <th className="py-1 pr-3 text-right font-normal">Clicks per post</th>
                          <th className="py-1 pr-3 text-right font-normal">Leads per post</th>
                          <th className="py-1 font-normal"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {t.scores.map((s) => (
                          <tr key={s.value} className="border-t">
                            <td className="py-1 pr-3">{s.value}</td>
                            <td className="py-1 pr-3 text-right">{s.posts}</td>
                            <td className="py-1 pr-3 text-right">{s.measuredPosts ? s.clicksPerPost : "-"}</td>
                            <td className="py-1 pr-3 text-right">{s.leadsPerPost}</td>
                            <td className="py-1">{s.sample === "thin" && <Badge variant="outline">thin sample</Badge>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
