"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import { Loader2, Search, Trash2, RefreshCw } from "lucide-react"
import type { KeywordRow } from "@/lib/affiliate-rules"
import type { PreviewResult, UsageReport, Snippet } from "@/lib/affiliate-usage"
import { MAX_PHRASE_LENGTH, MIN_PHRASE_LENGTH } from "@/lib/affiliate-linker"

// WP22 part 2: the "Link a word or phrase" tool. Type a phrase, pick a link, say where, press Preview to see every page that
// would get the link, then "Save and turn on". Nothing on any page is rewritten: the pages link the phrase when they are
// shown, so turning a link or a phrase OFF, or changing a link's web address, shows on the whole site at once.

export interface WordLinkOption {
  id: string
  name: string
  slug: string
  on: boolean
}

const selectClass = "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

const WHERE: { value: "all" | "guides" | "blog"; label: string }[] = [
  { value: "all", label: "All pages" },
  { value: "guides", label: "Guides and destinations" },
  { value: "blog", label: "Blog posts" },
]
const whereLabel = (scope: string) => (scope === "destinations" ? "Destinations only" : WHERE.find((w) => w.value === scope)?.label ?? scope)

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

function Highlighted({ s }: { s: Snippet }) {
  return (
    <span className="text-xs text-muted-foreground">
      {s.before}
      <mark className="rounded bg-yellow-200 px-0.5 text-foreground dark:bg-yellow-700">{s.match}</mark>
      {s.after}
    </span>
  )
}

