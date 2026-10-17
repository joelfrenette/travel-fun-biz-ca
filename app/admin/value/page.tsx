"use client"

import { useEffect, useMemo, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Download, Loader2 } from "lucide-react"
import { computeEstimate, ESTIMATE_LABEL, type Adjustment, type Inputs, type ValueReport, type ValueTile } from "@/lib/value"

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

const GROUPS: { key: ValueTile["group"]; title: string }[] = [
  { key: "money", title: "Money" },
  { key: "traffic", title: "Traffic and audience" },
  { key: "search", title: "Search health" },
  { key: "leads", title: "Leads" },
  { key: "content", title: "Content" },
  { key: "ops", title: "Operations" },
  { key: "manual", title: "Entered by hand" },
]

const FIELDS: { key: string; label: string; hint?: string; type?: "date" | "text" | "area" }[] = [
  { key: "domain_registered", label: "Domain registration date", type: "date" },
  { key: "email_list_size", label: "Email list size" },
  { key: "social_followers", label: "Social followers (all networks)" },
  { key: "owner_hours_week", label: "Owner hours per week" },
  { key: "recurring_revenue_share", label: "Recurring revenue share (%)" },
  { key: "cost_hosting_monthly", label: "Hosting cost per month", hint: "In your order currency" },
  { key: "cost_tools_monthly", label: "Tools and subscriptions per month" },
  { key: "cost_other_monthly", label: "Other costs per month" },
  { key: "fx_usd_to_order_currency", label: "US dollar to order currency rate", hint: "Used to turn AI cost into your currency. Blank uses 1.35, an assumption." },
  { key: "risks", label: "Known risks", hint: "One per line", type: "area" },
]

