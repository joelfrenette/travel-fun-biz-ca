"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

interface ArmView {
  network: string
  format: string
  dim: "hook" | "cover"
  value: string
  sends: number
  visits: number
  perSend: number | null
  status: "active" | "retired" | "exploring"
  winner: boolean
  retestOn: string | null
}
interface Summary {
  arms: ArmView[]
  decisions: { at: string; text: string }[]
  advice: { network: string; text: string }[]
  retired: number
  winners: number
  needMoreData: boolean
  minSends: number
  unmeasured: number
  updatedAt: string | null
  corrupt?: boolean
}

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

const STATUS_TEXT: Record<ArmView["status"], string> = { active: "active", retired: "retired", exploring: "exploring" }

export function OptimizerCard() {
  const [data, setData] = useState<Summary | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    fetch("/api/admin/optimizer", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || "could not be read")
        setData(body)
      })
      .catch((e) => setError(e instanceof Error ? e.message : "could not be read"))
  }, [])

  const groups = new Map<string, ArmView[]>()
  for (const a of data?.arms ?? []) {
    const k = `${a.network === "all" ? "Shared carousels and reels" : a.network} · ${a.format === "post" ? "photo posts" : a.format}${a.dim === "cover" ? " · picture designs" : ""}`
    groups.set(k, [...(groups.get(k) ?? []), a])
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div>
          <h2 className="font-semibold">Optimizer</h2>
          <p className="text-xs text-muted-foreground">Learns which hook styles bring visits, per network. It only acts when a style has enough sends, never retires more than one style per network per week, and always keeps testing. Read only.</p>
        </div>
        {error ? (
          <p className="text-sm text-muted-foreground">The Optimizer could not be read: {error}</p>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <>
            {data.corrupt && <p className="text-sm text-muted-foreground">The saved learning could not be read, so the normal rotation is used. It starts over at the next daily run.</p>}
            {data.needMoreData ? (
              <p className="text-sm">Not enough data yet (need {data.minSends} sends per style). Until then the normal rotation runs and nothing is retired.</p>
            ) : (
              <p className="text-sm">
                {data.retired} {data.retired === 1 ? "style" : "styles"} retired, {data.winners} {data.winners === 1 ? "winner" : "winners"}.
              </p>
            )}
            {data.unmeasured > 0 && <p className="text-xs text-muted-foreground">{data.unmeasured} settled sends were not counted because visits were not measured for them.</p>}
            {[...groups].map(([title, arms]) => (
              <div key={title} className="space-y-1">
                <p className="text-sm font-medium capitalize">{title}</p>
                <ul className="space-y-0.5 text-xs text-muted-foreground">
                  {arms.map((a) => (
                    <li key={`${a.dim}-${a.value}`} className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{a.value}</span>
                      <Badge variant={a.status === "retired" ? "destructive" : "outline"}>{STATUS_TEXT[a.status]}</Badge>
                      {a.winner && <Badge variant="secondary">winner</Badge>}
                      <span>
                        {a.sends} sends, {a.visits} visits{a.perSend !== null ? `, ${a.perSend} per send` : ""}
                        {a.retestOn ? `, retest ${a.retestOn}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {data.advice.length > 0 && (
              <div className="space-y-1">
                <p className="text-sm font-medium">Posting time</p>
                <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                  {data.advice.map((a) => (
                    <li key={a.network}>
                      <span className="font-medium capitalize text-foreground">{a.network}</span>: {a.text}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="space-y-1">
              <p className="text-sm font-medium">Latest decisions</p>
              {data.decisions.length === 0 ? (
                <p className="text-xs text-muted-foreground">None yet.</p>
              ) : (
                <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                  {data.decisions.map((d) => (
                    <li key={`${d.at}-${d.text}`}>
                      {d.at.slice(0, 10)}: {d.text}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
