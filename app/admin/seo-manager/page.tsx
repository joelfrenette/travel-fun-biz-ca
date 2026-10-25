"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Loader2, RefreshCw, ChevronDown, ChevronUp, Trash2, Plus, ExternalLink, TriangleAlert } from "lucide-react"
import { CATEGORIES, CATEGORY_LABELS } from "@/lib/seo-playbook-types"
import type { SeoView, ViewItem } from "@/lib/seo-playbook-view"

// SEO and GEO Manager. One checklist of SEO, AEO, GEO and local steps in order of impact. Items the site can check by itself show
// pass, warn, fail or unknown (unknown means it could not read the answer, never a pass). Items only you can do have a tick box.
// Nothing here changes the live site: the audit only reads, and ticks and tips are saved as your own notes.

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

const STATUS_LABEL: Record<ViewItem["status"], string> = { pass: "Pass", warn: "Warning", fail: "Fail", unknown: "Not checked", manual: "To do", "manual-done": "Done" }
const STATUS_CLASS: Record<ViewItem["status"], string> = {
  pass: "bg-green-100 text-green-800 border-green-300 dark:bg-green-950/40 dark:text-green-200 dark:border-green-800",
  warn: "bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-800",
  fail: "bg-red-100 text-red-800 border-red-300 dark:bg-red-950/40 dark:text-red-200 dark:border-red-800",
  unknown: "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800/60 dark:text-slate-300 dark:border-slate-600",
  manual: "bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-950/40 dark:text-blue-200 dark:border-blue-800",
  "manual-done": "bg-green-100 text-green-800 border-green-300 dark:bg-green-950/40 dark:text-green-200 dark:border-green-800",
}
const AUTOMATION_LABEL = { auto: "Automatic", assisted: "Assisted", manual: "Manual" } as const
const EFFORT_LABEL = { 1: "Quick", 2: "An afternoon", 3: "Days" } as const

function Stars({ n }: { n: number }) {
  return (
    <span aria-label={`Impact ${n} of 5`} title={`Impact ${n} of 5`} className="whitespace-nowrap text-amber-500">
      {"★".repeat(n)}
      <span className="text-slate-300 dark:text-slate-600">{"★".repeat(5 - n)}</span>
    </span>
  )
}

function scoreColor(n: number) {
  return n >= 75 ? "bg-green-500" : n >= 45 ? "bg-amber-500" : "bg-red-500"
}