export default function ValuePage() {
  const [report, setReport] = useState<ValueReport | null>(null)
  const [inputs, setInputs] = useState<Inputs>({})
  const [form, setForm] = useState<Record<string, string>>({})
  const [multLow, setMultLow] = useState(2)
  const [multHigh, setMultHigh] = useState(4)
  const [adj, setAdj] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState("")
  const [error, setError] = useState("")

  function load() {
    setLoading(true)
    fetch("/api/admin/value", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || "Could not load")
        const rep = data.report as ValueReport
        setReport(rep)
        setInputs(data.inputs || {})
        const f: Record<string, string> = {}
        for (const fld of FIELDS) f[fld.key] = data.inputs?.[fld.key]?.value ?? ""
        setForm(f)
        setMultLow(rep.estimate.multipleLow)
        setMultHigh(rep.estimate.multipleHigh)
        setAdj(Object.fromEntries(rep.estimate.adjustments.map((a) => [a.key, a.value])))
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  // Live preview: the same pure function the server uses, fed the slider values.
  const estimate = useMemo(() => {
    if (!report) return null
    const adjustments: Adjustment[] = report.estimate.adjustments.map((a) => ({ ...a, value: adj[a.key] ?? a.value }))
    return computeEstimate({
      netProfit: report.estimate.netProfit,
      currency: report.estimate.currency,
      multipleLow: multLow,
      multipleHigh: multHigh,
      adjustments,
      notEnoughReason: report.estimate.reason,
    })
  }, [report, adj, multLow, multHigh])

  async function save(patch: Record<string, string | number>) {
    setBusy(true)
    setMsg("")
    setError("")
    try {
      const res = await fetch("/api/admin/value", { method: "PUT", headers: authHeaders(), body: JSON.stringify({ inputs: patch }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not save")
      setMsg("Saved.")
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save")
    } finally {
      setBusy(false)
    }
  }

  async function exportCsv() {
    setError("")
    const res = await fetch("/api/admin/value/export", { headers: authHeaders() })
    if (!res.ok) {
      setError("Could not build the export")
      return
    }
    const url = URL.createObjectURL(await res.blob())
    const a = document.createElement("a")
    a.href = url
    a.download = `website-value-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const money = (n: number | null, cur: string) => (n == null ? "" : new Intl.NumberFormat("en-CA", { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(n))

  return (
    <div>
      <div className="border-b bg-card/30">
        <div className="container mx-auto flex flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div>
            <h1 className="text-xl font-bold">Website Value</h1>
            <p className="text-sm text-muted-foreground">What a buyer would want to know, with where each number came from. Amber means typed in by hand or older than 30 days.</p>
          </div>
          <Button variant="outline" size="sm" onClick={exportCsv}>
            <Download className="mr-2 h-4 w-4" /> Data room CSV
          </Button>
        </div>
      </div>

      <div className="container mx-auto space-y-6 px-4 py-4">
        {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
        {msg && <div className="rounded-lg border bg-muted/40 p-3 text-sm">{msg}</div>}
        {loading || !report || !estimate ? (
          <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
        ) : (
          <>
            <Card>
              <CardContent className="space-y-4 p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-lg font-semibold">What the site might be worth</h2>
                  <Badge variant="secondary">{ESTIMATE_LABEL}</Badge>
                </div>
                {estimate.status === "ok" ? (
                  <div className="grid grid-cols-3 gap-3 text-center">
                    {([["Low", estimate.low], ["Base", estimate.base], ["High", estimate.high]] as const).map(([l, v]) => (
                      <div key={l} className="rounded-lg border p-3">
                        <p className="text-2xl font-bold">{money(v, estimate.currency)}</p>
                        <p className="text-xs text-muted-foreground">{l}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">Not enough data. {estimate.reason}</div>
                )}
                <p className="text-sm text-muted-foreground">{estimate.status === "ok" ? estimate.reason : ""}</p>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label>Multiple, low end ({multLow}x)</Label>
                    <input type="range" min={0.5} max={8} step={0.1} value={multLow} onChange={(e) => setMultLow(Number(e.target.value))} className="w-full" />
                  </div>
                  <div>
                    <Label>Multiple, high end ({multHigh}x)</Label>
                    <input type="range" min={0.5} max={8} step={0.1} value={multHigh} onChange={(e) => setMultHigh(Number(e.target.value))} className="w-full" />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">The 2x to 4x starting range is an unverified placeholder. Check it against current marketplace listings before relying on it.</p>

                <div className="space-y-3">
                  {estimate.adjustments.map((a) => (
                    <div key={a.key} className="rounded-lg border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <Label>{a.label}</Label>
                        <span className="text-sm font-medium">{a.value >= 0 ? "+" : ""}{a.value}x</span>
                      </div>
                      <input type="range" min={-1} max={1} step={0.1} value={a.value} onChange={(e) => setAdj((p) => ({ ...p, [a.key]: Number(e.target.value) }))} className="w-full" />
                      <p className="text-xs text-muted-foreground">{a.reason}</p>
                    </div>
                  ))}
                </div>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    // Only what changed is saved, so untouched sliders keep following the data.
                    const patch: Record<string, string | number> = {}
                    if (multLow !== report.estimate.multipleLow) patch.multiple_low = multLow
                    if (multHigh !== report.estimate.multipleHigh) patch.multiple_high = multHigh
                    for (const a of report.estimate.adjustments) if ((adj[a.key] ?? a.value) !== a.value) patch[`adj_${a.key}`] = adj[a.key]
                    if (Object.keys(patch).length) save(patch)
                    else setMsg("Nothing changed.")
                  }}
                >
                  Save multiple and adjustments
                </Button>

                {estimate.levers.length > 0 && (
                  <div>
                    <p className="text-sm font-medium">Biggest levers</p>
                    <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">{estimate.levers.map((l) => <li key={l}>{l}</li>)}</ul>
                  </div>
                )}
                <div>
                  <p className="text-sm font-medium">Assumptions</p>
                  <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">{estimate.assumptions.map((l) => <li key={l}>{l}</li>)}</ul>
                </div>
              </CardContent>
            </Card>

            {GROUPS.map((g) => {
              const tiles = report.tiles.filter((t) => t.group === g.key)
              if (!tiles.length) return null
              return (
                <section key={g.key}>
                  <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{g.title}</h2>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {tiles.map((t) => (
                      <Card key={t.key} className={t.status === "amber" ? "border-amber-500/60" : t.status === "not_tracked" ? "border-dashed" : ""}>
                        <CardContent className="p-4">
                          <p className="text-xs text-muted-foreground">{t.label}</p>
                          {t.status === "not_tracked" ? (
                            <p className="text-lg font-semibold text-muted-foreground">Not tracked</p>
                          ) : (
                            <p className="text-xl font-bold">{t.value}</p>
                          )}
                          <p className="mt-1 text-xs text-muted-foreground">
                            {t.source}{t.asOf ? ` · as of ${t.asOf}` : ""}
                          </p>
                          {t.status === "amber" && <Badge className="mt-1 bg-amber-500/20 text-amber-700 dark:text-amber-300">Manual or older than 30 days</Badge>}
                          {t.note && <p className="mt-1 text-xs text-muted-foreground">{t.note}</p>}
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </section>
              )
            })}

            <Card>
              <CardContent className="space-y-3 p-4">
                <h2 className="text-lg font-semibold">Your inputs</h2>
                <p className="text-sm text-muted-foreground">Things only you know. Each save stamps today as the "as of" date.</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {FIELDS.map((f) => (
                    <div key={f.key} className={f.type === "area" ? "sm:col-span-2" : ""}>
                      <Label htmlFor={f.key}>{f.label}</Label>
                      {f.type === "area" ? (
                        <Textarea id={f.key} rows={4} value={form[f.key] ?? ""} onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.value }))} />
                      ) : (
                        <Input id={f.key} type={f.type === "date" ? "date" : "text"} value={form[f.key] ?? ""} onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.value }))} />
                      )}
                      <p className="text-xs text-muted-foreground">{f.hint ? `${f.hint}. ` : ""}{inputs[f.key]?.as_of ? `As of ${inputs[f.key].as_of}.` : "Not entered yet."}</p>
                    </div>
                  ))}
                </div>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    const patch: Record<string, string> = {}
                    for (const f of FIELDS) if ((form[f.key] ?? "") !== (inputs[f.key]?.value ?? "")) patch[f.key] = form[f.key] ?? ""
                    if (Object.keys(patch).length) save(patch)
                    else setMsg("Nothing changed.")
                  }}
                >
                  {busy ? "Saving..." : "Save inputs"}
                </Button>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  )
}
