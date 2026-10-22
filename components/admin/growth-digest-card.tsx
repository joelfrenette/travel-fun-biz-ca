"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"

interface Digest {
  generatedAt: string
  sections: { title: string; lines: string[] }[]
  trends: string[]
  actions: string[]
}

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

export function GrowthDigestCard() {
  const [data, setData] = useState<Digest | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    fetch("/api/admin/growth-digest", { headers: authHeaders() })
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
          <h2 className="font-semibold">Growth this week</h2>
          <p className="text-xs text-muted-foreground">Is the traffic engine working? Real numbers only. A number that cannot be read says so. The same facts are in the 7 am brief email.</p>
        </div>
        {error ? (
          <p className="text-sm text-muted-foreground">Could not load this yet: {error}</p>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <>
            <div className="space-y-1">
              <p className="text-sm font-medium">What to do today</p>
              {data.actions.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing here needs you today.</p>
              ) : (
                <ol className="list-decimal space-y-1 pl-5 text-sm">
                  {data.actions.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ol>
              )}
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">Trends</p>
              <pre className="overflow-x-auto rounded bg-muted p-3 text-xs leading-5">{data.trends.join("\n")}</pre>
            </div>
            {data.sections.map((s) => (
              <div key={s.title} className="space-y-1">
                <p className="text-sm font-medium">{s.title}</p>
                <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                  {s.lines.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </div>
            ))}
          </>
        )}
      </CardContent>
    </Card>
  )
}
