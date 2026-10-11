"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Loader2, Upload, Link as LinkIcon, ClipboardPaste, FileText, Image as ImageIcon, Wand2, Check, X, AlertTriangle, ImagePlus, Sparkles, Send } from "lucide-react"
import type { DropItem, WizardApi, WizardView } from "@/components/package-wizard-api"
import type { MissingFact } from "@/lib/trip-checklist"

// The add-a-trip wizard (growth loop WP13): ONE AI-first flow for the admin's Add Package button and for the public
// agent page. The person drops what they have, the site reads it, completes the page, picks pictures, and shows one
// review screen. Which server it talks to is decided by the `api` prop (components/package-wizard-api.ts); every
// rule (grounding, caps, logging, Revert) lives on the server in the shared functions.
//   1. Drop what you have   many files, links and pasted text in one go; an optional trip name
//   2. Reading              each source is read in turn (one AI read each), then ONE "complete the trip" pass
//   3. Pictures             supplier photos or an illustrative destination photo are already chosen; add your own
//   4. Review               every field, "Improve with AI", the Still-missing list, and the final action

type Step = "drop" | "reading" | "pictures" | "review"
const STEPS: { key: Step; label: string }[] = [
  { key: "drop", label: "1. Drop what you have" },
  { key: "reading", label: "2. Reading" },
  { key: "pictures", label: "3. Pictures" },
  { key: "review", label: "4. Review" },
]

/** One request to the server is limited to about 4.5 MB, so the files in one drop item share 4 MB. */
const REQUEST_MAX = 4 * 1024 * 1024
const MAX_IMAGES = 5
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"]

interface ReadLine {
  id: string
  label: string
  state: "waiting" | "working" | "done" | "failed"
  filled: string[]
  error?: string
  item: DropItem
  sourceId?: string
}

let counter = 0
const uid = () => `q${Date.now().toString(36)}${(counter++).toString(36)}`

export interface PackageWizardProps {
  api: WizardApi
  /** Open an existing draft (resume) instead of starting a new one. */
  initialDraftId?: string
  /** After the admin's Publish now succeeds. WP15's promotion plan attaches here; a no-op for now. */
  onPublished?: (packageId: string) => void
  /** After the person finishes (saved as draft, published, or sent) or leaves. */
  onDone?: (packageId: string | null) => void
  onCancel?: () => void
  /** Rendered under the first step: the "More ways to add" links. */
  moreWays?: React.ReactNode
}