export default function SeoManagerPage() {
  const [view, setView] = useState<SeoView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState("")
  const [notice, setNotice] = useState("")
  const [category, setCategory] = useState("all")
  const [automation, setAutomation] = useState("all")
  const [minImpact, setMinImpact] = useState("1")
  const [status, setStatus] = useState("all")
  const [onlyMe, setOnlyMe] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [showTip, setShowTip] = useState(false)
  const [tip, setTip] = useState({ title: "", category: "onpage", sourceName: "", text: "", link: "", impact: "3" })

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/seo-playbook", { headers: authHeaders() })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not load")
      setView(data as SeoView)
      setError("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Open the item named in the address (#item-id), so a Today card can link straight to it.
  useEffect(() => {
    if (!view) return
    const id = decodeURIComponent(window.location.hash.replace(/^#/, ""))
    if (id && view.items.some((i) => i.id === id)) {
      setOpen(id)
      setTimeout(() => document.getElementById(`item-${id}`)?.scrollIntoView({ block: "center" }), 100)
    }
  }, [view])

  async function post(body: Record<string, unknown>, label: string) {
    setBusy(label)
    setNotice("")
    try {
      const res = await fetch("/api/admin/seo-playbook", { method: "POST", headers: authHeaders(), body: JSON.stringify(body) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not save")
      await load()
      return true
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not save")
      return false
    } finally {
      setBusy("")
    }
  }

  async function runAudit() {
    setBusy("audit")
    setNotice("")
    try {
      const res = await fetch("/api/admin/seo-playbook/audit", { method: "POST", headers: authHeaders() })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "The audit failed")
      if (data.view) setView(data.view as SeoView)
      setNotice(data.note || "Audit done.")
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "The audit failed")
    } finally {
      setBusy("")
    }
  }

  async function addTip() {
    const ok = await post({ action: "tip_add", ...tip }, "tip")
    if (ok) {
      setTip({ title: "", category: tip.category, sourceName: tip.sourceName, text: "", link: "", impact: "3" })
      setShowTip(false)
      setNotice("Tip added. It is in the list as a manual item.")
    }
  }

  const items = useMemo(() => {
    if (!view) return []
    const min = Number(minImpact)
    return view.items.filter((i) => (category === "all" || i.category === category) && (automation === "all" || i.automation === automation) && i.impact >= min && (status === "all" || i.status === status) && (!onlyMe || i.needsMe))
  }, [view, category, automation, minImpact, status, onlyMe])

  if (loading) return <div className="flex items-center gap-2 p-8 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading the checklist...</div>
  if (!view) return <div className="p-8 text-red-700 dark:text-red-400">{error || "Could not load the checklist."}</div>

  const checked = view.counts.pass + view.counts.warn + view.counts.fail
  const grouped = CATEGORIES.map((c) => ({ id: c, items: items.filter((i) => i.category === c) })).filter((g) => g.items.length)

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-3 py-4 sm:px-6 sm:py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">SEO and GEO Manager</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {view.total} steps for Google, AI answers and local search, biggest impact first. The site checks what it can by itself; the rest is for you to do and tick.
          </p>
        </div>
        <Button onClick={runAudit} disabled={busy === "audit"} variant="outline">
          {busy === "audit" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          Run the checks now
        </Button>
      </div>

      {notice && <div className="rounded border border-slate-300 bg-slate-50 p-3 text-sm dark:border-slate-600 dark:bg-slate-800/50" role="status">{notice}</div>}
      {error && <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">{error}</div>}

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="text-center">
              <div className="text-5xl font-bold leading-none">{view.overall}</div>
              <div className="text-xs text-muted-foreground">out of 100</div>
            </div>
            <div className="min-w-[200px] flex-1 text-sm text-muted-foreground">
              <p>
                {view.auditAt ? `Last automatic check: ${new Date(view.auditAt).toLocaleString()}. ` : "The automatic checks have not run yet. Press the button, or wait for the daily run. "}
                {checked} of the checked items have an answer; {view.counts.unknown} could not be read (those count as zero, never as a pass).
              </p>
              <p className="mt-1">
                <span className="font-medium text-red-700 dark:text-red-400">{view.counts.fail} failing</span>, <span className="font-medium text-amber-700 dark:text-amber-400">{view.counts.warn} warnings</span>,{" "}
                <span className="font-medium text-green-700 dark:text-green-400">{view.counts.pass + view.counts["manual-done"]} done</span>, {view.counts.manual} to do by hand.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {view.categories.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setCategory(category === c.id ? "all" : c.id)}
                className={`rounded border p-2 text-left ${category === c.id ? "border-primary bg-primary/5" : "border-slate-200 dark:border-slate-700"}`}
                aria-pressed={category === c.id}
              >
                <div className="flex items-center justify-between text-sm"><span className="font-medium">{c.label}</span><span>{c.score}/100</span></div>
                <div className="mt-1 h-2 w-full rounded bg-slate-200 dark:bg-slate-700"><div className={`h-2 rounded ${scoreColor(c.score)}`} style={{ width: `${c.score}%` }} /></div>
                <div className="mt-1 text-xs text-muted-foreground">{c.count} steps</div>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-5">
          <label className="text-xs">Category
            <select className="mt-1 w-full rounded border bg-background p-2 text-sm" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="all">All</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
            </select>
          </label>
          <label className="text-xs">Who does it
            <select className="mt-1 w-full rounded border bg-background p-2 text-sm" value={automation} onChange={(e) => setAutomation(e.target.value)}>
              <option value="all">All</option><option value="auto">Automatic</option><option value="assisted">Assisted</option><option value="manual">Manual</option>
            </select>
          </label>
          <label className="text-xs">Impact
            <select className="mt-1 w-full rounded border bg-background p-2 text-sm" value={minImpact} onChange={(e) => setMinImpact(e.target.value)}>
              <option value="1">Any</option><option value="3">3 stars and up</option><option value="4">4 stars and up</option><option value="5">5 stars only</option>
            </select>
          </label>
          <label className="text-xs">Status
            <select className="mt-1 w-full rounded border bg-background p-2 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="all">All</option><option value="fail">Fail</option><option value="warn">Warning</option><option value="unknown">Not checked</option><option value="pass">Pass</option><option value="manual">To do</option><option value="manual-done">Done</option>
            </select>
          </label>
          <label className="col-span-2 flex items-end gap-2 pb-2 text-sm sm:col-span-1">
            <input type="checkbox" className="h-5 w-5" checked={onlyMe} onChange={(e) => setOnlyMe(e.target.checked)} /> Only what needs me
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <button type="button" className="flex w-full items-center justify-between text-left font-medium" onClick={() => setShowTip(!showTip)} aria-expanded={showTip}>
            <span className="flex items-center gap-2"><Plus className="h-4 w-4" /> Add a tip from an influencer ({view.customCount} saved)</span>
            {showTip ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          {showTip && (
            <div className="mt-3 space-y-3">
              <Input placeholder="Tip title" value={tip.title} maxLength={120} onChange={(e) => setTip({ ...tip, title: e.target.value })} />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <select className="rounded border bg-background p-2 text-sm" value={tip.category} onChange={(e) => setTip({ ...tip, category: e.target.value })} aria-label="Category">
                  {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
                </select>
                <Input placeholder="Who said it (name)" value={tip.sourceName} maxLength={60} onChange={(e) => setTip({ ...tip, sourceName: e.target.value })} />
                <select className="rounded border bg-background p-2 text-sm" value={tip.impact} onChange={(e) => setTip({ ...tip, impact: e.target.value })} aria-label="Impact">
                  {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>Impact {n} of 5</option>)}
                </select>
              </div>
              <textarea className="min-h-[100px] w-full rounded border bg-background p-2 text-sm" placeholder="Paste the tip text" value={tip.text} maxLength={1500} onChange={(e) => setTip({ ...tip, text: e.target.value })} />
              <Input placeholder="Link (optional, starts with https://)" value={tip.link} maxLength={300} onChange={(e) => setTip({ ...tip, link: e.target.value })} />
              <Button onClick={addTip} disabled={busy === "tip"}>{busy === "tip" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Add to the list</Button>
              <p className="text-xs text-muted-foreground">It shows up in the list as a manual item you can tick. Nothing is checked or published automatically.</p>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground" aria-live="polite">Showing {items.length} of {view.total} steps.</p>

      {grouped.map((g) => (
        <section key={g.id} className="space-y-2">
          <h2 className="pt-2 text-lg font-semibold">{CATEGORY_LABELS[g.id]}</h2>
          {g.items.map((i) => {
            const isOpen = open === i.id
            const canTick = i.verify.kind === "manual" || i.status === "unknown" || i.status === "manual-done"
            return (
              <Card key={i.id} id={`item-${i.id}`} className={!i.scored ? "opacity-70" : ""}>
                <CardContent className="space-y-2 p-3 sm:p-4">
                  <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                    {canTick && (
                      <input
                        type="checkbox"
                        className="mt-1 h-5 w-5 shrink-0"
                        checked={i.done}
                        disabled={busy === i.id}
                        onChange={(e) => post({ action: "tick", id: i.id, done: e.target.checked }, i.id)}
                        aria-label={i.verify.kind === "manual" ? `Mark done: ${i.title}` : `I checked this by hand: ${i.title}`}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{i.title}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                        <Stars n={i.impact} />
                        <span className={`rounded border px-2 py-0.5 font-medium ${STATUS_CLASS[i.status]}`}>{STATUS_LABEL[i.status]}</span>
                        <Badge variant="outline">{AUTOMATION_LABEL[i.automation]}</Badge>
                        <span className="text-muted-foreground">{EFFORT_LABEL[i.effort]}</span>
                        {i.source !== "best-practice" && <Badge variant="secondary">{i.source.startsWith("influencer:") ? i.source.slice(11) || "Influencer" : i.source === "joel-idea" ? "Joel's idea" : i.source === "joel-list-a" ? "Joel's 20 checks" : "Joel's 7 tricks"}</Badge>}
                        {!i.scored && <Badge variant="outline">Not for this site</Badge>}
                      </div>
                    </div>
                  </div>
                  <p className="text-sm">{i.why}</p>
                  {i.evidence && <p className="text-sm text-muted-foreground"><span className="font-medium">What the check found:</span> {i.evidence}</p>}
                  {i.caution && (
                    <p className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {i.caution}</p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    {i.fixHref && i.needsMe && (
                      <Button asChild size="sm"><Link href={i.fixHref}>Fix it <ExternalLink className="ml-1 h-3 w-3" /></Link></Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setOpen(isOpen ? null : i.id)} aria-expanded={isOpen}>
                      {isOpen ? "Hide steps" : "How to do it"} {isOpen ? <ChevronUp className="ml-1 h-4 w-4" /> : <ChevronDown className="ml-1 h-4 w-4" />}
                    </Button>
                    {i.custom && (
                      <Button size="sm" variant="ghost" className="text-red-700 dark:text-red-400" onClick={() => { if (window.confirm("Delete this tip?")) post({ action: "tip_delete", id: i.id }, i.id) }}>
                        <Trash2 className="mr-1 h-4 w-4" /> Delete tip
                      </Button>
                    )}
                  </div>
                  {isOpen && (
                    <div className="space-y-3 border-t pt-3">
                      <ol className="list-decimal space-y-1 pl-5 text-sm">{i.how.map((h, n) => <li key={n} className="break-words">{h}</li>)}</ol>
                      {i.fixHint && i.status !== "pass" && <p className="text-sm"><span className="font-medium">Suggested fix:</span> {i.fixHint}</p>}
                      <div className="flex gap-2">
                        <Input
                          placeholder="A note to yourself (optional)"
                          maxLength={300}
                          value={notes[i.id] ?? i.note}
                          onChange={(e) => setNotes({ ...notes, [i.id]: e.target.value })}
                          aria-label={`Note for ${i.title}`}
                        />
                        <Button size="sm" variant="outline" disabled={busy === i.id} onClick={() => post({ action: "tick", id: i.id, note: notes[i.id] ?? i.note }, i.id)}>Save note</Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </section>
      ))}
      {items.length === 0 && <p className="rounded border p-6 text-center text-sm text-muted-foreground">Nothing matches those filters.</p>}
    </div>
  )
}
