"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Loader2, Link2, Copy, Check, Trash2, ShieldCheck, ShieldAlert } from "lucide-react"
import type { LinksView, TaskViewDTO } from "@/lib/links-building-data"

// Link building: a checklist and copy-ready drafts. Nothing here sends a message or posts anywhere. The owner finds each
// real page, pastes the details, and sends from their own accounts.

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

const STATUSES = ["todo", "doing", "done", "skipped"] as const
const STATUS_LABEL: Record<(typeof STATUSES)[number], string> = { todo: "To do", doing: "Doing", done: "Done", skipped: "Skipped" }

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      type="button" variant="outline" size="sm"
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500) } catch { /* clipboard blocked: select and copy by hand */ }
      }}
    >
      {done ? <Check className="mr-1 h-3 w-3" /> : <Copy className="mr-1 h-3 w-3" />}
      {done ? "Copied" : label}
    </Button>
  )
}

function today() { return new Date().toISOString().slice(0, 10) }

export default function LinksBuildingPage() {
  const [view, setView] = useState<LinksView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [open, setOpen] = useState<string | null>(null)
  const [page, setPage] = useState("")
  const [source, setSource] = useState("")
  const [date, setDate] = useState(today())
  const [busy, setBusy] = useState(false)

  async function load() {
    try {
      const res = await fetch("/api/admin/links-building", { headers: authHeaders() })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not load")
      setView(data as LinksView)
      setError("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load")
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [])

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    try {
      const res = await fetch("/api/admin/links-building", { method: "POST", headers: authHeaders(), body: JSON.stringify(body) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not save")
      setError("")
      await load()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save")
      return false
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div className="flex justify-center p-12"><Loader2 className="h-6 w-6 animate-spin" /></div>

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold"><Link2 className="h-6 w-6" /> Link building</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Real links from real places, earned by you. This page is a checklist and ready-to-paste drafts. It never sends anything, posts anything or buys anything.
          </p>
        </div>
        {view && (
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge variant="default">Backlinks recorded: {view.earned.length}</Badge>
            <Badge variant="secondary">{view.counts.done} of {view.counts.total} tasks done</Badge>
            <Badge variant="secondary">{view.counts.doing} doing</Badge>
          </div>
        )}
      </div>

      {error && <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
      {view?.notes.map((n) => <div key={n} className="rounded border bg-muted p-3 text-sm">{n}</div>)}

      {view && (
        <>
          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 font-semibold">
                  {view.nap.bad === 0 ? <ShieldCheck className="h-5 w-5 text-green-600" /> : <ShieldAlert className="h-5 w-5 text-destructive" />}
                  Name, address and phone check
                </h2>
                <Badge variant={view.nap.bad === 0 ? "default" : "destructive"}>{view.nap.bad === 0 ? `All ${view.nap.total} checks match` : `${view.nap.bad} of ${view.nap.total} do not match`}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                Read only. Compares lib/site.ts with the footer, the home page JSON-LD, the contact form wording and the price line. The phone must be the site phone only, and the Canada office number must never appear publicly.
              </p>
              <ul className="divide-y rounded border text-sm">
                {view.nap.findings.map((f, i) => (
                  <li key={i} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <span>{f.surface} <span className="text-muted-foreground">({f.field})</span></span>
                    <span className={f.ok ? "text-green-700 dark:text-green-400" : "font-medium text-destructive"}>
                      {f.ok ? "Matches" : `Expected ${f.expected}, found ${f.found}`}{f.note ? `. ${f.note}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
              <div>
                <p className="mb-1 text-sm font-medium">Paste this exact block into every listing</p>
                <pre className="whitespace-pre-wrap rounded bg-muted p-3 text-sm">{view.site.nap}</pre>
                <div className="mt-2"><CopyButton text={view.site.nap} label="Copy name, address and phone" /></div>
              </div>
            </CardContent>
          </Card>

          {view.groups.map((g) => (
            <section key={g.group} className="space-y-2">
              <h2 className="text-lg font-semibold">{g.label}</h2>
              <p className="text-sm text-muted-foreground">{g.blurb}</p>
              {g.tasks.map((t) => (
                <TaskCard key={t.id} t={t} open={open === t.id} onToggle={() => setOpen(open === t.id ? null : t.id)} busy={busy} nap={view.site.nap} onChange={(patch) => post({ action: "task", id: t.id, ...patch })} />
              ))}
            </section>
          ))}

          <Card>
            <CardContent className="space-y-3 p-4">
              <h2 className="font-semibold">Links earned ({view.earned.length})</h2>
              <p className="text-sm text-muted-foreground">When someone links to us, write it down here: which of our pages, who linked, and the date. Typed by you, never guessed.</p>
              <form
                className="grid gap-2 md:grid-cols-[1fr_1fr_10rem_auto]"
                onSubmit={async (e) => {
                  e.preventDefault()
                  if (await post({ action: "earned_add", page, source, date })) { setPage(""); setSource("") }
                }}
              >
                <Input value={page} onChange={(e) => setPage(e.target.value)} placeholder="Our page (for example /destinations/cancun)" maxLength={200} required />
                <Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="Who linked (site name or address)" maxLength={200} required />
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
                <Button type="submit" disabled={busy}>Add</Button>
              </form>
              {view.earned.length === 0 ? (
                <p className="text-sm text-muted-foreground">None recorded yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-muted-foreground"><th className="py-1">Our page</th><th>Source</th><th>Date</th><th /></tr></thead>
                  <tbody>
                    {view.earned.map((e) => (
                      <tr key={e.id} className="border-t">
                        <td className="py-1 pr-2 break-all">{e.page}</td>
                        <td className="pr-2 break-all">{e.source}</td>
                        <td className="pr-2 whitespace-nowrap">{e.date}</td>
                        <td className="text-right">
                          <Button type="button" variant="ghost" size="sm" disabled={busy} aria-label="Remove entry" onClick={() => { if (confirm("Remove this entry?")) void post({ action: "earned_delete", id: e.id }) }}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

function TaskCard({ t, open, onToggle, busy, nap, onChange }: {
  t: TaskViewDTO
  open: boolean
  onToggle: () => void
  busy: boolean
  nap: string
  onChange: (patch: { status?: string; note?: string; holds?: boolean }) => Promise<boolean>
}) {
  const [note, setNote] = useState(t.note)
  const inactive = t.askHolds && !t.holds
  return (
    <Card className={inactive ? "opacity-70" : ""}>
      <CardContent className="space-y-2 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button type="button" className="flex-1 text-left font-medium hover:underline" onClick={onToggle} aria-expanded={open}>{t.title}</button>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">Effort: {t.effort}</Badge>
            <Badge variant="secondary">Value: {t.value}</Badge>
            {t.askHolds && (
              <label className="flex items-center gap-1 text-sm">
                <input type="checkbox" checked={!!t.holds} disabled={busy} onChange={(e) => void onChange({ holds: e.target.checked })} /> I hold this
              </label>
            )}
            <select
              className="rounded border bg-background px-2 py-1 text-sm"
              value={t.status} disabled={busy || inactive} aria-label={`Status for ${t.title}`}
              onChange={(e) => void onChange({ status: e.target.value })}
            >
              {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
          </div>
        </div>
        {open && (
          <div className="space-y-3 border-t pt-3 text-sm">
            <p>{t.how}</p>
            <p><span className="font-medium">Search for:</span> {t.searchPhrase} <span className="text-muted-foreground">(official site: {t.officialSite}. You find the real page, we do not guess addresses.)</span></p>
            {t.needsNap && (
              <div>
                <p className="mb-1 font-medium">Name, address and phone to paste</p>
                <pre className="whitespace-pre-wrap rounded bg-muted p-2">{nap}</pre>
                <div className="mt-1"><CopyButton text={nap} /></div>
              </div>
            )}
            {t.drafts.map((d, i) => (
              <div key={i}>
                <p className="mb-1 font-medium">{d.label}</p>
                <pre className="whitespace-pre-wrap rounded bg-muted p-2">{d.text}</pre>
                <div className="mt-1"><CopyButton text={d.text} /></div>
              </div>
            ))}
            <div className="flex gap-2">
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Your note (who you asked, when)" maxLength={500} />
              <Button type="button" variant="outline" disabled={busy || note === t.note} onClick={() => void onChange({ note })}>Save note</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
