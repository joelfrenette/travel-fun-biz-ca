"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Loader2 } from "lucide-react"
import type { aiCostByFeatureDay, leadStats, loginStats, visitorStats } from "@/lib/users-analytics"

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

interface UsersData {
  ai: ReturnType<typeof aiCostByFeatureDay> & { note: string }
  logins: ReturnType<typeof loginStats> & { note: string }
  leads: ReturnType<typeof leadStats> & { days: number }
  visitors: ReturnType<typeof visitorStats> & { days: number }
}

const usd = (n: number) => `US$${n.toFixed(n < 1 ? 4 : 2)}`

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  if (!rows.length) return <p className="p-4 text-sm text-muted-foreground">Nothing recorded yet.</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">{head.map((h) => <th key={h} className="p-2 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b last:border-0">{r.map((c, j) => <td key={j} className="p-2">{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xl font-bold">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  )
}

export default function UsersPage() {
  const [data, setData] = useState<UsersData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    fetch("/api/admin/users", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || "Could not load")
        setData(data)
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div>
      <div className="border-b bg-card/30">
        <div className="container mx-auto px-4 py-4">
          <h1 className="text-xl font-bold">Users and analytics</h1>
          <p className="text-sm text-muted-foreground">This site has no visitor accounts. These are the numbers that exist: AI cost, admin sign-ins, leads and visitors.</p>
        </div>
      </div>
      <div className="container mx-auto space-y-4 px-4 py-4">
        {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
        {loading || !data ? (
          <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
        ) : (
          <Tabs defaultValue="ai">
            <TabsList>
              <TabsTrigger value="ai">AI cost</TabsTrigger>
              <TabsTrigger value="logins">Admin logins</TabsTrigger>
              <TabsTrigger value="leads">Leads</TabsTrigger>
              <TabsTrigger value="visitors">Visitors</TabsTrigger>
            </TabsList>

            <TabsContent value="ai" className="space-y-3">
              {data.ai.note && <p className="text-sm text-muted-foreground">{data.ai.note}</p>}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat label="Estimated spend, last 60 days" value={usd(data.ai.totalUsd)} />
                <Stat label="Features using AI" value={data.ai.byFeature.length} />
              </div>
              <p className="text-xs text-muted-foreground">Cost is an estimate from token counts and a rate table in lib/ai-meter.ts, not your Anthropic invoice.</p>
              <Card><CardContent className="p-2">
                <p className="p-2 text-sm font-medium">By feature</p>
                <Table head={["Feature", "Calls", "Est. cost"]} rows={data.ai.byFeature.map((f) => [f.feature, f.calls, usd(f.costUsd)])} />
              </CardContent></Card>
              <Card><CardContent className="p-2">
                <p className="p-2 text-sm font-medium">By day and feature</p>
                <Table head={["Day", "Feature", "Calls", "Failed", "Tokens in", "Tokens out", "Est. cost"]} rows={data.ai.byDay.map((r) => [r.day, r.feature, r.calls, r.failed, r.inputTokens, r.outputTokens, usd(r.costUsd)])} />
              </CardContent></Card>
            </TabsContent>

            <TabsContent value="logins" className="space-y-3">
              {data.logins.note && <p className="text-sm text-muted-foreground">{data.logins.note}</p>}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Last login" value={data.logins.lastLogin ? new Date(data.logins.lastLogin).toLocaleString("en-CA") : "none recorded"} />
                <Stat label="Logins, last 7 days" value={data.logins.loginsLast7} />
                <Stat label="Logins, last 30 days" value={data.logins.loginsLast30} />
                <Stat label="Failed attempts, 30 days" value={data.logins.failedLast30} />
              </div>
              <Card><CardContent className="p-2">
                <p className="p-2 text-sm font-medium">Logins per week</p>
                <Table head={["Week starting", "Logins"]} rows={data.logins.weeks.map((w) => [w.weekStart, w.logins])} />
              </CardContent></Card>
              <Card><CardContent className="p-2">
                <p className="p-2 text-sm font-medium">Logins per month</p>
                <Table head={["Month", "Logins"]} rows={data.logins.months.map((m) => [m.month, m.logins])} />
              </CardContent></Card>
              <p className="text-xs text-muted-foreground">Only a scrambled IP hash and a short browser label are stored, never the address or any password.</p>
            </TabsContent>

            <TabsContent value="leads" className="space-y-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat label={`Leads, last ${data.leads.days} days`} value={data.leads.total} />
                <Stat label="With a message" value={data.leads.withMessage} />
                <Stat label="Messages that ask a question" value={data.leads.questions} />
              </div>
              <Card><CardContent className="p-2">
                <p className="p-2 text-sm font-medium">By source</p>
                <Table head={["Source", "Leads"]} rows={data.leads.bySource.map((s) => [s.source, s.count])} />
              </CardContent></Card>
              <Card><CardContent className="p-2">
                <p className="p-2 text-sm font-medium">By page</p>
                <Table head={["Page", "Leads"]} rows={data.leads.byPage.map((s) => [s.page, s.count])} />
              </CardContent></Card>
              <Card><CardContent className="p-2">
                <p className="p-2 text-sm font-medium">20 most common words in messages</p>
                <Table head={["Word", "Leads using it"]} rows={data.leads.topWords.map((w) => [w.word, w.leads])} />
              </CardContent></Card>
              <p className="text-xs text-muted-foreground">Counts only. Messages are never shown here, and a word needs to appear in at least two leads to be listed.</p>
            </TabsContent>

            <TabsContent value="visitors" className="space-y-3">
              {!data.visitors.tracked ? (
                <div className="rounded-lg border border-dashed p-6 text-center text-muted-foreground">{data.visitors.message}</div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <Stat label={`Visits, last ${data.visitors.days} days`} value={data.visitors.total} />
                  </div>
                  <Card><CardContent className="p-2">
                    <p className="p-2 text-sm font-medium">By channel</p>
                    <Table head={["Channel", "Visits"]} rows={data.visitors.byChannel.map((c) => [c.channel, c.visits])} />
                  </CardContent></Card>
                  <Card><CardContent className="p-2">
                    <p className="p-2 text-sm font-medium">Top landing pages</p>
                    <Table head={["Page", "Visits"]} rows={data.visitors.byPage.map((c) => [c.page, c.visits])} />
                  </CardContent></Card>
                </>
              )}
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  )
}