export function AffiliateWordLinker({
  links,
  keywords,
  report,
  migrated,
  focus,
  onChanged,
}: {
  links: WordLinkOption[]
  keywords: KeywordRow[]
  report: UsageReport | null
  migrated: boolean
  /** Set by the "Link a word" button on a row: pick this link and jump to the phrase box. */
  focus: { linkId: string; nonce: number } | null
  onChanged: () => void
}) {
  const { toast } = useToast()
  const root = useRef<HTMLDivElement>(null)
  const phraseInput = useRef<HTMLInputElement>(null)
  const [phrase, setPhrase] = useState("")
  const [linkId, setLinkId] = useState("")
  const [scope, setScope] = useState<"all" | "guides" | "blog">("all")
  const [max, setMax] = useState(1)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewKey, setPreviewKey] = useState("")
  const [busy, setBusy] = useState<"" | "preview" | "save" | "rescan">("")
  const [error, setError] = useState("")

  const formKey = `${phrase.trim()}|${linkId}|${scope}|${max}`
  const previewIsCurrent = !!preview && previewKey === formKey

  useEffect(() => {
    if (!focus) return
    setLinkId(focus.linkId)
    root.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    phraseInput.current?.focus()
  }, [focus])

  async function call(url: string, init: RequestInit) {
    const res = await fetch(url, { ...init, headers: authHeaders() })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || "Something went wrong")
    return data
  }

  async function runPreview() {
    setError("")
    setBusy("preview")
    try {
      const data = await call("/api/admin/affiliate-keywords/preview", { method: "POST", body: JSON.stringify({ phrase, scope, max_per_page: max, link_id: linkId }) })
      setPreview(data as PreviewResult)
      setPreviewKey(formKey)
    } catch (e) {
      setPreview(null)
      setError(e instanceof Error ? e.message : "Could not preview")
    } finally {
      setBusy("")
    }
  }

  async function save() {
    setError("")
    setBusy("save")
    try {
      const saved = await call("/api/admin/affiliate-keywords", { method: "POST", body: JSON.stringify({ phrase, link_id: linkId, scope, max_per_page: max }) })
      const warned: string[] = Array.isArray(saved.warnings) ? saved.warnings : []
      toast({ title: "Saved and turned on", description: warned.length ? `The whole site is updated. Note: ${warned[0]}` : "The whole site is updated." })
      setPhrase("")
      setPreview(null)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save")
    } finally {
      setBusy("")
    }
  }

  async function toggle(k: KeywordRow) {
    try {
      await call(`/api/admin/affiliate-keywords/${k.id}`, { method: "PATCH", body: JSON.stringify({ status: k.status === "on" ? "off" : "on" }) })
      onChanged()
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Could not update", variant: "destructive" })
    }
  }

  async function remove(k: KeywordRow) {
    if (!confirm(`Delete the linked phrase "${k.phrase}"? The words stay on your pages, they just stop being a link.`)) return
    try {
      await call(`/api/admin/affiliate-keywords/${k.id}`, { method: "DELETE" })
      onChanged()
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Could not delete", variant: "destructive" })
    }
  }

  async function rescan() {
    setBusy("rescan")
    try {
      await call("/api/admin/affiliate-keywords/rescan", { method: "POST", body: "{}" })
      toast({ title: "Site scanned", description: "The numbers below are fresh." })
      onChanged()
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Could not scan", variant: "destructive" })
    } finally {
      setBusy("")
    }
  }

  const linkName = (id: string) => links.find((l) => l.id === id)?.name ?? "(link removed)"
  const usageOf = useMemo(() => new Map((report?.phrases ?? []).map((p) => [p.keywordId, p])), [report])
  const canPreview = phrase.trim().length >= MIN_PHRASE_LENGTH && !busy
  const canSave = previewIsCurrent && !!linkId && !busy

  return (
    <div ref={root} id="link-a-word"><Card>
      <CardContent className="space-y-4 p-4">
        <div>
          <h2 className="text-lg font-semibold">Link a word or phrase</h2>
          <p className="text-sm text-muted-foreground">
            Type a word or phrase. Every time your pages, guides or blog posts use it, it becomes a link to the affiliate link you pick, opening in a new tab. Your
            written text is never changed. If you turn a link OFF or change its web address, the phrase links change with it, everywhere, right away.
          </p>
        </div>

        {!migrated && (
          <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            This tool needs one new table in Supabase (file <code>supabase/migrations/0050_affiliate_keywords.sql</code>). Until it is run, phrases cannot be saved and no word is linked.
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="wl-phrase">Word or phrase</Label>
            <Input
              id="wl-phrase"
              ref={phraseInput}
              placeholder="for example: croatia tours"
              value={phrase}
              maxLength={MAX_PHRASE_LENGTH}
              onChange={(e) => setPhrase(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{MIN_PHRASE_LENGTH} to {MAX_PHRASE_LENGTH} letters. Capital letters do not matter. Whole words only.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="wl-link">Link it to</Label>
            <select id="wl-link" className={selectClass} value={linkId} onChange={(e) => setLinkId(e.target.value)}>
              <option value="">Pick a link</option>
              {links.map((l) => <option key={l.id} value={l.id}>{l.name}{l.on ? "" : " (OFF)"}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="wl-where">Where</Label>
              <select id="wl-where" className={selectClass} value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
                {WHERE.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="wl-max">Max per page</Label>
              <select id="wl-max" className={selectClass} value={max} onChange={(e) => setMax(Number(e.target.value))}>
                {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button type="button" size="lg" variant="outline" disabled={!canPreview} onClick={runPreview}>
            {busy === "preview" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
            Preview
          </Button>
          <Button type="button" size="lg" disabled={!canSave || !migrated} onClick={save} title={previewIsCurrent ? undefined : "Press Preview first"}>
            {busy === "save" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save and turn on
          </Button>
        </div>
        {!previewIsCurrent && phrase.trim().length >= MIN_PHRASE_LENGTH && <p className="text-xs text-muted-foreground">Press Preview to see where it would link. Save turns on after a preview.</p>}
        {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

        {preview && (
          <div className="space-y-3 rounded-lg border p-3">
            <p className="text-sm font-medium">
              {preview.pageCount === 0
                ? "No page uses this phrase yet."
                : `It would link on ${preview.pageCount} page${preview.pageCount === 1 ? "" : "s"} (${preview.occurrences} time${preview.occurrences === 1 ? "" : "s"} written).`}
              {preview.truncated ? ` Only the first ${preview.scanned} pages were checked.` : ""}
            </p>
            {preview.warnings.length > 0 && (
              <ul className="space-y-1">
                {preview.warnings.map((w) => <li key={w} className="rounded border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-xs">{w}</li>)}
              </ul>
            )}
            {preview.pages.length > 0 && (
              <div className="max-h-96 divide-y overflow-auto rounded border text-sm">
                {preview.pages.map((p) => (
                  <div key={p.path} className="space-y-0.5 px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <code className="truncate text-xs">{p.path}</code>
                      <span className="text-xs text-muted-foreground">written {p.count}, linked {p.willLink}</span>
                    </div>
                    <Highlighted s={p.snippet} />
                    {p.warnings.map((w) => <p key={w} className="text-xs text-amber-700 dark:text-amber-400">{w}</p>)}
                  </div>
                ))}
              </div>
            )}
            {preview.pageCount > preview.shown && <p className="text-xs text-muted-foreground">Showing the first {preview.shown} pages.</p>}
          </div>
        )}

        <div className="space-y-3 border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold">Linked phrases</h3>
              <p className="text-xs text-muted-foreground">
                {report
                  ? `Checked ${report.scanned} page${report.scanned === 1 ? "" : "s"} on ${new Date(report.generatedAt).toLocaleString("en-CA")}.${report.truncated ? ` The site has ${report.totalDocs}+ pages; only the first ${report.scanned} are checked.` : ""}`
                  : "The numbers appear after the first scan."}
              </p>
            </div>
            <Button type="button" variant="outline" disabled={!migrated || !!busy} onClick={rescan}>
              {busy === "rescan" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Rescan the site
            </Button>
          </div>

          {keywords.length === 0 ? (
            <p className="text-sm text-muted-foreground">No phrases yet.</p>
          ) : (
            <div className="divide-y rounded-lg border">
              {keywords.map((k) => {
                const u = usageOf.get(k.id)
                return (
                  <div key={k.id} className="space-y-1 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-[220px] flex-1">
                        <p className="font-medium">&ldquo;{k.phrase}&rdquo; <span className="text-sm font-normal text-muted-foreground">goes to {linkName(k.link_id)}</span></p>
                        <p className="text-xs text-muted-foreground">
                          {whereLabel(k.scope)} &middot; up to {k.max_per_page} per page
                          {u ? (u.notFound ? "" : ` · found on ${u.pages} page${u.pages === 1 ? "" : "s"}, ${u.occurrences} time${u.occurrences === 1 ? "" : "s"}`) : ""}
                          {u?.notFound ? <Badge variant="outline" className="ml-2 text-[10px]">Not found anywhere</Badge> : null}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="inline-flex overflow-hidden rounded-md border" role="group" aria-label={`Turn "${k.phrase}" on or off`}>
                          <button type="button" onClick={() => k.status !== "on" && toggle(k)} className={`px-4 py-2 text-sm font-semibold ${k.status === "on" ? "bg-green-600 text-white" : "bg-background text-muted-foreground hover:bg-muted"}`}>ON</button>
                          <button type="button" onClick={() => k.status !== "off" && toggle(k)} className={`px-4 py-2 text-sm font-semibold ${k.status === "off" ? "bg-slate-600 text-white" : "bg-background text-muted-foreground hover:bg-muted"}`}>OFF</button>
                        </div>
                        <Button type="button" variant="ghost" size="sm" onClick={() => remove(k)} aria-label={`Delete "${k.phrase}"`}><Trash2 className="h-4 w-4" /></Button>
                      </div>
                    </div>
                    {u && u.examples.length > 0 && (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-muted-foreground">Show up to {u.examples.length} page{u.examples.length === 1 ? "" : "s"}</summary>
                        <ul className="mt-1 space-y-1">
                          {u.examples.map((e) => (
                            <li key={e.path}>
                              <code>{e.path}</code> <Highlighted s={e.snippet} />
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </CardContent>
    </Card></div>
  )
}