export function PackageWizard({ api, initialDraftId, onPublished, onDone, onCancel, moreWays }: PackageWizardProps) {
  const agent = api.mode === "agent"
  const [step, setStep] = useState<Step>("drop")
  const [draftId, setDraftId] = useState<string | null>(initialDraftId ?? null)
  const [view, setView] = useState<WizardView | null>(null)
  const [tripName, setTripName] = useState("")
  const [queue, setQueue] = useState<DropItem[]>([])
  const [lines, setLines] = useState<ReadLine[]>([])
  const [urlText, setUrlText] = useState("")
  const [pasteText, setPasteText] = useState("")
  const [hint, setHint] = useState<MissingFact | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState("")
  const [dragging, setDragging] = useState(false)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(!!initialDraftId)
  const fileInput = useRef<HTMLInputElement>(null)
  const photoInput = useRef<HTMLInputElement>(null)

  const reload = useCallback(
    async (id: string) => {
      const v = await api.view(id)
      setView(v)
      return v
    },
    [api],
  )

  // Resuming a draft: land on the review screen when it already has things read, else on the drop step.
  useEffect(() => {
    if (!initialDraftId) return
    let alive = true
    reload(initialDraftId)
      .then((v) => {
        if (!alive) return
        setStep(v.sources.some((s) => s.status === "extracted" || s.status === "applied") ? "review" : "drop")
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Could not open the trip"))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [initialDraftId, reload])

  const locked = view ? !view.editable : false

  // ─── Step 1: the queue ───────────────────────────────────────────────────────────

  function addFiles(list: FileList | File[]) {
    setError("")
    const files = Array.from(list)
    const images = files.filter((f) => IMAGE_TYPES.includes(f.type) || /\.(png|jpe?g|webp)$/i.test(f.name))
    const pdfs = files.filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name))
    const rest = files.length - images.length - pdfs.length
    const next: DropItem[] = []
    const queuedImages = queue.reduce((n, q) => n + (q.kind === "images" ? q.files.length : 0), 0)
    const room = Math.max(0, MAX_IMAGES - queuedImages)
    const usable = images.slice(0, room)
    if (usable.length) {
      if (usable.reduce((n, f) => n + f.size, 0) > REQUEST_MAX) setError("Those pictures are over 4 MB together. Drop fewer or smaller ones, or drop them in two goes.")
      else next.push({ id: uid(), kind: "images", files: usable, label: usable.length === 1 ? usable[0].name : `${usable.length} screenshots (read together)` })
    }
    for (const p of pdfs) {
      if (p.size > REQUEST_MAX) setError(`${p.name} is over 4 MB. Save a smaller copy, or add it from the trip's Add details box.`)
      else next.push({ id: uid(), kind: "pdf", files: [p], label: p.name })
    }
    if (images.length > usable.length) setError(`Only ${MAX_IMAGES} screenshots fit on one trip. The extra ones were left out.`)
    else if (rest > 0) setError("Only PNG, JPG, WebP screenshots and PDF files can be read. The others were left out.")
    if (next.length) setQueue((q) => [...q, ...next])
  }

  function addLink() {
    const url = urlText.trim()
    if (!url) return
    if (!/^https:\/\//i.test(url)) return setError("The link must start with https://")
    setError("")
    setQueue((q) => [...q, { id: uid(), kind: "url", url, label: url }])
    setUrlText("")
  }

  function addText() {
    const text = pasteText.trim()
    if (text.length < 40) return setError("Paste a few more words about the trip.")
    setError("")
    setQueue((q) => [...q, { id: uid(), kind: "text", text, label: `Pasted text (${text.length.toLocaleString("en-CA")} letters)` }])
    setPasteText("")
  }

  // ─── Step 2: reading ─────────────────────────────────────────────────────────────

  async function readAll() {
    if (queue.length === 0) return
    setError("")
    setNotice("")
    setBusy("read")
    setStep("reading")
    const items = queue
    setQueue([])
    setLines(items.map((item) => ({ id: item.id, label: item.label, state: "waiting", filled: [], item })))
    const patch = (id: string, p: Partial<ReadLine>) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...p } : l)))
    try {
      // The draft row is created at once, with the typed name or a placeholder the AI replaces.
      let id = draftId
      if (!id) {
        id = await api.start(tripName.trim())
        setDraftId(id)
      }
      for (const item of items) {
        patch(item.id, { state: "working" })
        try {
          const sourceId = await api.addSource(id, item)
          patch(item.id, { sourceId })
          const r = await api.readSource(id, sourceId)
          patch(item.id, r.error ? { state: "failed", error: r.error } : { state: "done", filled: r.filled })
        } catch (e) {
          patch(item.id, { state: "failed", error: e instanceof Error ? e.message : "Could not add that" })
        }
      }
      const c = await api.complete(id)
      if (c.error) setNotice(c.error)
      else if (c.filled.length) setNotice(`Completed the page: ${c.filled.join(", ")}.`)
      await reload(id)
      setStep("pictures")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong")
      setStep("drop")
    } finally {
      setBusy("")
      setHint(null)
    }
  }

  async function retry(line: ReadLine) {
    if (!draftId || !line.sourceId) return
    setLines((ls) => ls.map((l) => (l.id === line.id ? { ...l, state: "working", error: undefined } : l)))
    const r = await api.readSource(draftId, line.sourceId)
    setLines((ls) => ls.map((l) => (l.id === line.id ? (r.error ? { ...l, state: "failed", error: r.error } : { ...l, state: "done", filled: r.filled }) : l)))
    await reload(draftId)
  }

  // ─── Step 3: pictures ────────────────────────────────────────────────────────────

  async function addPhotos(list: FileList | null) {
    if (!list || !draftId) return
    const files = Array.from(list)
    if (files.reduce((n, f) => n + f.size, 0) > REQUEST_MAX) return setError("Those photos are over 4 MB together. Add fewer or smaller ones at a time.")
    setError("")
    setBusy("photos")
    const r = await api.addPhotos(draftId, files).catch((e) => ({ added: 0, skipped: [] as string[], error: e instanceof Error ? e.message : "Could not add the photos" }))
    setBusy("")
    if (r.error) setError(r.error)
    else setNotice(`Added ${r.added} photo${r.added === 1 ? "" : "s"}.${r.skipped.length ? ` Left out: ${r.skipped.join("; ")}.` : ""}`)
    await reload(draftId)
  }

  // ─── Step 4: review ──────────────────────────────────────────────────────────────

  async function saveEdits(): Promise<boolean> {
    if (!draftId || Object.keys(edits).length === 0) return true
    try {
      await api.save(draftId, edits)
      setEdits({})
      await reload(draftId)
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save")
      return false
    }
  }

  async function improve(field: string) {
    if (!draftId) return
    setError("")
    setNotice("")
    setBusy(`improve:${field}`)
    if (!(await saveEdits())) return setBusy("")
    const r = await api.improve(draftId, field).catch((e) => ({ applied: false, error: e instanceof Error ? e.message : "Could not rewrite it" }))
    setBusy("")
    if (r.error) setError(r.error)
    else setNotice(r.applied ? "Rewritten from what you dropped. Every rewrite can be put back from the trip's Add details box." : "Nothing changed.")
    await reload(draftId)
  }

  async function finish(action: "publish" | "draft" | "send") {
    if (!draftId) return
    setError("")
    setNotice("")
    setBusy(`finish:${action}`)
    if (!(await saveEdits())) return setBusy("")
    const r = await api.finish(draftId, action).catch((e) => ({ error: e instanceof Error ? e.message : "Something went wrong", missing: undefined as string[] | undefined }))
    setBusy("")
    if (r.error) return setError(r.error)
    if (action === "publish") onPublished?.(draftId)
    if (action === "send") {
      setNotice("Sent. Joel will review it.")
      await reload(draftId)
      return
    }
    onDone?.(draftId)
  }

  function nudge(m: MissingFact) {
    setHint(m)
    setStep("drop")
    setNotice("")
  }

  if (loading) return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Opening the trip...</div>

  const stepIndex = STEPS.findIndex((s) => s.key === step)
  const working = busy !== ""

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <div className="flex flex-wrap gap-2" aria-label="Steps">
        {STEPS.map((s, i) => (
          <span key={s.key} className={`rounded-full px-3 py-1 text-xs font-medium ${i === stepIndex ? "bg-primary text-primary-foreground" : i < stepIndex ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" : "bg-muted text-muted-foreground"}`}>{s.label}</span>
        ))}
      </div>

      {error && <p role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}</p>}
      {notice && <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">{notice}</p>}
      {view?.reviewNote && view.state === "rejected" && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <p className="font-medium">Joel sent this back with a note</p>
          <p className="mt-1 whitespace-pre-wrap">{view.reviewNote}</p>
          <p className="mt-1 text-xs">Make the changes, then send it again.</p>
        </div>
      )}

      {/* 1. Drop */}
      {step === "drop" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Upload className="h-5 w-5" />Drop what you have</CardTitle>
            <CardDescription>
              Screenshots, PDFs, supplier links, a pasted email. Drop it all in one go. The site reads it, writes the page, and lists what it could not find.
              {hint && <span className="mt-2 block rounded bg-amber-50 p-2 text-amber-900 dark:bg-amber-950 dark:text-amber-100">{hint.hint}</span>}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {locked ? (
              <p className="text-sm text-muted-foreground">{view?.stateLabel ?? "This trip is locked."} It cannot be changed now.</p>
            ) : (
              <>
                {!draftId && (
                  <div className="space-y-1">
                    <label className="text-sm font-medium" htmlFor="wiz-name">Trip name <span className="font-normal text-muted-foreground">(optional, the AI proposes one)</span></label>
                    <Input id="wiz-name" value={tripName} onChange={(e) => setTripName(e.target.value)} placeholder="e.g. Greek Isles Cruise for Singles" maxLength={120} disabled={working} />
                  </div>
                )}
                <div
                  onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => { e.preventDefault(); setDragging(false); if (!working) addFiles(e.dataTransfer.files) }}
                  onClick={() => !working && fileInput.current?.click()}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") fileInput.current?.click() }}
                  className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed p-8 text-center text-sm transition-colors ${dragging ? "border-primary bg-primary/5" : "border-muted-foreground/30 hover:border-primary/60"}`}
                >
                  <Upload className="h-7 w-7 text-muted-foreground" />
                  <p className="font-medium">Drop screenshots and PDFs here, or click to choose</p>
                  <p className="text-xs text-muted-foreground">PNG, JPG, WebP or PDF. Screenshots dropped together are read together as one (up to {MAX_IMAGES}). Tall scrolling screenshots are fine.</p>
                  <input ref={fileInput} type="file" multiple accept="image/png,image/jpeg,image/webp,application/pdf" className="hidden" onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = "" }} />
                </div>
                <p className="text-xs text-muted-foreground">Facebook posts and events cannot be read from a link. Take a scrolling screenshot (SnagIt, or Windows Snip with scroll) and drop it here.</p>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <p className="flex items-center gap-1.5 text-sm font-medium"><LinkIcon className="h-4 w-4" />A supplier link</p>
                    <div className="flex gap-2">
                      <Input value={urlText} onChange={(e) => setUrlText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLink() } }} placeholder="https://supplier.example.com/trip" inputMode="url" disabled={working} />
                      <Button type="button" variant="outline" onClick={addLink} disabled={working || !urlText.trim()}>Add</Button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <p className="flex items-center gap-1.5 text-sm font-medium"><ClipboardPaste className="h-4 w-4" />Or paste text</p>
                    <Textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={3} placeholder="Paste a supplier email, a flyer, or the words of a post" disabled={working} />
                    <Button type="button" variant="outline" onClick={addText} disabled={working || pasteText.trim().length < 40}>Add the text</Button>
                  </div>
                </div>

                {queue.length > 0 && (
                  <ul className="space-y-1" aria-label="Ready to read">
                    {queue.map((q) => (
                      <li key={q.id} className="flex items-center gap-2 rounded-md border p-2 text-sm">
                        {q.kind === "pdf" ? <FileText className="h-4 w-4" /> : q.kind === "images" ? <ImageIcon className="h-4 w-4" /> : q.kind === "url" ? <LinkIcon className="h-4 w-4" /> : <ClipboardPaste className="h-4 w-4" />}
                        <span className="min-w-0 flex-1 truncate">{q.label}</span>
                        <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label={`Remove ${q.label}`} onClick={() => setQueue((qs) => qs.filter((x) => x.id !== q.id))}><X className="h-4 w-4" /></Button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" onClick={readAll} disabled={working || queue.length === 0}><Sparkles className="mr-1 h-4 w-4" />Read it and build the page</Button>
                  {draftId && <Button type="button" variant="ghost" onClick={() => setStep("review")}>Skip to review</Button>}
                  {onCancel && !draftId && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
                  <span className="text-xs text-muted-foreground">Each thing you add is one AI read, a few cents.</span>
                </div>
                {moreWays && <div className="border-t pt-3 text-sm">{moreWays}</div>}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* 2. Reading */}
      {step === "reading" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">{busy === "read" ? <Loader2 className="h-5 w-5 animate-spin" /> : <Check className="h-5 w-5" />}Reading</CardTitle>
            <CardDescription>Each thing is read in turn, then one pass completes the page. This can take a minute or two.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {lines.map((l) => (
              <div key={l.id} className="rounded-md border p-3 text-sm">
                <div className="flex items-center gap-2">
                  {l.state === "working" ? <Loader2 className="h-4 w-4 animate-spin" /> : l.state === "done" ? <Check className="h-4 w-4 text-emerald-600" /> : l.state === "failed" ? <AlertTriangle className="h-4 w-4 text-destructive" /> : <span className="h-4 w-4 rounded-full border" />}
                  <span className="min-w-0 flex-1 truncate font-medium">{l.label}</span>
                  <Badge variant={l.state === "failed" ? "destructive" : "secondary"}>{l.state === "waiting" ? "Waiting" : l.state === "working" ? "Reading" : l.state === "done" ? "Read" : "Could not read"}</Badge>
                </div>
                {l.state === "done" && <p className="mt-1 text-xs text-muted-foreground">{l.filled.length ? `Filled in: ${l.filled.join(", ")}` : "Nothing new to fill in."}</p>}
                {l.state === "failed" && (
                  <p className="mt-1 text-xs text-destructive">
                    {l.error} {l.sourceId && busy === "" && <button type="button" className="underline" onClick={() => retry(l)}>Try again</button>}
                  </p>
                )}
              </div>
            ))}
            {busy === "read" && lines.every((l) => l.state === "done" || l.state === "failed") && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Completing the trip page...</p>}
          </CardContent>
        </Card>
      )}

      {/* 3. Pictures */}
      {step === "pictures" && view && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><ImagePlus className="h-5 w-5" />Pictures</CardTitle>
            <CardDescription>
              {view.hasCover
                ? view.coverIllustrative
                  ? "The cover is a stock photo of the destination. It is only an illustration of the place, not of this trip. Add your own photos to replace it as the main picture later."
                  : "A cover photo is in place. The square, portrait and banner shapes were made from it automatically."
                : "There is no cover photo yet. Photos from a supplier link are picked automatically, and a destination photo is used once the destination is known. You can add your own below."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {view.coverUrl && <img src={view.coverUrl} alt={`Cover for ${view.name}`} className="max-h-48 rounded-md border object-cover" />}
            <p className="text-sm text-muted-foreground">{view.galleryCount ? `The gallery has ${view.galleryCount} photo${view.galleryCount === 1 ? "" : "s"}.` : "The gallery is empty."} Photos you add here must be yours to use.</p>
            {!locked && (
              <>
                <Button type="button" variant="outline" disabled={working} onClick={() => photoInput.current?.click()}>{busy === "photos" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <ImagePlus className="mr-1 h-4 w-4" />}Add my own photos</Button>
                <input ref={photoInput} type="file" multiple accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { addPhotos(e.target.files); e.target.value = "" }} />
              </>
            )}
            <div className="flex gap-2">
              <Button type="button" onClick={() => setStep("review")} disabled={working}>Continue to review</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 4. Review */}
      {step === "review" && view && (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Review: {view.name}</CardTitle>
              <div className="flex items-center gap-2">
                {view.score != null && <Badge variant="secondary">Page {view.score}/100</Badge>}
                {view.stateLabel && <Badge>{view.stateLabel}</Badge>}
              </div>
            </div>
            <CardDescription>
              {locked ? "Joel is reviewing this trip. You can read it here but not change it." : "Check each part. Change anything by typing. \"Improve with AI\" rewrites a part using only what you dropped."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-4">
              {view.fields.map((f) => {
                const value = edits[f.key] ?? f.value
                const id = `wiz-${f.key}`
                return (
                  <div key={f.key} className="space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label htmlFor={id} className="text-sm font-medium">{f.label}</label>
                      {f.improvable && !locked && (
                        <Button type="button" size="sm" variant="ghost" disabled={working} onClick={() => improve(f.key)}>
                          {busy === `improve:${f.key}` ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Wand2 className="mr-1 h-3.5 w-3.5" />}Improve with AI
                        </Button>
                      )}
                    </div>
                    {f.hidden ? (
                      <p className="text-sm text-muted-foreground">{f.filled ? "Found. Joel will check it." : "Not found yet."}</p>
                    ) : f.editable ? (
                      f.multiline ? (
                        <Textarea id={id} value={value} rows={f.key === "full_description" ? 8 : 3} onChange={(e) => setEdits((x) => ({ ...x, [f.key]: e.target.value }))} disabled={working} />
                      ) : (
                        <Input id={id} value={value} onChange={(e) => setEdits((x) => ({ ...x, [f.key]: e.target.value }))} disabled={working} />
                      )
                    ) : (
                      <p id={id} className="whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-sm">{f.value || <span className="text-muted-foreground">(empty)</span>}</p>
                    )}
                  </div>
                )
              })}
            </div>

            {view.missing.length > 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:bg-amber-950">
                <p className="mb-2 text-sm font-medium text-amber-900 dark:text-amber-100">Still missing (the site never guesses these)</p>
                <ul className="space-y-1">
                  {view.missing.map((m) => (
                    <li key={m.key} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span>{m.label}</span>
                      {!locked && <Button type="button" size="sm" variant="outline" disabled={working} onClick={() => nudge(m)}>{m.nudge}</Button>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {view.sources.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer font-medium">What was added ({view.sources.length})</summary>
                <ul className="mt-2 space-y-1">
                  {view.sources.map((s) => (
                    <li key={s.id} className="rounded border p-2">
                      <span className="font-medium">{s.label}</span> <span className="text-muted-foreground">({s.failed ? "could not be read" : s.status === "uploaded" ? "not read yet" : "read"}{s.filled.length ? `, filled: ${s.filled.join(", ")}` : ""})</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t pt-4">
              {!locked && <Button type="button" variant="outline" onClick={() => { setHint(null); setStep("drop") }} disabled={working}>Add more</Button>}
              {!locked && <Button type="button" variant="outline" onClick={() => setStep("pictures")} disabled={working}>Pictures</Button>}
              {!locked && Object.keys(edits).length > 0 && <Button type="button" variant="secondary" onClick={() => saveEdits()} disabled={working}>Save changes</Button>}
              <span className="flex-1" />
              {!agent && !locked && (
                <>
                  <Button type="button" variant="outline" onClick={() => finish("draft")} disabled={working}>{busy === "finish:draft" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}Save as draft</Button>
                  <Button type="button" onClick={() => { if (confirm("Publish this trip page now? It goes live on the site.")) finish("publish") }} disabled={working}>{busy === "finish:publish" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}Publish now</Button>
                </>
              )}
              {agent && !locked && (
                <Button type="button" onClick={() => { if (confirm("Send this trip to Joel for review? You will not be able to change it unless he sends it back.")) finish("send") }} disabled={working || view.canSend === false}>
                  {busy === "finish:send" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Send className="mr-1 h-4 w-4" />}Send to Joel for review
                </Button>
              )}
              {agent && locked && onDone && <Button type="button" variant="outline" onClick={() => onDone(draftId)}>Back to my trips</Button>}
            </div>
            {agent && !locked && view.canSend === false && <p className="text-xs text-muted-foreground">Add at least one thing and let it be read before you send.</p>}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
