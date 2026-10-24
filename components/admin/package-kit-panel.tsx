"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Loader2, Wand2, Undo2, CheckCircle2 } from "lucide-react"

// Trip Page Kit, admin side. Per trip: the completeness and SEO scores, "Fill this page", the "To confirm with an agent" list
// and the "Price confirmed by an agent" switch. Only plain data crosses to the server (no server library is imported here).

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}`, "Content-Type": "application/json" }
}

interface Status {
  completeness: { score: number; thin: boolean; reasons: string[] }
  seo: { score: number; reasons: string[] }
  hasKit: boolean
  generatedAt: string | null
  toConfirm: string[]
  price: { by: string; at: string; text: string } | null
  past: boolean
  recap?: { past: boolean; photos: number; quotes: number; hasRecapText: boolean; todo: string[] }
}

interface FillResult {
  ok: boolean
  error?: string
  applied: string[]
  photosAdded: number
  before?: { completeness: { score: number }; seo: { score: number } }
  after?: { completeness: { score: number }; seo: { score: number } }
  held: { field: string; reasons: string[] }[]
  notes: string[]
}

const tone = (score: number, good: number) => (score >= good ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" : score >= 60 ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200" : "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200")

export function ScoreBadges({ completeness, seo }: { completeness: number; seo: number }) {
  return (
    <span className="inline-flex gap-1.5">
      <span title="Completeness (0 to 100). Under 60 is thin." className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone(completeness, 75)}`}>Complete {completeness}</span>
      <span title="SEO score (0 to 100). 80 or more is a pass." className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone(seo, 80)}`}>SEO {seo}</span>
    </span>
  )
}

export function PackageKitPanel({ packageId, onChanged }: { packageId: string; onChanged?: () => void }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [by, setBy] = useState("")
  const [priceText, setPriceText] = useState("")

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/packages/${packageId}/trip-kit`, { headers: authHeaders() })
    if (res.ok) setStatus((await res.json()) as Status)
  }, [packageId])

  useEffect(() => {
    void load()
  }, [load])

  async function post(body: Record<string, unknown>) {
    const res = await fetch(`/api/admin/packages/${packageId}/trip-kit`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) })
    return { res, json: (await res.json().catch(() => ({}))) as Record<string, unknown> }
  }

  async function fill() {
    setBusy(true)
    setMsg("Filling this page from the trip details and open reference pages. This can take a minute.")
    const { json } = await post({ action: "fill" })
    const r = json as unknown as FillResult
    if (r.ok) {
      const held = r.held?.length ? ` Held back by the quality check: ${r.held.map((h) => h.field).join(", ")}.` : ""
      setMsg(`Done. Completeness ${r.before?.completeness.score} to ${r.after?.completeness.score}, SEO ${r.before?.seo.score} to ${r.after?.seo.score}. Changed: ${r.applied.join(", ") || "nothing new"}${r.photosAdded ? `, ${r.photosAdded} photo(s)` : ""}.${held}`)
      onChanged?.()
    } else setMsg(r.error ?? "Nothing was filled.")
    setBusy(false)
    await load()
  }

  async function confirmPrice() {
    setBusy(true)
    const { res, json } = await post({ action: "confirm_price", by, text: priceText })
    setMsg(res.ok ? "Saved. The price now shows on the trip page." : String(json.error ?? "Could not save."))
    setBusy(false)
    await load()
  }

  async function clearPrice() {
    setBusy(true)
    await post({ action: "clear_price" })
    setMsg("The price is off the trip page.")
    setBusy(false)
    await load()
  }

  async function undo() {
    setBusy(true)
    const { json } = await post({ action: "undo" })
    setMsg(json.ok ? "Put back the previous route and facts record. To undo text changes, use Revert on the \"Trip page kit\" source in Add details." : "Nothing to undo.")
    setBusy(false)
    await load()
  }

  return (
    <Card className="mb-4" id="trip-kit-panel">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Wand2 className="h-4 w-4" /> Trip page kit
          {status && <ScoreBadges completeness={status.completeness.score} seo={status.seo.score} />}
          {status?.completeness.thin && <Badge variant="destructive" className="text-[10px]">Thin</Badge>}
          {status?.past && <Badge variant="secondary" className="text-[10px]" data-testid="past-trip-badge">Past trip</Badge>}
        </CardTitle>
        <CardDescription>
          Fills the page from the trip details and cited reference pages (Wikivoyage, Wikipedia). It never sets a price, and it never guesses hours, ships or hotels.
          {status?.generatedAt ? ` Last filled ${new Date(status.generatedAt).toLocaleDateString()}.` : " Not filled yet."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={fill} disabled={busy} size="sm">{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wand2 className="mr-2 h-4 w-4" />}Fill this page</Button>
          {status?.hasKit && <Button onClick={undo} disabled={busy} size="sm" variant="outline"><Undo2 className="mr-2 h-4 w-4" />Undo route record</Button>}
          {status?.past && <span className="text-xs text-muted-foreground">Past trip: only empty fields are filled.</span>}
        </div>
        {status?.past && status.recap && (
          <p className="text-sm text-muted-foreground" data-testid="recap-status">
            <strong className="text-foreground">Recap status:</strong> {status.recap.photos} real trip photo{status.recap.photos === 1 ? "" : "s"}, {status.recap.quotes} approved quote{status.recap.quotes === 1 ? "" : "s"}, recap text {status.recap.hasRecapText ? "published" : "not written"}.
            {status.recap.todo.length > 0 ? ` To do: ${status.recap.todo.join("; ")}.` : " Nothing left to do."}
          </p>
        )}
        {msg && <p className="text-sm text-muted-foreground" role="status">{msg}</p>}
        {status && status.completeness.reasons.length > 0 && <p className="text-xs text-muted-foreground">Still missing: {status.completeness.reasons.join("; ")}.</p>}

        {status && status.toConfirm.length > 0 && (
          <div>
            <h3 className="mb-1 text-sm font-semibold">To confirm with an agent</h3>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {status.toConfirm.map((t) => <li key={t}>{t}</li>)}
            </ul>
            <p className="mt-1 text-xs text-muted-foreground">Admin only. None of this is shown on the public page.</p>
          </div>
        )}

        <div className="rounded-lg border p-3">
          <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">Price confirmed by an agent {status?.price && <CheckCircle2 className="h-4 w-4 text-emerald-600" />}</h3>
          {status?.price ? (
            <div className="space-y-2 text-sm">
              <p>Showing: <strong>{status.price.text}</strong>, confirmed by {status.price.by} on {new Date(status.price.at).toLocaleDateString()}.</p>
              <Button onClick={clearPrice} disabled={busy} size="sm" variant="outline">Take the price off the page</Button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">No price is shown on the page until an agent confirms one. The site never fills this in by itself.</p>
              <div className="flex flex-wrap gap-2">
                <Input value={by} onChange={(e) => setBy(e.target.value)} placeholder="Who confirmed it" className="max-w-[12rem]" />
                <Input value={priceText} onChange={(e) => setPriceText(e.target.value)} placeholder='Exact words, e.g. From $1,999 per person' className="min-w-[16rem] flex-1" />
                <Button onClick={confirmPrice} disabled={busy || !by.trim() || !/\d/.test(priceText)} size="sm">Confirm and show</Button>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
